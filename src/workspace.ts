/**
 * The set of directories the agent may touch: the project it was started in
 * plus any extra roots — the sibling repos a big codebase depends on.
 *
 *   gemini-code --add-dir ../shared-lib --add-dir ~/src/platform
 *   GEMINI_CODE_ADD_DIRS=../shared-lib:../platform      (PATH-style separator)
 *   .gemini-code.json: { "addDirs": ["../shared-lib"] }  (committed per project)
 *   /add-dir ../shared-lib                                (mid-session)
 *
 * This is the same idea as Claude Code's --add-dir and OpenCode's multiple
 * workspace folders: every file tool checks paths against ALL roots, and a
 * path is shown back to the model relative to the primary root (so a file
 * in a sibling repo reads as ../shared-lib/src/x.ts), which is also exactly
 * what the model should type to reach it.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface WorkspaceRoot {
  /** Absolute path. */
  dir: string;
  /** Short name — the directory's basename, de-duplicated. */
  name: string;
  primary: boolean;
}

const roots: WorkspaceRoot[] = [{ dir: path.resolve(process.cwd()), name: path.basename(process.cwd()), primary: true }];

export function primaryRoot(): string {
  return roots[0].dir;
}

export function workspaceRoots(): readonly WorkspaceRoot[] {
  return roots;
}

export function extraRoots(): readonly WorkspaceRoot[] {
  return roots.filter((r) => !r.primary);
}

/** Adds a root. Returns the root, or an error message when it can't be used. */
export function addRoot(dir: string): { ok: true; root: WorkspaceRoot; added: boolean } | { ok: false; error: string } {
  const expanded = dir.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? "~");
  const abs = path.resolve(primaryRoot(), expanded);
  if (!existsSync(abs)) return { ok: false, error: `${abs} does not exist` };
  if (!statSync(abs).isDirectory()) return { ok: false, error: `${abs} is not a directory` };
  const existing = roots.find((r) => r.dir === abs || isInside(abs, r.dir));
  if (existing) return { ok: true, root: existing, added: false };
  let name = path.basename(abs);
  let n = 2;
  while (roots.some((r) => r.name === name)) name = `${path.basename(abs)}-${n++}`;
  const root = { dir: abs, name, primary: false };
  roots.push(root);
  return { ok: true, root, added: true };
}

/** Is `abs` the directory `root` or inside it (by path segments, not string prefix)? */
export function isInside(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** The root containing an absolute path, if any. Deeper roots win. */
export function rootOf(abs: string): WorkspaceRoot | undefined {
  return [...roots].sort((a, b) => b.dir.length - a.dir.length).find((r) => isInside(abs, r.dir));
}

/**
 * Resolves a model-supplied path against the workspace. Relative paths are
 * taken from the primary root, so `../lib/src/a.ts` reaches a sibling root
 * naturally; absolute paths are accepted when they fall inside a root.
 */
export function resolveInWorkspace(rel: string): { ok: true; abs: string; root: WorkspaceRoot } | { ok: false; abs?: undefined } {
  const abs = path.resolve(primaryRoot(), rel);
  const root = rootOf(abs);
  return root ? { ok: true, abs, root } : { ok: false };
}

/** How a path is shown to the model: relative to the primary root. */
export function displayPath(abs: string): string {
  const rel = path.relative(primaryRoot(), abs);
  return (rel || ".").split(path.sep).join("/");
}

/** One line for errors: where the model IS allowed to go. */
export function describeRoots(): string {
  return roots.map((r) => (r.primary ? `${r.dir} (project)` : `${displayPath(r.dir)} = ${r.dir}`)).join(", ");
}

/** Reads extra roots from flags, environment and config (the latter two are merged by config.ts into env). */
export function rootsFromArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--add-dir" && argv[i + 1]) out.push(argv[++i]);
    else if (argv[i].startsWith("--add-dir=")) out.push(argv[i].slice("--add-dir=".length));
  }
  for (const d of (env.GEMINI_CODE_ADD_DIRS ?? "").split(path.delimiter)) if (d.trim()) out.push(d.trim());
  return out;
}
