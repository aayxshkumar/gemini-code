/**
 * multi_edit tests: the failure paths first, since "all or nothing" is only
 * real if it holds when something goes wrong. Called from smoke.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { multiEditTool, multiEditHooks, planFile } from "../tools/multiEdit.js";
import { markRead, forgetAll } from "../tools/fileState.js";
import { CheckpointStore, checkpoints } from "../context/checkpoint.js";
import { setAsker } from "../ui/prompt.js";
import { tools } from "../tools/index.js";
import { buildSystemPrimer } from "../agent/promptTemplate.js";
import { toolCallLine } from "../ui/format.js";

type Test = (name: string, fn: () => Promise<void> | void) => Promise<void>;

const DIR = path.join(".tmp-test", "multi-edit");
const hash = async (f: string) => createHash("sha256").update(await readFile(f)).digest("hex");

async function files(spec: Record<string, string>): Promise<Record<string, string>> {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(spec)) {
    const full = path.join(DIR, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await markRead(path.resolve(full), true);
    out[name] = full;
  }
  return out;
}

export async function multiEditTests(test: Test): Promise<void> {
  await test("multi_edit: three edits across two files all apply", async () => {
    const f = await files({ "a.ts": "export function oldName() {}\n", "b.ts": "import { oldName } from './a';\noldName();\n" });
    const r = await multiEditTool.run({
      edits: [
        { path: f["a.ts"], old_text: "function oldName", new_text: "function newName" },
        { path: f["b.ts"], old_text: "import { oldName }", new_text: "import { newName }" },
        { path: f["b.ts"], old_text: "oldName();", new_text: "newName();" },
      ],
    });
    assert.ok(r.ok, r.output);
    assert.match(r.output, /3 edits in 2 files/);
    assert.equal(await readFile(f["a.ts"], "utf8"), "export function newName() {}\n");
    assert.equal(await readFile(f["b.ts"], "utf8"), "import { newName } from './a';\nnewName();\n");
  });

  await test("multi_edit: edit 3 doesn't match, so neither file changes, and the error names edit 3", async () => {
    const f = await files({ "a.ts": "alpha\n", "b.ts": "beta\n" });
    const before = [await hash(f["a.ts"]), await hash(f["b.ts"])];
    const r = await multiEditTool.run({
      edits: [
        { path: f["a.ts"], old_text: "alpha", new_text: "ALPHA" },
        { path: f["b.ts"], old_text: "beta", new_text: "BETA" },
        { path: f["b.ts"], old_text: "gamma", new_text: "GAMMA" },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.output, /changed nothing/);
    assert.match(r.output, /Edit 3 \(/);
    assert.deepEqual([await hash(f["a.ts"]), await hash(f["b.ts"])], before);
  });

  await test("multi_edit: every problem is reported at once", async () => {
    const f = await files({ "a.ts": "one two two\n" });
    const r = await multiEditTool.run({
      edits: [
        { path: f["a.ts"], old_text: "missing", new_text: "x" },
        { path: f["a.ts"], old_text: "two", new_text: "2" },
      ],
    });
    assert.match(r.output, /2 problems/);
    assert.match(r.output, /Edit 1 .*isn't in the file/);
    assert.match(r.output, /Edit 2 .*appears 2 times/);
  });

  await test("multi_edit: overlapping edits are refused before writing; touching edits are fine", async () => {
    const f = await files({ "a.ts": "const value = compute(input);\n" });
    const overlap = await multiEditTool.run({
      edits: [
        { path: f["a.ts"], old_text: "value = compute", new_text: "result = compute" },
        { path: f["a.ts"], old_text: "compute(input)", new_text: "calc(input)" },
      ],
    });
    assert.equal(overlap.ok, false);
    assert.match(overlap.output, /Edits 1 and 2 .* overlap/);
    assert.equal(await readFile(f["a.ts"], "utf8"), "const value = compute(input);\n");

    const touching = await multiEditTool.run({
      edits: [
        { path: f["a.ts"], old_text: "const ", new_text: "let " },
        { path: f["a.ts"], old_text: "value", new_text: "v" },
      ],
    });
    assert.ok(touching.ok, touching.output);
    assert.equal(await readFile(f["a.ts"], "utf8"), "let v = compute(input);\n");
  });

  await test("multi_edit: an edit that only matches another edit's output is refused (merge them)", async () => {
    const f = await files({ "a.ts": "foo\n" });
    const r = await multiEditTool.run({
      edits: [
        { path: f["a.ts"], old_text: "foo", new_text: "bar" },
        { path: f["a.ts"], old_text: "bar", new_text: "baz" },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.output, /only appears in edit 1's new_text/);
    assert.equal(await readFile(f["a.ts"], "utf8"), "foo\n");
  });

  await test("multi_edit: order doesn't matter — reversed edits give the same bytes", () => {
    const text = "a = 1\nb = 2\nc = 3\n";
    const edits = [
      { index: 1, oldText: "a = 1", newText: "a = 10", replaceAll: false },
      { index: 2, oldText: "c = 3", newText: "c = 30", replaceAll: false },
    ];
    const forward = planFile("x", text, edits);
    const backward = planFile("x", text, [...edits].reverse());
    assert.ok(forward.ok && backward.ok);
    assert.equal(forward.ok && forward.text, backward.ok && backward.text);
  });

  await test("multi_edit: a CRLF file stays CRLF", async () => {
    const f = await files({ "w.ts": "line1\r\nline2\r\n" });
    const r = await multiEditTool.run({ edits: [{ path: f["w.ts"], old_text: "line1\nline2", new_text: "first\nsecond" }] });
    assert.ok(r.ok, r.output);
    assert.equal(await readFile(f["w.ts"], "utf8"), "first\r\nsecond\r\n");
  });

  await test("multi_edit: a file not read in this session is refused, as edit_file does", async () => {
    const f = await files({ "a.ts": "x\n" });
    forgetAll();
    const r = await multiEditTool.run({ edits: [{ path: f["a.ts"], old_text: "x", new_text: "y" }] });
    assert.match(r.output, /haven't read this file/);
    assert.equal(await readFile(f["a.ts"], "utf8"), "x\n");
  });

  await test("multi_edit: outside the workspace and missing files are refused", async () => {
    await files({});
    const outside = await multiEditTool.run({ edits: [{ path: "../outside.ts", old_text: "a", new_text: "b" }] });
    assert.equal(outside.ok, false);
    const missing = await multiEditTool.run({ edits: [{ path: path.join(DIR, "nope.ts"), old_text: "a", new_text: "b" }] });
    assert.match(missing.output, /doesn't exist/);
  });

  await test("multi_edit: one confirmation lists every file, and declining changes nothing", async () => {
    const f = await files({ "a.ts": "a\n", "b.ts": "b\n" });
    const prevApprove = process.env.GEMINI_CODE_AUTO_APPROVE;
    const prevUnattended = process.env.GEMINI_CODE_PROMPT_UNATTENDED;
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    process.env.GEMINI_CODE_PROMPT_UNATTENDED = "1";
    const asked: string[] = [];
    try {
      setAsker(async (q) => {
        asked.push(q);
        return "n";
      });
      const r = await multiEditTool.run({
        edits: [
          { path: f["a.ts"], old_text: "a", new_text: "A" },
          { path: f["b.ts"], old_text: "b", new_text: "B" },
        ],
      });
      assert.equal(asked.length, 1, "asked once for the whole batch");
      assert.ok(asked[0].includes("a.ts") && asked[0].includes("b.ts"), asked[0]);
      assert.equal(r.ok, false);
      assert.equal(await readFile(f["a.ts"], "utf8"), "a\n");
    } finally {
      setAsker(undefined);
      if (prevApprove === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
      else process.env.GEMINI_CODE_AUTO_APPROVE = prevApprove;
      if (prevUnattended === undefined) delete process.env.GEMINI_CODE_PROMPT_UNATTENDED;
      else process.env.GEMINI_CODE_PROMPT_UNATTENDED = prevUnattended;
    }
  });

  await test("multi_edit: a file changed while the question was open is not overwritten", async () => {
    const f = await files({ "a.ts": "a\n", "b.ts": "b\n" });
    multiEditHooks.afterConfirm = async () => writeFile(f["b.ts"], "user edit\n");
    try {
      const r = await multiEditTool.run({
        edits: [
          { path: f["a.ts"], old_text: "a", new_text: "A" },
          { path: f["b.ts"], old_text: "b", new_text: "B" },
        ],
      });
      assert.match(r.output, /changed on disk while the edits waited/);
      assert.equal(await readFile(f["a.ts"], "utf8"), "a\n");
      assert.equal(await readFile(f["b.ts"], "utf8"), "user edit\n");
    } finally {
      delete multiEditHooks.afterConfirm;
    }
  });

  await test("multi_edit: a write failing halfway rolls back the files already written", async () => {
    const f = await files({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" });
    const before = await Promise.all(["a.ts", "b.ts", "c.ts"].map((n) => hash(f[n])));
    multiEditHooks.beforeRename = (_abs, i) => {
      if (i === 2) throw new Error("simulated: disk full");
    };
    try {
      const r = await multiEditTool.run({
        edits: ["a", "b", "c"].map((n) => ({ path: f[`${n}.ts`], old_text: n, new_text: n.toUpperCase() })),
      });
      assert.equal(r.ok, false);
      assert.match(r.output, /rolled back/);
      assert.match(r.output, /a\.ts: restored/);
      assert.deepEqual(await Promise.all(["a.ts", "b.ts", "c.ts"].map((n) => hash(f[n]))), before);
      assert.deepEqual((await readdir(DIR)).filter((n) => n.endsWith(".tmp")), [], "no temp files left behind");
    } finally {
      delete multiEditHooks.beforeRename;
    }
  });

  await test("multi_edit: a failed restore is reported honestly", async () => {
    const f = await files({ "a.ts": "a\n", "b.ts": "b\n" });
    multiEditHooks.beforeRename = (_abs, i) => {
      if (i === 1) throw new Error("simulated rename failure");
    };
    multiEditHooks.beforeRestore = () => {
      throw new Error("simulated restore failure");
    };
    try {
      const r = await multiEditTool.run({
        edits: [
          { path: f["a.ts"], old_text: "a", new_text: "A" },
          { path: f["b.ts"], old_text: "b", new_text: "B" },
        ],
      });
      assert.match(r.output, /a\.ts: STILL HAS THE NEW CONTENT/);
      assert.match(r.output, /b\.ts: unchanged/);
    } finally {
      delete multiEditHooks.beforeRename;
      delete multiEditHooks.beforeRestore;
    }
  });

  await test("multi_edit: a read-only file is refused before anything is written", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod can't make it read-only here
    const f = await files({ "a.ts": "a\n", "ro.ts": "r\n" });
    await chmod(f["ro.ts"], 0o444);
    try {
      const r = await multiEditTool.run({
        edits: [
          { path: f["a.ts"], old_text: "a", new_text: "A" },
          { path: f["ro.ts"], old_text: "r", new_text: "R" },
        ],
      });
      assert.match(r.output, /read-only/);
      assert.equal(await readFile(f["a.ts"], "utf8"), "a\n");
    } finally {
      await chmod(f["ro.ts"], 0o644);
    }
  });

  await test("multi_edit: /undo restores every file it touched", async () => {
    const f = await files({ "a.ts": "a\n", "b.ts": "b\n" });
    checkpoints.begin("multi-edit undo test");
    const r = await multiEditTool.run({
      edits: [
        { path: f["a.ts"], old_text: "a", new_text: "A" },
        { path: f["b.ts"], old_text: "b", new_text: "B" },
      ],
    });
    assert.ok(r.ok, r.output);
    await checkpoints.commit();
    const undone = await checkpoints.undoLast();
    assert.ok(undone.ok, undone.message);
    assert.equal(await readFile(f["a.ts"], "utf8"), "a\n");
    assert.equal(await readFile(f["b.ts"], "utf8"), "b\n");
  });

  await test("checkpoints: a/b.txt and a_b.txt get separate backups", async () => {
    const root = path.resolve(".tmp-test", "ck-names");
    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(root, "a"), { recursive: true });
    await writeFile(path.join(root, "a", "b.txt"), "nested");
    await writeFile(path.join(root, "a_b.txt"), "flat");
    const store = new CheckpointStore(root);
    store.begin("names");
    await store.recordBeforeWrite(path.join(root, "a", "b.txt"));
    await store.recordBeforeWrite(path.join(root, "a_b.txt"));
    await writeFile(path.join(root, "a", "b.txt"), "X");
    await writeFile(path.join(root, "a_b.txt"), "Y");
    await store.commit();
    await store.undoLast();
    assert.equal(await readFile(path.join(root, "a", "b.txt"), "utf8"), "nested");
    assert.equal(await readFile(path.join(root, "a_b.txt"), "utf8"), "flat");
    await rm(root, { recursive: true, force: true });
  });

  await test("multi_edit: registered, named in the primer, and shown as edits-in-files", () => {
    assert.ok(tools.some((t) => t.name === "multi_edit"));
    assert.match(buildSystemPrimer(tools), /multi_edit/);
    const line = toolCallLine("multi_edit", { edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }] });
    assert.match(line.replace(/\x1b\[[0-9;]*m/g, ""), /3 edits in 2 files: a\.ts, b\.ts/);
  });

  await rm(DIR, { recursive: true, force: true });
}
