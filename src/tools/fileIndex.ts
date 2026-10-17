/**
 * Fast file listing and search for big repositories.
 *
 * A JS directory walk is fine for a small project and hopeless for a
 * monorepo: tens of thousands of files, generated trees, vendored code. So
 * these use the tools a developer would — ripgrep when it's installed
 * (respects .gitignore, multi-threaded), `git ls-files` / `git grep` inside
 * a repository, and only then the walk — behind one interface, so the
 * tools above don't care which ran.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { globToRegExp } from "./searchCode.js";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".cache", "coverage",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", "target",
  ".gemini-code-profile", ".gemini-code-tmp", ".tmp-test",
]);

let rgAvailable: boolean | undefined;

function run(cmd: string, args: string[], cwd: string, maxBytes = 8_000_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    child.on("error", () => resolve({ code: -1, out: "" }));
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < maxBytes) out += d.toString("utf8");
      else child.kill();
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable === undefined) rgAvailable = (await run("rg", ["--version"], process.cwd())).code === 0;
  return rgAvailable;
}

async function isGitRepo(dir: string): Promise<boolean> {
  return (await run("git", ["rev-parse", "--is-inside-work-tree"], dir)).out.trim() === "true";
}

/**
 * Is this directory itself gitignored? When the model deliberately scopes
 * a search to node_modules/some-dep or a generated tree, honouring the
 * repo's ignore rules would hide exactly what it asked for — so ignore
 * rules are dropped for a scope that is itself ignored.
 */
async function isIgnoredDir(dir: string): Promise<boolean> {
  const { code } = await run("git", ["check-ignore", "-q", "."], dir);
  return code === 0;
}

/**
 * Files under `root`, as paths relative to it with forward slashes,
 * honouring .gitignore where rg/git are available. `glob` filters by
 * filename ("*.vue") or by path when it contains a slash ("src/**\/*.ts").
 */
export async function listFiles(root: string, opts: { glob?: string; max?: number } = {}): Promise<{ files: string[]; truncated: boolean; engine: string }> {
  const max = opts.max ?? 2_000;
  const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;
  const onPath = !!opts.glob && opts.glob.includes("/");
  const keep = (rel: string) => {
    if (!globRe) return true;
    return globRe.test(onPath ? rel : path.posix.basename(rel));
  };
  const finish = (all: string[], engine: string) => {
    const files = all.filter(keep);
    return { files: files.slice(0, max), truncated: files.length > max, engine };
  };

  const scopedIntoIgnored = await isIgnoredDir(root);
  if (await hasRipgrep()) {
    const args = ["--files", "--hidden", "-g", "!.git", "-g", "!.gemini-code-tmp"];
    if (scopedIntoIgnored) args.push("--no-ignore");
    else args.push("-g", "!node_modules");
    const { code, out } = await run("rg", args, root);
    if (code === 0 || (code === 1 && out === "")) return finish(out.split("\n").filter(Boolean).map((f) => f.split(path.sep).join("/")), "rg");
  }
  if (!scopedIntoIgnored && (await isGitRepo(root))) {
    const { code, out } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root);
    if (code === 0) return finish(out.split("\0").filter(Boolean), "git");
  }
  const all: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (all.length > max * 5) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name) || (e.name.startsWith(".") && e.isDirectory())) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else all.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  await walk(root);
  return finish(all, "walk");
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Regex search under `root`. Returns hits relative to `root`. `engine`
 * says which backend answered, for the tool's footer.
 */
export async function grep(
  root: string,
  pattern: string,
  opts: { glob?: string; caseSensitive?: boolean; max?: number } = {}
): Promise<{ hits: GrepHit[]; truncated: boolean; engine: string } | undefined> {
  const max = opts.max ?? 100;
  const parse = (out: string): GrepHit[] =>
    out
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(l);
        return m ? [{ file: m[1].split(path.sep).join("/"), line: Number(m[2]), text: m[3].trim().slice(0, 200) }] : [];
      });

  const scopedIntoIgnored = await isIgnoredDir(root);
  if (await hasRipgrep()) {
    const args = ["-n", "--no-heading", "--color", "never", "--max-columns", "400", "-e", pattern];
    if (scopedIntoIgnored) args.push("--no-ignore", "--hidden", "-g", "!.git");
    if (!opts.caseSensitive) args.push("-i");
    if (opts.glob) args.push("-g", opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`);
    args.push("-g", "!.gemini-code-tmp", "-g", "!GEMINI-PLAN.md");
    const { code, out } = await run("rg", args, root);
    if (code === 0 || code === 1) {
      const hits = parse(out);
      return { hits: hits.slice(0, max), truncated: hits.length > max, engine: "rg" };
    }
    if (code === 2) return undefined; // bad regex for rg — let the caller fall back / report
  }
  if (!scopedIntoIgnored && (await isGitRepo(root))) {
    const args = ["grep", "-n", "-I", "-E", "--no-color", ...(opts.caseSensitive ? [] : ["-i"]), "-e", pattern, "--"];
    if (opts.glob) args.push(opts.glob.includes("/") ? opts.glob : `*${opts.glob.replace(/^\*+/, "")}`);
    const { code, out } = await run("git", args, root);
    if (code === 0 || code === 1) {
      const hits = parse(out);
      return { hits: hits.slice(0, max), truncated: hits.length > max, engine: "git grep" };
    }
  }
  return undefined;
}

/**
 * Files whose name resembles what the model asked for — the "did you mean"
 * behind a failed read in a big tree, where the usual mistake is a right
 * filename in the wrong directory, or a near-miss on the name.
 */
export async function suggestPaths(root: string, wanted: string, limit = 5): Promise<string[]> {
  const base = path.posix.basename(wanted.split(path.sep).join("/")).toLowerCase();
  if (!base) return [];
  const stem = base.replace(/\.[^.]+$/, "");
  if (stem.length < 2) return [];
  const { files } = await listFiles(root, { max: 50_000 });
  // The directory the model named often exists even when the file doesn't
  // (or is gitignored, like a vendored tree) — look inside it too.
  const dir = path.posix.dirname(wanted.split(path.sep).join("/"));
  if (dir && dir !== "." && !dir.startsWith("..")) {
    const inDir = await listFiles(path.join(root, dir), { max: 5_000 }).catch(() => ({ files: [] as string[] }));
    for (const f of inDir.files) {
      const full = `${dir}/${f}`;
      if (!files.includes(full)) files.push(full);
    }
  }
  const scored = files
    .map((f) => {
      const name = path.posix.basename(f).toLowerCase();
      const nameStem = name.replace(/\.[^.]+$/, "");
      let score = 0;
      if (name === base) score = 100;
      else if (nameStem === stem) score = 80;
      else if (name.includes(stem) && stem.length >= 3) score = 60;
      else if (nameStem.length >= 3 && stem.includes(nameStem)) score = 40;
      if (score && wanted.includes("/") && f.toLowerCase().includes(path.posix.dirname(wanted).toLowerCase())) score += 10;
      return { f, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.f.length - b.f.length);
  return scored.slice(0, limit).map((s) => s.f);
}
