import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MEMORY_FILENAME } from "./memory.js";
import { PLAN_FILENAME } from "./plan.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".gemini-code-profile",
  ".gemini-code-tmp",
  ".tmp-test",
]);

export interface ProjectDoc {
  /** Path relative to the project root. */
  path: string;
  content: string;
  /** True for AGENTS.md / CLAUDE.md and friends: rules to follow, not just background. */
  instructions?: boolean;
}

/**
 * For an extra workspace root (a dependency repo) only its top-level README
 * and instruction files are worth sending up front; the model reads deeper
 * on demand.
 */
export async function collectRootSummaryDocs(root: string, displayPrefix: string): Promise<ProjectDoc[]> {
  const out: ProjectDoc[] = [];
  for (const name of [...INSTRUCTION_FILES, "README.md", "readme.md", "README.rst"]) {
    const full = path.join(root, name);
    try {
      if (!(await stat(full)).isFile()) continue;
      let content = await readFile(full, "utf8");
      if (content.length > 6_000) content = content.slice(0, 6_000) + "\n\n[truncated — read_file for the rest]";
      out.push({ path: `${displayPrefix}/${name}`, content, instructions: INSTRUCTION_FILES.includes(name) });
    } catch {
      // absent
    }
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * Files that are INSTRUCTIONS to a coding agent rather than documentation:
 * what Codex and OpenCode read as AGENTS.md, Claude Code as CLAUDE.md, Cursor
 * as .cursorrules. They go first and are never cut by the budget.
 */
export const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
];

export interface DocsOptions {
  root?: string;
  /** Total character budget across all docs. */
  maxTotalChars?: number;
  /** Per-file cap, so one huge doc can't eat the whole budget. */
  maxFileChars?: number;
  maxDepth?: number;
}

/**
 * Collects the project's markdown as initial knowledge — READMEs, docs/,
 * architecture notes, and so on. These usually say more about intent and
 * conventions than the source does, and handing them over up front saves
 * Gemini from discovering the same things through tool calls.
 *
 * GEMINI.md is excluded here because it's carried separately as durable
 * agent memory (see memory.ts) and would otherwise appear twice.
 */
export async function collectProjectDocs(opts: DocsOptions = {}): Promise<ProjectDoc[]> {
  const root = opts.root ?? process.cwd();
  const maxTotalChars = opts.maxTotalChars ?? 40_000;
  const maxFileChars = opts.maxFileChars ?? 12_000;
  // Shallow on purpose: in a large repository docs/ alone can hold hundreds
  // of files, and the model can read_file any of them when it matters.
  const maxDepth = opts.maxDepth ?? 3;
  const maxFiles = 6;

  const found: string[] = [];
  const instructions: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    const full = path.join(root, name);
    try {
      if ((await stat(full)).isFile()) instructions.push(full);
    } catch {
      // absent
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (
        /\.mdx?$/i.test(entry.name) &&
        entry.name !== MEMORY_FILENAME &&
        entry.name !== PLAN_FILENAME
      )
        found.push(full);
    }
  }

  await walk(root, 1);

  // Docs that explain how the repo works first (README, ARCHITECTURE,
  // DEVELOPMENT…), then shallower before deeper, then alphabetical. A big
  // repo's docs/ holds blog posts and release notes the model doesn't need.
  const weight = (f: string) => {
    const name = path.basename(f).toLowerCase();
    if (/^readme/.test(name)) return 0;
    if (/architecture|design|overview|development|developing|setup|getting[-_]?started|hacking|structure/.test(name)) return 1;
    if (/changelog|release|blog|news|history|acknowledg|license|code_of_conduct|security/.test(name)) return 9;
    return 3;
  };
  found.sort((a, b) => {
    const w = weight(a) - weight(b);
    if (w !== 0) return w;
    const depthDiff = a.split(path.sep).length - b.split(path.sep).length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });

  const docs: ProjectDoc[] = [];
  let budget = maxTotalChars;
  for (const file of instructions) {
    try {
      let content = await readFile(file, "utf8");
      if (content.length > maxFileChars * 2) content = content.slice(0, maxFileChars * 2) + `\n\n[truncated]`;
      docs.push({ path: path.relative(root, file), content, instructions: true });
      budget -= content.length;
    } catch {
      // unreadable
    }
  }
  for (const file of found.filter((f) => !instructions.includes(f)).slice(0, maxFiles)) {
    if (budget <= 0) break;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      let content = await readFile(file, "utf8");
      if (content.length > maxFileChars) {
        content = content.slice(0, maxFileChars) + `\n\n[truncated at ${maxFileChars} characters]`;
      }
      if (content.length > budget) {
        content = content.slice(0, budget) + "\n\n[truncated — context budget reached]";
      }
      budget -= content.length;
      docs.push({ path: path.relative(root, file), content });
    } catch {
      // Unreadable file — skip rather than fail the whole collection.
    }
  }
  return docs;
}
