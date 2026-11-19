import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bundledFiles, findSkillFolders, parseFrontmatter, personalSkillsDir, skillName } from "./skills.js";

const run = promisify(execFile);

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const SOURCE_FILE = ".skill-source.json";
const SCRIPT_EXT = /\.(py|sh|bash|js|mjs|ts|ps1|bat|cmd|rb|pl)$/i;

/**
 * Installing a skill from GitHub.
 *
 * Only ever reached from something the user did: the `skills` command or the
 * app's Skills page. There is deliberately no tool for it. A skill is
 * instructions the agent will follow, so if Gemini could install one, a web
 * page it read could talk it into adding its own.
 */
export interface SkillSource {
  owner: string;
  repo: string;
  ref?: string;
  /** A folder inside the repo, to look only there. */
  subpath?: string;
}

/** Takes owner/repo, owner/repo/path, owner/repo@ref or any github.com URL of those. */
export function parseSkillSource(input: string): SkillSource {
  const fail = () => new Error(`"${input}" isn't a GitHub repository. Try owner/repo, or paste its URL.`);
  let text = input.trim().replace(/^git@github\.com:/, "");
  const url = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(text);
  if (/^https?:/i.test(text) && !url) throw fail();
  if (url) text = url[1];
  text = text.replace(/[?#].*$/, "").replace(/\/+$/, "");

  let inlineRef: string | undefined;
  const at = /^([^@]+)@([\w./-]+)$/.exec(text);
  if (at) [, text, inlineRef] = at;

  const [owner, rawRepo, ...rest] = text.split("/");
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw fail();

  let ref = inlineRef;
  let parts = rest;
  if (parts[0] === "tree" || parts[0] === "blob") {
    ref = parts[1];
    parts = parts.slice(2);
  }
  if (parts.at(-1)?.toLowerCase() === "skill.md") parts = parts.slice(0, -1);
  if (parts.some((part) => part === "..")) throw fail();

  return { owner, repo, ...(ref ? { ref } : {}), ...(parts.length ? { subpath: parts.join("/") } : {}) };
}

/** Git for Windows' tar reads "C:\..." as a remote host, so prefer Windows' own. */
function tarCommand(): string {
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return process.platform === "win32" && existsSync(system) ? system : "tar";
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (response.status === 404) throw new Error("Not found. Check the name, and that the repository is public.");
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("That repository is too large to install skills from.");
  await writeFile(file, data);
}

export interface SkillDeps {
  /** Where installed skills go: ~/.gemini-code by default. */
  home?: string;
  download?: (url: string, file: string) => Promise<void>;
}

export interface FoundSkill {
  name: string;
  description: string;
  /** Inside the repo. */
  path: string;
  files: string[];
  /** Bundled programs, which the agent may run. Worth seeing before installing. */
  scripts: string[];
}

/** Downloads a repo to a temp folder for `work`, which is always removed afterwards. */
async function withRepo<T>(input: string, deps: SkillDeps, work: (root: string, source: SkillSource) => Promise<T>): Promise<T> {
  const source = parseSkillSource(input);
  const temp = await mkdtemp(path.join(tmpdir(), "gemini-code-skill-"));
  try {
    const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref ?? "HEAD"}`;
    const archive = path.join(temp, "repo.tar.gz");
    await (deps.download ?? download)(url, archive);

    const root = path.join(temp, "repo");
    await mkdir(root);
    await run(tarCommand(), ["-xzf", archive, "-C", root, "--strip-components=1"], { windowsHide: true });
    return await work(root, source);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function scan(root: string, source: SkillSource): Promise<(FoundSkill & { dir: string })[]> {
  const start = path.resolve(root, source.subpath ?? ".");
  if (path.relative(root, start).startsWith("..")) throw new Error("That path leaves the repository.");
  if (!(await stat(start).catch(() => undefined))?.isDirectory()) {
    throw new Error(`There's no folder "${source.subpath}" in ${source.owner}/${source.repo}.`);
  }

  const found: (FoundSkill & { dir: string })[] = [];
  for (const folder of await findSkillFolders(start)) {
    const content = await readFile(folder.file, "utf8");
    // A skill at the repo's own root has no folder name of its own to go by.
    const fallback = folder.dir === root ? source.repo : path.basename(folder.dir);
    const files = await bundledFiles(folder.dir);
    found.push({
      name: skillName(fallback, content),
      description: parseFrontmatter(content).description ?? "",
      path: path.relative(root, folder.dir).split(path.sep).join("/") || ".",
      files,
      scripts: files.filter((file) => SCRIPT_EXT.test(file)),
      dir: folder.dir,
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function publicView({ name, description, path: where, files, scripts }: FoundSkill): FoundSkill {
  return { name, description, path: where, files, scripts };
}

/** What a repository offers, without installing anything. */
export function discoverSkills(input: string, deps: SkillDeps = {}): Promise<FoundSkill[]> {
  return withRepo(input, deps, async (root, source) => (await scan(root, source)).map(publicView));
}

/** A skill's name becomes a folder, and it came from a stranger's repository. */
function safeFolderName(name: string): string {
  const safe = name.replace(/[^\w.-]/g, "-").replace(/^\.+/, "");
  if (!safe) throw new Error(`"${name}" can't be used as a skill's name.`);
  return safe;
}

/**
 * Installs the named skills, or the only one the repo has. Links aren't copied,
 * so a skill can't reach outside its own folder through one.
 */
export function installSkills(input: string, names: string[] = [], deps: SkillDeps = {}): Promise<FoundSkill[]> {
  return withRepo(input, deps, async (root, source) => {
    const found = await scan(root, source);
    if (!found.length) throw new Error(`No skills found in ${source.owner}/${source.repo}. A skill is a folder with a SKILL.md.`);

    const chosen = names.length ? found.filter((skill) => names.includes(skill.name)) : found;
    const missing = names.filter((name) => !found.some((skill) => skill.name === name));
    if (missing.length) throw new Error(`Not in that repository: ${missing.join(", ")}.`);
    if (!names.length && found.length > 1) {
      throw new Error(`That repository has ${found.length} skills, so choose which: ${found.map((s) => s.name).join(", ")}.`);
    }

    const target = personalSkillsDir(deps.home);
    for (const skill of chosen) {
      const dest = path.join(target, safeFolderName(skill.name));
      await rm(dest, { recursive: true, force: true });
      await mkdir(dest, { recursive: true });
      await cp(skill.dir, dest, {
        recursive: true,
        filter: async (from) => !(await lstat(from)).isSymbolicLink() && path.basename(from) !== ".git",
      });
      const origin = { source: input.trim(), path: skill.path, installed: new Date().toISOString() };
      await writeFile(path.join(dest, SOURCE_FILE), JSON.stringify(origin, null, 2), "utf8");
    }
    return chosen.map(publicView);
  });
}

export interface InstalledSkill {
  name: string;
  description: string;
  source?: string;
}

/** What `skills add` put here, which is all `skills remove` will touch. */
export async function listInstalled(home?: string): Promise<InstalledSkill[]> {
  const target = personalSkillsDir(home);
  const installed: InstalledSkill[] = [];
  for (const entry of await readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const folder = (await findSkillFolders(path.join(target, entry.name), 0))[0];
    if (!folder) continue;
    const content = await readFile(folder.file, "utf8");
    const origin = await readFile(path.join(folder.dir, SOURCE_FILE), "utf8").then(JSON.parse, () => undefined);
    installed.push({
      name: skillName(entry.name, content),
      description: parseFrontmatter(content).description ?? "",
      source: origin?.source,
    });
  }
  return installed.sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeSkill(name: string, home?: string): Promise<void> {
  const target = personalSkillsDir(home);
  for (const entry of await readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const folder = (await findSkillFolders(path.join(target, entry.name), 0))[0];
    if (!folder) continue;
    if (skillName(entry.name, await readFile(folder.file, "utf8")) === name) {
      await rm(path.join(target, entry.name), { recursive: true, force: true });
      return;
    }
  }
  throw new Error(`"${name}" isn't installed.`);
}
