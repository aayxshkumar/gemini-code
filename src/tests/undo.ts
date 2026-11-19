/**
 * /undo safety tests. Each one reproduces a sequence that, with the 0.13.0
 * checkpoint store, ended with your work silently lost or the history
 * corrupted. Called from smoke.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CheckpointStore, checkpointHooks } from "../context/checkpoint.js";

type Test = (name: string, fn: () => Promise<void> | void) => Promise<void>;

const BASE = path.resolve(".tmp-test", "undo");
let n = 0;

/** A fresh project folder and store for one test. */
async function project(files: Record<string, string | Buffer> = {}) {
  const root = path.join(BASE, `p${++n}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  const abs = (rel: string) => path.join(root, rel);
  const read = (rel: string) => readFile(abs(rel), "utf8").catch(() => undefined);
  return { root, abs, read, store: new CheckpointStore(root) };
}

const sha = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

export async function undoTests(test: Test): Promise<void> {
  await test("undo: your edit after the agent is a conflict, and NOTHING is changed", async () => {
    const p = await project({ "a.ts": "a0", "b.ts": "b0" });
    p.store.begin("edit both");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await p.store.writeFile(p.abs("b.ts"), "b1");
    await p.store.commit();
    await writeFile(p.abs("b.ts"), "my edit");

    const r = await p.store.undoLast();
    assert.equal(r.ok, false);
    assert.deepEqual(r.conflicts, [{ file: "b.ts", state: "edited" }]);
    assert.equal(await p.read("a.ts"), "a1", "all or nothing: a.ts isn't restored while b.ts conflicts");
    assert.equal(await p.read("b.ts"), "my edit", "your edit survives");
    assert.equal((await p.store.list()).length, 1, "the checkpoint is kept");
  });

  await test("undo --force keeps your version as .conflict, then undoes everything", async () => {
    const p = await project({ "a.ts": "a0", "b.ts": "b0", "b.ts.conflict": "older copy" });
    p.store.begin("edit both");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await p.store.writeFile(p.abs("b.ts"), "b1");
    await p.store.commit();
    await writeFile(p.abs("b.ts"), "my edit");

    const r = await p.store.undoLast({ force: true });
    assert.ok(r.ok, r.message);
    assert.equal(await p.read("a.ts"), "a0");
    assert.equal(await p.read("b.ts"), "b0");
    assert.equal(await p.read("b.ts.conflict"), "older copy", "never over an existing .conflict");
    assert.equal(await p.read("b.ts.conflict.1"), "my edit");
  });

  await test("undo: a file the agent created is removed, unless you changed it since", async () => {
    const p = await project();
    p.store.begin("create two");
    await p.store.writeFile(p.abs("new1.ts"), "agent");
    await p.store.writeFile(p.abs("new2.ts"), "agent");
    await p.store.commit();
    await writeFile(p.abs("new2.ts"), "agent + my work");
    const refused = await p.store.undoLast();
    assert.deepEqual(refused.conflicts, [{ file: "new2.ts", state: "edited" }]);
    assert.equal(await p.read("new1.ts"), "agent");

    await writeFile(p.abs("new2.ts"), "agent");
    const r = await p.store.undoLast();
    assert.ok(r.ok, r.message);
    assert.equal(await p.read("new1.ts"), undefined);
    assert.equal(await p.read("new2.ts"), undefined);
  });

  await test("undo: a file you deleted after the agent is a conflict", async () => {
    const p = await project({ "a.ts": "a0" });
    p.store.begin("t");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await p.store.commit();
    await rm(p.abs("a.ts"));
    const r = await p.store.undoLast();
    assert.deepEqual(r.conflicts, [{ file: "a.ts", state: "deleted" }]);
    const forced = await p.store.undoLast({ force: true });
    assert.ok(forced.ok);
    assert.equal(await p.read("a.ts"), "a0", "--force recreates it");
  });

  await test("undo: a file changed by someone else between two agent writes is flagged", async () => {
    const p = await project({ "a.ts": "a0" });
    p.store.begin("t");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await writeFile(p.abs("a.ts"), "user edit mid-task");
    await p.store.writeFile(p.abs("a.ts"), "a2"); // the agent wrote over it
    await p.store.commit();
    const r = await p.store.undoLast();
    assert.deepEqual(r.conflicts, [{ file: "a.ts", state: "changed-during-task" }]);
  });

  await test("undo: three tasks undone one at a time, each back to the state before it", async () => {
    const p = await project({ "f.ts": "v0" });
    for (const v of ["v1", "v2", "v3"]) {
      p.store.begin(`to ${v}`);
      await p.store.writeFile(p.abs("f.ts"), v);
      await p.store.commit();
    }
    assert.equal((await p.store.list()).length, 3, "one entry per task (0.13.0 saved each twice)");
    for (const expected of ["v2", "v1", "v0"]) {
      const r = await p.store.undoLast();
      assert.ok(r.ok, r.message);
      assert.equal(await p.read("f.ts"), expected);
    }
    assert.equal((await p.store.undoLast()).message, "Nothing to undo.");
  });

  await test("undo: CRLF, a BOM and binary files come back byte for byte", async () => {
    const binary = Buffer.from([0, 255, 1, 254, 13, 10, 0x89, 0x50, 0x4e, 0x47]);
    const p = await project({ "crlf.txt": "a\r\nb\r\n", "bom.txt": "﻿hello\n", "img.bin": binary });
    const before = await Promise.all(["crlf.txt", "bom.txt", "img.bin"].map((f) => sha(p.abs(f))));
    p.store.begin("t");
    for (const f of ["crlf.txt", "bom.txt", "img.bin"]) await p.store.writeFile(p.abs(f), "replaced\n");
    await p.store.commit();
    const r = await p.store.undoLast();
    assert.ok(r.ok, r.message);
    assert.deepEqual(await Promise.all(["crlf.txt", "bom.txt", "img.bin"].map((f) => sha(p.abs(f)))), before);
  });

  await test("undo: identical originals share one stored copy, and different paths never collide", async () => {
    const p = await project({ "a/b.txt": "same", "a_b.txt": "same", "c.txt": "other" });
    p.store.begin("t");
    for (const f of ["a/b.txt", "a_b.txt", "c.txt"]) await p.store.writeFile(p.abs(f), "X");
    await p.store.commit();
    const blobs = await readdir(path.join(p.root, ".gemini-code-tmp", "backups", "blobs"));
    assert.equal(blobs.filter((b) => !b.includes(".tmp")).length, 2, "content-addressed: 'same' is stored once");
    assert.ok((await p.store.undoLast()).ok);
    assert.deepEqual([await p.read("a/b.txt"), await p.read("a_b.txt"), await p.read("c.txt")], ["same", "same", "other"]);
  });

  await test("undo: a checkpoint written by 0.13.0 loads (duplicates merged) and undoes, saving current versions first", async () => {
    const p = await project({ "keep.txt": "agent wrote this", "new.txt": "created" });
    const dir = path.join(p.root, ".gemini-code-tmp", "backups");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "ck_old-keep.txt"), "ORIGINAL");
    const old = { id: "ck_old", task: "old task", at: "2026-10-17T00:00:00Z", changes: [
      { file: "keep.txt", backup: ".gemini-code-tmp/backups/ck_old-keep.txt" },
      { file: "new.txt", backup: null },
    ] };
    // 0.13.0's persist + commit left the same task in twice.
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify([old, old], null, 2));
    assert.equal((await p.store.list()).length, 1);
    const r = await p.store.undoLast();
    assert.ok(r.ok, r.message);
    assert.match(r.message, /current versions saved to .*before-undo-ck_old-/);
    assert.equal(await p.read("keep.txt"), "ORIGINAL");
    assert.equal(await p.read("new.txt"), undefined);
    const saved = (await readdir(dir)).find((d) => d.startsWith("before-undo-ck_old-"))!;
    assert.equal(await readFile(path.join(dir, saved, "keep.txt"), "utf8"), "agent wrote this");
  });

  await test("undo: a damaged manifest gives a clear error, is moved aside, and no backup is deleted", async () => {
    const p = await project({ "a.ts": "a0" });
    p.store.begin("t");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await p.store.commit();
    const dir = path.join(p.root, ".gemini-code-tmp", "backups");
    const manifest = path.join(dir, "manifest.json");
    const text = await readFile(manifest, "utf8");
    await writeFile(manifest, text.slice(0, text.length / 2)); // truncated
    const blobsBefore = await readdir(path.join(dir, "blobs"));
    const r = await p.store.undoLast();
    assert.equal(r.ok, false);
    assert.match(r.message, /damaged .* moved to/);
    assert.deepEqual(await readdir(path.join(dir, "blobs")), blobsBefore);
    assert.ok((await readdir(dir)).some((f) => f.startsWith("manifest.json.damaged-")));
    assert.equal(await p.read("a.ts"), "a1", "nothing was restored from a guess");
  });

  await test("undo: a crash halfway through saving the manifest leaves the previous one intact", async () => {
    const p = await project({ "a.ts": "a0" });
    p.store.begin("first");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await p.store.commit();
    const manifest = path.join(p.root, ".gemini-code-tmp", "backups", "manifest.json");
    const before = await readFile(manifest, "utf8");
    checkpointHooks.midManifestWrite = () => {
      throw new Error("simulated crash");
    };
    try {
      p.store.begin("second");
      const r = await p.store.recordBeforeWrite(p.abs("a.ts"));
      assert.equal(r.ok, false, "a record that couldn't be saved refuses the write");
    } finally {
      delete checkpointHooks.midManifestWrite;
    }
    assert.equal(await readFile(manifest, "utf8"), before, "temp file + rename: the old manifest is untouched");
    JSON.parse(before);
  });

  await test("undo: a failed backup refuses the write", async () => {
    const p = await project({ "a.ts": "a0" });
    // A file where the blobs folder should be: the backup can't be stored.
    await mkdir(path.join(p.root, ".gemini-code-tmp", "backups"), { recursive: true });
    await writeFile(path.join(p.root, ".gemini-code-tmp", "backups", "blobs"), "not a folder");
    p.store.begin("t");
    await assert.rejects(p.store.writeFile(p.abs("a.ts"), "a1"), /not written: couldn't back up/);
    assert.equal(await p.read("a.ts"), "a0");
  });

  await test("undo: a file the agent left unchanged is skipped; list shows each file's state", async () => {
    const p = await project({ "a.ts": "a0", "b.ts": "b0" });
    p.store.begin("t");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await p.store.writeFile(p.abs("b.ts"), "b1");
    await p.store.commit();
    await writeFile(p.abs("a.ts"), "a0"); // you put it back yourself
    const [ck] = await p.store.list();
    assert.deepEqual(ck.states, [{ file: "a.ts", state: "already-original" }, { file: "b.ts", state: "restore" }]);
    assert.ok((await p.store.undoLast()).ok);
    assert.equal(await p.read("b.ts"), "b0");
  });

  await test("undo: a task still running in another live session is skipped", async () => {
    const p = await project({ "a.ts": "a0", "b.ts": "b0" });
    p.store.begin("finished task");
    await p.store.writeFile(p.abs("a.ts"), "a1");
    await p.store.commit();
    // Another live process (our parent) has a task in progress.
    const manifest = path.join(p.root, ".gemini-code-tmp", "backups", "manifest.json");
    const m = JSON.parse(await readFile(manifest, "utf8"));
    m.checkpoints.push({ id: "ck_other", task: "running elsewhere", at: new Date().toISOString(), pid: process.ppid, v: 2, changes: [{ file: "b.ts", backup: null, original: null }] });
    await writeFile(manifest, JSON.stringify(m));
    const r = await p.store.undoLast();
    assert.ok(r.ok, r.message);
    assert.match(r.message, /finished task/);
    assert.equal(await p.read("a.ts"), "a0");
  });

  await rm(BASE, { recursive: true, force: true });
}
