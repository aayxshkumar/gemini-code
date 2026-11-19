/**
 * The one policy for walking a project on disk, on top of .gitignore. Used
 * by every walk: find_files / list_files / search_code's fallback, the
 * project tree, the project docs — so they can't drift apart again (the
 * skip list used to be copied into three files).
 *
 *   - never entered: .git, gemini-code's own .gemini-code-tmp and
 *     .gemini-code-profile, and node_modules (unless the walk starts
 *     inside one — a deliberate look at a dependency);
 *   - never listed, searched or sent: .env and .env.* secrets files
 *     (.env.example / .sample / .template are fine);
 *   - .gitignore rules (see gitignore.ts), dropped when the walk starts in
 *     a folder that is itself ignored, so scoping into dist/ or a vendored
 *     tree shows what was asked for;
 *   - a short list of build and cache folders, only when no ignore rules
 *     apply at all — a project with a .gitignore says for itself what's noise.
 *
 * Dotfiles and dot-folders follow the rules like anything else.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { IgnoreMatcher } from "./gitignore.js";
import { rootOf } from "./workspace.js";

export const ALWAYS_SKIP_DIRS: ReadonlySet<string> = new Set([".git", ".gemini-code-tmp", ".gemini-code-profile", "node_modules"]);

/** Skipped only when no .gitignore applies. */
export const NOISE_DIRS: ReadonlySet<string> = new Set([
  "dist", "build", "out", ".next", ".nuxt", ".cache", "coverage", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".gradle", "target", ".tmp-test",
]);

/** .env, .env.local, .env.production…, but not the checked-in templates. */
export function isSecretFile(name: string): boolean {
  return /^\.env(\..+)?$/i.test(name) && !/^\.env\.(example|sample|template|dist)$/i.test(name);
}

export class WalkPolicy {
  /** True when the walk root was itself ignored, so rules are off. */
  readonly scopedIntoIgnored: boolean;
  private readonly matcher: IgnoreMatcher | undefined;
  private readonly noise: boolean;

  /**
   * `base`: where rules start outside a repository (default: the workspace
   * root holding `root`). `noiseList: false` turns the build/cache list off,
   * leaving .gitignore alone in charge (the differential test uses it).
   */
  constructor(readonly root: string, opts: { base?: string; noiseList?: boolean } = {}) {
    const abs = path.resolve(root);
    const matcher = new IgnoreMatcher(abs, { fallbackBase: opts.base ?? rootOf(abs)?.dir });
    this.scopedIntoIgnored = matcher.isIgnored(abs, true);
    this.matcher = this.scopedIntoIgnored ? undefined : matcher;
    this.noise = opts.noiseList !== false && (!this.matcher || !this.matcher.hasRulesFor(abs));
  }

  /** Should the walk go into this folder? The parent is assumed already allowed. */
  enterDir(abs: string): boolean {
    const name = path.basename(abs);
    if (ALWAYS_SKIP_DIRS.has(name)) return false;
    if (this.noise && NOISE_DIRS.has(name)) return false;
    return !this.matcher?.ignoredHere(abs, true);
  }

  /** Should this file be listed? The parent is assumed already allowed. */
  includeFile(abs: string): boolean {
    if (isSecretFile(path.basename(abs))) return false;
    return !this.matcher?.ignoredHere(abs, false);
  }

  /** Full check for a path anywhere under the root (parents included), for filtering other engines' output. */
  visible(abs: string, isDir = false): boolean {
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const parts = rel.split(path.sep).filter(Boolean);
    const dirs = isDir ? parts : parts.slice(0, -1);
    if (dirs.some((d) => ALWAYS_SKIP_DIRS.has(d))) return false;
    if (!isDir && isSecretFile(parts[parts.length - 1] ?? "")) return false;
    return !this.matcher?.isIgnored(abs, isDir);
  }
}

/** Every file the policy allows under `root`, depth first, in directory order. */
export async function* walkProject(root: string, policy = new WalkPolicy(root)): AsyncGenerator<{ full: string; name: string }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (policy.enterDir(full)) yield* walkProject(full, policy);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (policy.includeFile(full)) yield { full, name: entry.name };
    }
  }
}
