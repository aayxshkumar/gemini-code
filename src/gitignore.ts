/**
 * .gitignore matching, the way git does it — for the walks that run when
 * neither ripgrep nor git is available (common on a fresh Windows machine),
 * so the agent sees the same files there as everywhere else.
 *
 * What's implemented, following gitignore(5) and git's dir.c / wildmatch.c:
 *   - one .gitignore per directory, deeper files taking precedence, and
 *     .git/info/exclude below them all; within a file the last match wins;
 *   - `!` negation, and git's rule that nothing can be re-included under an
 *     excluded directory (git never even reads a .gitignore in one);
 *   - a pattern with a `/` at the start or in the middle is anchored to its
 *     .gitignore's directory; one without matches a name at any depth;
 *     a trailing `/` matches directories only;
 *   - `*`, `?`, `[...]` (ranges, `!`/`^` negation, `[:class:]`), and `**`
 *     as a leading `**​/`, a trailing `/**` or a middle `/**​/`;
 *   - `\` escapes (`\#`, `\!`, `\ `), comments, blank lines, unescaped
 *     trailing spaces, a BOM and CRLF line endings;
 *   - `.git` as a file (worktrees, submodules: `gitdir: <path>`).
 *
 * Not read: the global core.excludesFile. Case-insensitive matching follows
 * the platform (Windows and macOS), as git's own default does.
 *
 * Paths are absolute in the API and compared with forward slashes.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface IgnoreRule {
  /** The text after unescaping markers, for diagnostics. */
  pattern: string;
  negate: boolean;
  dirOnly: boolean;
  /** Matched against the path relative to `base` (true) or the basename (false). */
  anchored: boolean;
  /** Undefined when the pattern can never match (an unclosed `[`, a trailing `\`). */
  regex?: RegExp;
  /** Where the rule came from, e.g. "src/.gitignore:3". */
  source: string;
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "\\x21-\\x7e",
  lower: "a-z",
  print: "\\x20-\\x7e",
  punct: "!-\\/:-@\\[-`{-~",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
};

const escapeRe = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/**
 * A `[...]` class starting at `i` (the `[`). Returns the regex for it and the
 * index after the closing `]`, or undefined when it never closes — git's
 * wildmatch then gives up on the whole pattern.
 */
function parseClass(p: string, i: number): { re: string; next: number } | undefined {
  let j = i + 1;
  let negate = false;
  if (p[j] === "!" || p[j] === "^") {
    negate = true;
    j++;
  }
  let body = "";
  let first = true;
  while (j < p.length) {
    const ch = p[j];
    if (ch === "]" && !first) {
      // A class never matches "/" in pathname mode.
      return { re: negate ? `[^${body}/]` : `(?!/)[${body}]`, next: j + 1 };
    }
    first = false;
    if (ch === "[" && p[j + 1] === ":") {
      const end = p.indexOf(":]", j + 2);
      if (end !== -1) {
        const name = p.slice(j + 2, end);
        const cls = POSIX_CLASSES[name];
        if (cls === undefined) return undefined; // unknown class: malformed
        body += cls;
        j = end + 2;
        continue;
      }
    }
    let lo = ch;
    if (ch === "\\") {
      j++;
      if (j >= p.length) return undefined;
      lo = p[j];
    }
    // A range "a-z" (a "-" right before "]" is literal).
    if (p[j + 1] === "-" && j + 2 < p.length && p[j + 2] !== "]") {
      let hi = p[j + 2];
      let skip = 3;
      if (hi === "\\") {
        if (j + 3 >= p.length) return undefined;
        hi = p[j + 3];
        skip = 4;
      }
      if (hi.charCodeAt(0) >= lo.charCodeAt(0)) body += `${escapeRe(lo)}-${escapeRe(hi)}`;
      // A reversed range matches nothing, as in wildmatch; keep the class valid.
      j += skip;
      continue;
    }
    body += escapeRe(lo);
    j++;
  }
  return undefined;
}

/** Compiles a wildmatch pattern (WM_PATHNAME) to an anchored regex, or undefined if it can never match. */
export function compileWildmatch(p: string, ignoreCase = false): RegExp | undefined {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "\\") {
      if (i + 1 >= p.length) return undefined;
      re += escapeRe(p[++i]);
    } else if (ch === "*") {
      let j = i;
      while (p[j + 1] === "*") j++;
      const stars = j - i + 1;
      const atStart = i === 0 || p[i - 1] === "/";
      const atEnd = j + 1 === p.length || p[j + 1] === "/";
      if (stars >= 2 && atStart && atEnd) {
        if (j + 1 === p.length) {
          // "foo/**" (or a bare "**"): everything below.
          re += i === 0 ? ".*" : ".+";
        } else {
          // "**/" — zero or more whole directories.
          re += "(?:.*/)?";
          j++; // the "/" is consumed by the group
        }
      } else {
        re += "[^/]*";
      }
      i = j;
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const cls = parseClass(p, i);
      if (!cls) return undefined;
      re += cls.re;
      i = cls.next - 1;
    } else {
      re += escapeRe(ch);
    }
  }
  try {
    return new RegExp(`^${re}$`, ignoreCase ? "i" : "");
  } catch {
    return undefined;
  }
}

/** Strips unescaped trailing spaces, as git's trim_trailing_spaces does. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let k = end - 2; k >= 0 && line[k] === "\\"; k--) backslashes++;
    if (backslashes % 2 === 1) break; // "\ " keeps its space
    end--;
  }
  return line.slice(0, end);
}

/** One line of a .gitignore, or undefined for blanks and comments. */
export function parseRule(raw: string, source: string, ignoreCase = false): IgnoreRule | undefined {
  let line = trimTrailingSpaces(raw.replace(/\r$/, ""));
  if (!line || line.startsWith("#")) return undefined;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    dirOnly = true;
    line = line.replace(/\/+$/, "");
  }
  if (!line) return undefined;
  // A slash anywhere but the end anchors the pattern to the .gitignore's folder.
  const anchored = line.includes("/");
  const body = line.startsWith("/") ? line.slice(1) : line;
  if (!body) return undefined;
  return { pattern: (negate ? "!" : "") + line + (dirOnly ? "/" : ""), negate, dirOnly, anchored, regex: compileWildmatch(body, ignoreCase), source };
}

export function parseIgnoreFile(text: string, source: string, ignoreCase = false): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  text
    .replace(/^﻿/, "")
    .split("\n")
    .forEach((line, i) => {
      const rule = parseRule(line, `${source}:${i + 1}`, ignoreCase);
      if (rule) rules.push(rule);
    });
  return rules;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

function isWithin(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The repository holding `dir`: the nearest folder with a `.git` entry, and where its git dir is. */
export function findRepository(dir: string): { root: string; gitDir: string } | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, ".git");
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) return { root: current, gitDir: dotGit };
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (pointer) return { root: current, gitDir: path.resolve(current, pointer) };
      } catch {
        // unreadable .git: treat as no repository here
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The ignore rules for one tree. `base` is the repository root when there
 * is one, else the folder given (rules are never read above it then, so a
 * stray .gitignore in a home directory doesn't hide a whole project).
 */
export class IgnoreMatcher {
  readonly base: string;
  private readonly ignoreCase: boolean;
  private readonly perDir = new Map<string, IgnoreRule[]>();
  private readonly dirVerdicts = new Map<string, boolean>();
  private readonly exclude: IgnoreRule[];

  /**
   * `fallbackBase`: where rules start when `start` isn't in a repository —
   * the workspace root holding it, so a search scoped to dist/ still sees
   * the project's own .gitignore. Never above that.
   */
  constructor(start: string, opts: { ignoreCase?: boolean; fallbackBase?: string } = {}) {
    const repo = findRepository(start);
    const fallback = opts.fallbackBase && isWithin(path.resolve(start), path.resolve(opts.fallbackBase)) ? opts.fallbackBase : start;
    this.base = repo?.root ?? path.resolve(fallback);
    this.ignoreCase = opts.ignoreCase ?? (process.platform === "win32" || process.platform === "darwin");
    this.exclude = [];
    if (repo) {
      const file = path.join(repo.gitDir, "info", "exclude");
      try {
        this.exclude = parseIgnoreFile(readFileSync(file, "utf8"), ".git/info/exclude", this.ignoreCase);
      } catch {
        // no exclude file
      }
    }
  }

  /** The rules in `dir`'s own .gitignore (cached). */
  rulesIn(dir: string): IgnoreRule[] {
    const key = path.resolve(dir);
    let rules = this.perDir.get(key);
    if (!rules) {
      try {
        const rel = toPosix(path.relative(this.base, key));
        rules = parseIgnoreFile(readFileSync(path.join(key, ".gitignore"), "utf8"), `${rel ? `${rel}/` : ""}.gitignore`, this.ignoreCase);
      } catch {
        rules = [];
      }
      this.perDir.set(key, rules);
    }
    return rules;
  }

  /** Does any rule file apply to `dir` (its own or an ancestor's up to the base, or info/exclude)? */
  hasRulesFor(dir: string): boolean {
    if (this.exclude.length) return true;
    let current = path.resolve(dir);
    for (;;) {
      if (this.rulesIn(current).length) return true;
      if (current === this.base || !this.inside(current)) return false;
      current = path.dirname(current);
    }
  }

  private inside(abs: string): boolean {
    const rel = path.relative(this.base, abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * The rule that decides `abs` on its own, ignoring whether a parent folder
   * is excluded: deepest .gitignore first, last matching line in it, then
   * info/exclude. Undefined when nothing matches.
   */
  decidingRule(abs: string, isDir: boolean): IgnoreRule | undefined {
    const target = path.resolve(abs);
    if (!this.inside(target) || target === this.base) return undefined;
    const name = path.basename(target);
    const test = (rules: IgnoreRule[], from: string): IgnoreRule | undefined => {
      const rel = toPosix(path.relative(from, target));
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (!r.regex || (r.dirOnly && !isDir)) continue;
        if (r.regex.test(r.anchored ? rel : name)) return r;
      }
      return undefined;
    };
    let dir = path.dirname(target);
    for (;;) {
      const hit = test(this.rulesIn(dir), dir);
      if (hit) return hit;
      if (dir === this.base) break;
      dir = path.dirname(dir);
    }
    return test(this.exclude, this.base);
  }

  /** `abs` alone, assuming its parent folder is not excluded (what a walk knows). */
  ignoredHere(abs: string, isDir: boolean): boolean {
    const rule = this.decidingRule(abs, isDir);
    return !!rule && !rule.negate;
  }

  /** Full answer: excluded itself, or under an excluded folder (which can't be undone by `!`). */
  isIgnored(abs: string, isDir: boolean): boolean {
    const target = path.resolve(abs);
    if (!this.inside(target) || target === this.base) return false;
    const rel = toPosix(path.relative(this.base, target)).split("/");
    let current = this.base;
    for (let i = 0; i < rel.length - 1; i++) {
      current = path.join(current, rel[i]);
      let verdict = this.dirVerdicts.get(current);
      if (verdict === undefined) {
        verdict = this.ignoredHere(current, true);
        this.dirVerdicts.set(current, verdict);
      }
      if (verdict) return true;
    }
    return this.ignoredHere(target, isDir);
  }
}
