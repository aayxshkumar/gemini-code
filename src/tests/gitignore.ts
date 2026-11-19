/**
 * Tests for src/gitignore.ts and src/walk.ts.
 *
 *   npm test               runs these with 150 random cases
 *   npm run test:gitignore runs them alone with 2,000
 *
 * The differential test builds random trees and .gitignore files in a temp
 * folder (outside any repository), asks git which files are visible
 * (`git ls-files --others --exclude-standard`, with global and system config
 * switched off), and requires the walk to give exactly the same set. The
 * pattern pool is built to hit the rules that hand-written matchers get
 * wrong: negation, re-including under an excluded folder, anchors, `**` in
 * each position, folder-only patterns, classes, escapes, trailing spaces.
 * Seeds are fixed, so a failure reproduces; it prints the seed and the tree.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileWildmatch, IgnoreMatcher, parseRule } from "../gitignore.js";
import { walkProject, WalkPolicy } from "../walk.js";

type Test = (name: string, fn: () => Promise<void> | void) => Promise<void>;

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

/** git with no user or system config, so a developer's global excludes can't change the answer. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.ignorecase=false", "-c", "core.excludesFile=", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "gemini-code-no-gitconfig"), HOME: os.tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tempDir(label: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), `gc-${label}-`)));
}

function write(root: string, rel: string, content = "x\n"): void {
  const full = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** What the walk lists, with rules only (no secrets or always-skip noise in these trees). */
async function walked(root: string, opts: { noiseList?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  for await (const { full } of walkProject(root, new WalkPolicy(root, { base: root, ...opts }))) out.push(path.relative(root, full).split(path.sep).join("/"));
  return out.sort();
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["a", "b", "c", "src", "lib", "build", "log", "x.log", "y.txt", "z.md", "keep.log", "deep", "#hash", "!bang", "sp ace", "a.b.c", "ab", "abc", "Data"];
const DIRS = ["src", "lib", "build", "deep", "a", "b", "out", "docs", "sub"];

function randomPattern(r: () => number): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const name = pick(NAMES.filter((n) => !n.startsWith("#") && !n.startsWith("!") && !n.includes(" ")));
  const dir = pick(DIRS);
  const forms = [
    () => name,
    () => `*.log`,
    () => `!keep.log`,
    () => `!${name}`,
    () => `${dir}/`,
    () => `/${dir}`,
    () => `/${name}`,
    () => `${dir}/${name}`,
    () => `${dir}/*`,
    () => `!${dir}/${name}`,
    () => `**/${name}`,
    () => `**/${dir}/`,
    () => `${dir}/**`,
    () => `${dir}/**/${name}`,
    () => `!${dir}/`,
    () => `a?`,
    () => `[ab]`,
    () => `[!a]b*`,
    () => `[a-c]*.txt`,
    () => `*.[mt][dx]*`,
    () => `\\#hash`,
    () => `\\!bang`,
    () => `sp ace`,
    () => `${name}   `,
    () => `${name}\\ `,
    () => `# a comment`,
    () => ``,
    () => `*`,
    () => `!*/`,
    () => `!*.txt`,
    () => `${dir}/*/`,
    () => `**`,
  ];
  return pick(forms)();
}

function randomCase(seed: number): { files: string[]; ignores: Record<string, string> } {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const files = new Set<string>();
  const nFiles = 8 + Math.floor(r() * 14);
  for (let i = 0; i < nFiles; i++) {
    const depth = Math.floor(r() * 4);
    const parts: string[] = [];
    for (let d = 0; d < depth; d++) parts.push(pick(DIRS));
    parts.push(pick(NAMES));
    files.add(parts.join("/"));
  }
  // A name can't be both a file and a folder.
  const all = [...files];
  const dirs = new Set(all.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
  const clean = all.filter((f) => !dirs.has(f));
  const ignores: Record<string, string> = {};
  const places = ["", ...[...dirs].filter(() => r() < 0.35)];
  for (const place of places) {
    if (place === "" || r() < 0.7) {
      const n = 1 + Math.floor(r() * 5);
      const lines = Array.from({ length: n }, () => randomPattern(r));
      ignores[place ? `${place}/.gitignore` : ".gitignore"] = lines.join(r() < 0.15 ? "\r\n" : "\n") + "\n";
    }
  }
  if (r() < 0.25) ignores[".git/info/exclude"] = Array.from({ length: 2 }, () => randomPattern(r)).join("\n") + "\n";
  return { files: clean, ignores };
}

async function differential(cases: number, firstSeed = 1): Promise<{ paths: number }> {
  let paths = 0;
  for (let k = 0; k < cases; k++) {
    const seed = firstSeed + k;
    const { files, ignores } = randomCase(seed);
    const root = tempDir("diff");
    try {
      git(root, ["init", "-q"]);
      for (const f of files) write(root, f);
      for (const [rel, text] of Object.entries(ignores)) write(root, rel, text);
      const expected = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean)
        .sort();
      const actual = (await walked(root, { noiseList: false })).filter((f) => !f.startsWith(".git/"));
      paths += files.length + Object.keys(ignores).length;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const only = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
        assert.fail(
          `seed ${seed}: walk and git disagree\n` +
            `  only git shows: ${JSON.stringify(only(expected, actual))}\n` +
            `  only the walk shows: ${JSON.stringify(only(actual, expected))}\n` +
            `  files: ${JSON.stringify(files)}\n  ignore files: ${JSON.stringify(ignores, null, 1)}`
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return { paths };
}

export async function gitignoreTests(test: Test, opts: { cases?: number } = {}): Promise<void> {
  const cases = opts.cases ?? 150;

  await test("gitignore: wildmatch basics — *, ?, classes, escapes", () => {
    const m = (p: string, s: string) => !!compileWildmatch(p)?.test(s);
    assert.ok(m("*.log", "x.log") && !m("*.log", "a/x.log"), "* stays inside one folder");
    assert.ok(m("a?c", "abc") && !m("a?c", "a/c"));
    assert.ok(m("[a-c]x", "bx") && !m("[a-c]x", "dx"));
    assert.ok(m("[!a]x", "bx") && !m("[!a]x", "ax") && !m("[!a]x", "/x"), "a negated class never matches /");
    assert.ok(m("[[:digit:]]*", "7up") && !m("[[:digit:]]*", "up"));
    assert.ok(m("[]]", "]"), "] first in a class is literal");
    assert.ok(m("\\*", "*") && !m("\\*", "a"));
    assert.equal(compileWildmatch("[abc"), undefined, "an unclosed class never matches, as in git");
    assert.equal(compileWildmatch("abc\\"), undefined, "a trailing backslash never matches");
  });

  await test("gitignore: ** in each position", () => {
    const m = (p: string, s: string) => !!compileWildmatch(p)?.test(s);
    assert.ok(m("**/foo", "foo") && m("**/foo", "a/b/foo"));
    assert.ok(m("a/**", "a/x") && m("a/**", "a/x/y") && !m("a/**", "a"));
    assert.ok(m("a/**/b", "a/b") && m("a/**/b", "a/x/y/b") && !m("a/**/b", "a/xb"));
    assert.ok(m("a**b", "axxb") && !m("a**b", "a/b"), "** not between slashes is a plain *");
  });

  await test("gitignore: line parsing — comments, escapes, trailing spaces, negation, folder-only", () => {
    assert.equal(parseRule("# note", "t"), undefined);
    assert.equal(parseRule("   ", "t"), undefined);
    assert.ok(parseRule("\\#hash", "t")?.regex?.test("#hash"));
    const bang = parseRule("\\!bang", "t")!;
    assert.ok(!bang.negate && bang.regex!.test("!bang"));
    assert.ok(parseRule("name   ", "t")!.regex!.test("name"), "unescaped trailing spaces are dropped");
    assert.ok(parseRule("name\\ ", "t")!.regex!.test("name "), "an escaped trailing space is kept");
    const neg = parseRule("!keep.log", "t")!;
    assert.ok(neg.negate && neg.regex!.test("keep.log"));
    const dir = parseRule("build/", "t")!;
    assert.ok(dir.dirOnly && !dir.anchored, "a trailing slash alone doesn't anchor");
    assert.ok(parseRule("/build", "t")!.anchored && parseRule("a/b", "t")!.anchored);
    assert.equal(parseRule("x\r", "t")!.regex!.test("x"), true, "CRLF");
  });

  const tree = (files: string[], ignores: Record<string, string>) => {
    const root = tempDir("unit");
    mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    for (const f of files) write(root, f);
    for (const [rel, text] of Object.entries(ignores)) write(root, rel, text);
    return root;
  };

  await test("gitignore: negation, and nothing re-included under an excluded folder", async () => {
    const root = tree(["x.log", "keep.log", "build/keep.log", "build/a.txt"], { ".gitignore": "*.log\n!keep.log\nbuild/\n!build/keep.log\n" });
    try {
      assert.deepEqual(await walked(root), [".gitignore", "keep.log"]);
      const m = new IgnoreMatcher(root);
      assert.equal(m.isIgnored(path.join(root, "build", "keep.log"), false), true, "build/ is excluded, so !build/keep.log can't bring it back");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await test("gitignore: anchored vs unanchored, and folder-only patterns", async () => {
    const root = tree(["build", "src/build/x.js", "docs/build", "tmp/a", "src/tmp/b"], { ".gitignore": "build/\n/tmp\n" });
    try {
      // "build/" hides the folder src/build but not the FILES named build; "/tmp" only the top one.
      assert.deepEqual(await walked(root), [".gitignore", "build", "docs/build", "src/tmp/b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await test("gitignore: a nested .gitignore overrides its parent, and info/exclude ranks lowest", async () => {
    const root = tree(["a.txt", "sub/a.txt", "sub/b.txt", "c.tmp"], {
      ".gitignore": "*.txt\n",
      "sub/.gitignore": "!a.txt\n",
      ".git/info/exclude": "*.tmp\n!b.txt\n",
    });
    try {
      assert.deepEqual(await walked(root), [".gitignore", "sub/.gitignore", "sub/a.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await test("walk policy: secrets, always-skipped folders, noise only without rules, ignored scopes", async () => {
    const bare = tempDir("policy");
    try {
      for (const f of [".env", ".env.local", ".env.example", "node_modules/x/i.js", "dist/out.js", ".github/ci.yml", "src/a.ts"]) write(bare, f);
      // No rules at all: the noise list applies.
      assert.deepEqual(await walked(bare), [".env.example", ".github/ci.yml", "src/a.ts"]);
      // With a .gitignore, it says what's noise; dist/ shows unless listed.
      write(bare, ".gitignore", "*.log\n");
      assert.deepEqual(await walked(bare), [".env.example", ".github/ci.yml", ".gitignore", "dist/out.js", "src/a.ts"]);
      write(bare, ".gitignore", "dist/\n");
      // Scoped into the ignored folder: its rules are dropped, so it's listed.
      const scoped: string[] = [];
      const policy = new WalkPolicy(path.join(bare, "dist"), { base: bare });
      assert.equal(policy.scopedIntoIgnored, true, "outside a repository, the workspace root's .gitignore still applies to a scope");
      for await (const { name } of walkProject(path.join(bare, "dist"), policy)) scoped.push(name);
      assert.deepEqual(scoped, ["out.js"]);
      assert.deepEqual(await walked(bare), [".env.example", ".github/ci.yml", ".gitignore", "src/a.ts"]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  if (!gitAvailable()) {
    console.log("  (gitignore differential test skipped: git isn't on PATH)");
    return;
  }

  await test(`gitignore: agrees with git on ${cases} random trees`, async () => {
    const { paths } = await differential(cases);
    assert.ok(paths >= 500, `only ${paths} paths generated`);
  });
}

// `npm run test:gitignore`: the same tests, alone, with many more cases.
if (process.argv[1] && /tests[\\/]gitignore\.ts$/.test(process.argv[1])) {
  let passed = 0;
  let failed = 0;
  await gitignoreTests(
    async (name, fn) => {
      try {
        await fn();
        passed++;
        console.log(`  ok - ${name}`);
      } catch (err) {
        failed++;
        console.log(`  FAIL - ${name}\n    ${(err as Error).message}`);
      }
    },
    { cases: Number(process.env.GITIGNORE_CASES) || 2000 }
  );
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
