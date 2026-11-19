import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

const MAX_SKILL_CHARS = 20_000;
const MAX_LISTED_FILES = 100;
const MAX_SEARCH_DEPTH = 4;
const SKIPPED_DIRS = new Set([".git", "node_modules", "__pycache__"]);

/** Skills are written for Claude Code, so they name its tools rather than ours. */
const CLAUDE_TOOL_NAMES =
  `Skills are written for Claude Code, so where this one names a tool use ours: Read=read_file, Write=write_file, ` +
  `Edit=edit_file, MultiEdit=multi_edit, Bash=run_bash, Grep=search_code, Glob=find_files, WebFetch=fetch_url, ` +
  `WebSearch=web_search, TodoWrite=update_plan, Task=delegate_tasks, AskUserQuestion=ask_user, ` +
  `NotebookEdit=notebook_edit, Skill=use_skill.`;

export interface Skill {
  name: string;
  description: string;
  /** Holds SKILL.md and whatever it bundles. Undefined for a lone <name>.md. */
  dir?: string;
  file: string;
  content: string;
  source: "project" | "personal" | "claude";
}

export function personalSkillsDir(home = path.join(homedir(), ".gemini-code")): string {
  return path.join(home, "skills");
}

/** Project folders first, so a project can override a personal skill of the same name. */
function skillDirs(root: string, home: string, claudeHome: string): { dir: string; source: Skill["source"] }[] {
  const dirs: { dir: string; source: Skill["source"] }[] = [
    { dir: path.join(root, ".gemini-code", "skills"), source: "project" },
    { dir: path.join(root, ".claude", "skills"), source: "project" },
    { dir: personalSkillsDir(home), source: "personal" },
  ];
  if (process.env.GEMINI_CODE_CLAUDE_SKILLS !== "0") dirs.push({ dir: path.join(claudeHome, "skills"), source: "claude" });
  return dirs;
}

/**
 * The `key: value` pairs of a skill's frontmatter. Deliberately not a YAML
 * parser, which would be a dependency for two fields, but skills do fold long
 * descriptions onto further lines, with or without `>` or `|`.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const fields: Record<string, string> = {};
  let key = "";
  for (const line of block.split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      fields[key] = field[2].trim().replace(/^[>|][+-]?$/, "");
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].replace(/^(["'])(.*)\1$/, "$2");
  return fields;
}

export function skillName(folderName: string, content: string): string {
  return parseFrontmatter(content).name || folderName;
}

/** Every folder under `dir` holding a SKILL.md, not looking inside those folders. */
export async function findSkillFolders(dir: string, depth = MAX_SEARCH_DEPTH): Promise<{ dir: string; file: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const marker = entries.find((e) => e.isFile() && e.name.toLowerCase() === "skill.md");
  if (marker) return [{ dir, file: path.join(dir, marker.name) }];
  if (depth === 0) return [];

  const found: { dir: string; file: string }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
      found.push(...(await findSkillFolders(path.join(dir, entry.name), depth - 1)));
    }
  }
  return found;
}

export async function findSkills(
  root = process.cwd(),
  home = path.join(homedir(), ".gemini-code"),
  claudeHome = path.join(homedir(), ".claude")
): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const add = (skill: Skill) => {
    if (!skills.has(skill.name)) skills.set(skill.name, skill);
  };

  for (const { dir, source } of skillDirs(root, home, claudeHome)) {
    for (const folder of await findSkillFolders(dir)) {
      const content = await readFile(folder.file, "utf8").catch(() => undefined);
      if (content === undefined) continue;
      const name = skillName(path.basename(folder.dir), content);
      add({ name, description: parseFrontmatter(content).description ?? "", ...folder, content, source });
    }
    // A lone markdown file beside the folders is a skill too.
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.toLowerCase() === "skill.md") continue;
      const file = path.join(dir, entry.name);
      const content = await readFile(file, "utf8").catch(() => undefined);
      if (content === undefined) continue;
      add({ name: skillName(entry.name.slice(0, -3), content), description: parseFrontmatter(content).description ?? "", file, content, source });
    }
  }
  return skills;
}

/** The files a skill carries, relative to its folder, without following links out. */
export async function bundledFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= MAX_LISTED_FILES) return;
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() !== "skill.md") {
        files.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(dir);
  return files;
}

function body(content: string): string {
  return content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** What Gemini gets for a skill: its instructions, with what it needs to follow them. */
export async function renderSkill(skill: Skill, args = ""): Promise<string> {
  // Forward slashes work in every shell these commands reach, and backslashes don't.
  const dir = skill.dir?.split(path.sep).join("/");
  let text = body(skill.content);
  if (dir) text = text.replace(/\$\{CLAUDE_SKILL_DIR\}|\{baseDir\}/g, dir);
  const hadArguments = /\$ARGUMENTS\b/.test(text);
  text = text.replace(/\$ARGUMENTS\b/g, args);

  const notes = [`Skill "${skill.name}". Follow these instructions.`, CLAUDE_TOOL_NAMES];
  if (dir) {
    const files = await bundledFiles(skill.dir!);
    notes.push(`Its folder is ${dir}. Paths in it are relative to that, so use the full path with run_bash.`);
    if (files.length) {
      notes.push(`It bundles: ${files.join(", ")}. Read any of them with use_skill {"name": "${skill.name}", "file": "<path>"}.`);
    }
  }
  if (args && !hadArguments) notes.push(`Arguments given: ${args}`);

  const cut = text.length > MAX_SKILL_CHARS;
  return `${notes.join("\n")}\n\n---\n\n${text.slice(0, MAX_SKILL_CHARS)}${cut ? "\n[skill cut short]" : ""}`;
}

/** read_file stops at the project root, and a personal skill lives outside it. */
async function readBundled(skill: Skill, rel: string): Promise<string | undefined> {
  if (!skill.dir) return undefined;
  const abs = path.resolve(skill.dir, rel);
  const inside = path.relative(skill.dir, abs);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  const info = await lstat(abs).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  return readFile(abs, "utf8").catch(() => undefined);
}

export interface SkillSummary {
  name: string;
  description: string;
}

/** Names and descriptions for the context, so Gemini knows when one applies. */
export async function skillSummaries(root?: string): Promise<SkillSummary[]> {
  return [...(await findSkills(root)).values()].map(({ name, description }) => ({ name, description }));
}

export const useSkillTool: ToolDefinition = {
  name: "use_skill",
  description:
    `use_skill(args: {name?: string, args?: string, file?: string}) -> loads a skill: instructions for a kind of ` +
    `task, plus any scripts and references it bundles. Use one when its description fits the task, and follow it. ` +
    `No name lists them; 'args' passes it input; 'file' reads one of its bundled files.`,
  async run(args) {
    const skills = await findSkills();
    const name = String(args.name ?? "").trim();
    if (!name) {
      if (!skills.size) return { ok: true, output: "No skills are installed." };
      const list = [...skills.values()].map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`);
      return { ok: true, output: list.join("\n") };
    }
    const skill = skills.get(name);
    if (!skill) {
      return { ok: false, output: `No skill "${name}". Available: ${[...skills.keys()].join(", ") || "(none)"}` };
    }
    if (args.file) {
      const content = await readBundled(skill, String(args.file));
      if (content === undefined) return { ok: false, output: `"${args.file}" isn't a file in the skill "${name}".` };
      return { ok: true, output: content };
    }
    return { ok: true, output: await renderSkill(skill, String(args.args ?? "")) };
  },
};
