/**
 * Per-task checkpoints, so `/undo` can put back what the agent changed —
 * and only what the agent changed.
 *
 * The old store copied every backup back unconditionally: an edit you made
 * after the agent was silently overwritten, a file the agent created was
 * deleted even if you'd worked in it since, and every task was saved twice
 * (so a second /undo re-ran the same task). Now:
 *
 * Write side — tools call recordBeforeWrite() before touching a file and
 * recordAfterWrite() after:
 *   - the pre-task bytes are stored once under their SHA-256
 *     (backups/blobs/<hash>), so names can't collide and identical content
 *     isn't stored twice; the record is saved before the file is touched,
 *     and if either fails the tool refuses to write;
 *   - after each successful write, a fingerprint (SHA-256) of what the
 *     agent wrote, so undo can tell your edits from the agent's;
 *   - a file that changed between two agent writes in the same task (you
 *     edited it mid-task) is flagged;
 *   - one manifest entry per task, under a unique id.
 *
 * Undo side:
 *   - every file is checked before any is touched: one that is exactly what
 *     the agent last wrote is restored, one already back to its original is
 *     skipped, and any conflict (edited, deleted, changed during the task, a
 *     write that never finished) changes NOTHING and keeps the checkpoint;
 *   - `--force` saves each conflicting file as <file>.conflict (never over
 *     an existing one) and then undoes;
 *   - restores are byte for byte (CRLF, BOM, binary) and atomic per file;
 *     a failure partway keeps the unrestored files for a retry;
 *   - several tasks can be undone one at a time; list() shows them;
 *   - a task still running in another live gemini-code process is skipped;
 *   - checkpoints written by 0.13.0 (no fingerprints) still load, their
 *     doubled entries merged; before undoing one, the current versions are
 *     saved to backups/before-undo-<id>-<time>/, since conflicts can't be
 *     detected for it.
 *
 * The manifest is written atomically (temp file, fsync, rename). A damaged
 * one is moved aside and reported, never read as empty — that used to wipe
 * the whole history. Backups no checkpoint refers to are deleted once over
 * an hour old; .conflict files and before-undo folders are never deleted.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BACKUP_DIR = path.join(".gemini-code-tmp", "backups");
const BLOB_DIR = path.join(BACKUP_DIR, "blobs");
const MANIFEST = path.join(BACKUP_DIR, "manifest.json");
const KEEP_TASKS = 10;
const ORPHAN_AGE_MS = 60 * 60 * 1000;

export interface FileChange {
  /** Path relative to the project root. */
  file: string;
  /** The stored original, or null when the file didn't exist before the task. */
  backup: string | null;
  /** SHA-256 of the original bytes; null = didn't exist. Absent in 0.13.0 checkpoints. */
  original?: string | null;
  /** SHA-256 of what the agent last wrote; null = the agent deleted it. Absent = never confirmed written. */
  after?: string | null;
  /** The file changed between two agent writes during the task. */
  changedDuringTask?: boolean;
}

export interface Checkpoint {
  id: string;
  task: string;
  at: string;
  changes: FileChange[];
  /** The process that made it, so another live session's running task isn't undone under it. */
  pid?: number;
  /** Format version: absent for 0.13.0. */
  v?: 2;
  /** Set when the task finished (commit); a v2 checkpoint without it is a task still running. */
  done?: boolean;
}

export type FileState = "restore" | "already-original" | "edited" | "deleted" | "changed-during-task" | "unfinished-write" | "unknown";

export interface UndoResult {
  ok: boolean;
  message: string;
  conflicts?: { file: string; state: FileState }[];
}

export class ManifestDamagedError extends Error {}

/** Test seam: throw from here to simulate a crash halfway through saving the manifest. */
export const checkpointHooks: { midManifestWrite?: () => void } = {};

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function hashOf(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file));
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Writes bytes to `file` via a temp file and rename, creating folders. */
async function atomicWrite(file: string, data: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  await rename(tmp, file).catch(async (err) => {
    await rm(tmp, { force: true });
    throw err;
  });
}

export const STATE_TEXT: Record<FileState, string> = {
  restore: "will be restored",
  "already-original": "already back to its original",
  edited: "changed since the agent wrote it",
  deleted: "deleted since the agent wrote it",
  "changed-during-task": "changed by someone else while the task ran",
  "unfinished-write": "the agent's write never finished",
  unknown: "can't tell (checkpoint from 0.13.0)",
};

export class CheckpointStore {
  private current: Checkpoint | undefined;
  private readonly root: string;
  /** Said once, after a damaged manifest was moved aside during a write. */
  notice: string | undefined;

  constructor(root = process.cwd()) {
    this.root = root;
  }

  /** Starts a new checkpoint for a task. */
  begin(task: string): void {
    this.current = {
      id: `ck_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      task: task.slice(0, 200),
      at: new Date().toISOString(),
      changes: [],
      pid: process.pid,
      v: 2,
    };
  }

  private relOf(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  private rootReal: string | undefined;

  /** The same file under any spelling (a symlink, ./, a symlinked project folder like macOS /var). */
  private async keyOf(abs: string): Promise<string> {
    this.rootReal ??= await realpath(this.root).catch(() => this.root);
    const resolved = await realpath(abs).catch(async () => {
      const dir = await realpath(path.dirname(abs)).catch(() => path.dirname(abs));
      return path.join(dir, path.basename(abs));
    });
    const rel = path.relative(this.rootReal, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
    return this.relOf(path.resolve(abs));
  }

  private async findChange(abs: string): Promise<FileChange | undefined> {
    if (!this.current) return undefined;
    const key = await this.keyOf(abs);
    return this.current.changes.find((c) => c.file === key);
  }

  /**
   * Call immediately BEFORE modifying `absPath`. Saves its pre-task bytes the
   * first time in a task; returns ok: false if that couldn't be saved, and
   * the tool must then not write.
   */
  async recordBeforeWrite(absPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.current) return { ok: true };
    const existing = await this.findChange(absPath);
    if (existing) {
      // Someone changed it between two of the agent's writes in this task.
      const now = await hashOf(absPath);
      if (existing.after !== undefined && now !== existing.after) existing.changedDuringTask = true;
      return this.persist();
    }
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: (err as Error).message };
    }
    const change: FileChange = { file: await this.keyOf(absPath), backup: null, original: null };
    if (bytes) {
      const hash = sha256(bytes);
      const blob = path.join(BLOB_DIR, hash);
      try {
        const full = path.resolve(this.root, blob);
        if ((await hashOf(full)) !== hash) await atomicWrite(full, bytes);
      } catch (err) {
        return { ok: false, error: `couldn't back up ${change.file}: ${(err as Error).message}` };
      }
      change.backup = blob.split(path.sep).join("/");
      change.original = hash;
    }
    this.current.changes.push(change);
    return this.persist();
  }

  /** Call AFTER a successful write (or delete) of `absPath`: fingerprints what the agent left there. */
  async recordAfterWrite(absPath: string): Promise<void> {
    const change = await this.findChange(absPath);
    if (!change) return;
    change.after = await hashOf(absPath);
    await this.persist();
  }

  /** Back up, write, fingerprint — refusing to write if the backup failed. Creates parent folders. */
  async writeFile(absPath: string, data: string | Buffer): Promise<void> {
    const backup = await this.recordBeforeWrite(absPath);
    if (!backup.ok) throw new Error(`not written: ${backup.error} (so /undo couldn't have restored it)`);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, data);
    await this.recordAfterWrite(absPath);
  }

  /** Finishes the current checkpoint, keeping it only if anything changed. */
  async commit(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    const all = await this.loadForWrite();
    const rest = all.filter((c) => c.id !== current.id);
    if (current.changes.length) rest.push({ ...current, done: true });
    await this.writeManifest(rest.slice(-KEEP_TASKS));
    await this.cleanOrphans(rest.slice(-KEEP_TASKS)).catch(() => undefined);
  }

  private async persist(): Promise<{ ok: boolean; error?: string }> {
    if (!this.current) return { ok: true };
    try {
      const all = (await this.loadForWrite()).filter((c) => c.id !== this.current!.id);
      all.push(this.current);
      await this.writeManifest(all.slice(-KEEP_TASKS));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `couldn't save the undo record: ${(err as Error).message}` };
    }
  }

  /** Saved checkpoints, oldest first, each with what undoing it would do per file. */
  async list(): Promise<(Checkpoint & { states: { file: string; state: FileState }[] })[]> {
    const all = await this.readManifest();
    return Promise.all(all.map(async (c) => ({ ...c, states: await Promise.all(c.changes.map(async (ch) => ({ file: ch.file, state: await this.stateOf(ch) }))) })));
  }

  private async stateOf(change: FileChange): Promise<FileState> {
    const now = await hashOf(path.resolve(this.root, change.file));
    const original = change.original !== undefined ? change.original : change.backup === null ? null : await hashOf(path.resolve(this.root, change.backup));
    if (now === original) return "already-original";
    if (change.original === undefined) return "unknown"; // 0.13.0: no fingerprint to compare with
    if (change.changedDuringTask) return "changed-during-task";
    if (change.after === undefined) return "unfinished-write";
    if (now === change.after) return "restore";
    return now === null ? "deleted" : "edited";
  }

  /** Undoes the most recent task (not one still running in another session). */
  async undoLast(opts: { force?: boolean } = {}): Promise<UndoResult> {
    let all: Checkpoint[];
    try {
      all = await this.readManifest();
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    let index = all.length - 1;
    const skipped: string[] = [];
    while (index >= 0 && this.runningElsewhere(all[index])) {
      skipped.push(all[index].task.slice(0, 40));
      index--;
    }
    const target = all[index];
    if (!target) return { ok: false, message: skipped.length ? `Nothing to undo: the latest task is still running in another session.` : "Nothing to undo." };

    const legacy = target.v !== 2;
    const states = await Promise.all(target.changes.map(async (c) => ({ change: c, state: await this.stateOf(c) })));
    const conflicts = states.filter((s) => !["restore", "already-original", "unknown"].includes(s.state));
    if (conflicts.length && !opts.force) {
      return {
        ok: false,
        conflicts: conflicts.map((c) => ({ file: c.change.file, state: c.state })),
        message:
          `Didn't undo "${target.task.slice(0, 60)}": ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} changed after the agent, ` +
          `so undoing would lose that work. Nothing was changed.\n` +
          conflicts.map((c) => `  ${c.change.file}: ${STATE_TEXT[c.state]}`).join("\n") +
          `\n/undo --force keeps each of those as <file>.conflict and then undoes everything.`,
      };
    }

    const saved: string[] = [];
    if (legacy) {
      // No fingerprints to check against: save what's there now first.
      const dir = path.join(BACKUP_DIR, `before-undo-${target.id}-${Date.now().toString(36)}`);
      for (const s of states) {
        const bytes = await readFile(path.resolve(this.root, s.change.file)).catch(() => undefined);
        if (bytes) {
          await atomicWrite(path.resolve(this.root, dir, s.change.file), bytes);
          saved.push(s.change.file);
        }
      }
      if (saved.length) saved.unshift(`current versions saved to ${dir.split(path.sep).join("/")}/`);
    }

    const conflictCopies: string[] = [];
    const restored: string[] = [];
    const removed: string[] = [];
    const failed: FileChange[] = [];
    for (const { change, state } of states) {
      if (state === "already-original") continue;
      const target = path.resolve(this.root, change.file);
      try {
        if (opts.force && conflicts.some((c) => c.change === change)) {
          const bytes = await readFile(target).catch(() => undefined);
          if (bytes) {
            let copy = `${target}.conflict`;
            for (let n = 1; await stat(copy).then(() => true, () => false); n++) copy = `${target}.conflict.${n}`;
            await atomicWrite(copy, bytes);
            conflictCopies.push(this.relOf(copy));
          }
        }
        if (change.backup === null) {
          await rm(target, { force: true });
          removed.push(change.file);
        } else {
          const bytes = await readFile(path.resolve(this.root, change.backup));
          if (change.original && sha256(bytes) !== change.original) throw new Error("its backup is damaged");
          await atomicWrite(target, bytes);
          restored.push(change.file);
        }
      } catch {
        failed.push(change);
      }
    }

    // Keep what couldn't be restored, for a retry; drop the rest.
    if (failed.length) all[index] = { ...target, changes: failed };
    else all.splice(index, 1);
    await this.writeManifest(all);

    const parts = [
      restored.length ? `restored ${restored.join(", ")}` : "",
      removed.length ? `removed ${removed.join(", ")} (created by the task)` : "",
      conflictCopies.length ? `your versions kept as ${conflictCopies.join(", ")}` : "",
      saved.length ? saved[0] : "",
      failed.length ? `FAILED on ${failed.map((f) => f.file).join(", ")} — kept for another /undo` : "",
    ].filter(Boolean);
    return { ok: failed.length === 0, message: `Undid "${target.task.slice(0, 60)}" — ${parts.join("; ") || "nothing needed changing"}.` };
  }

  /** A task another live gemini-code process hasn't finished: undoing it would pull files from under it. */
  private runningElsewhere(c: Checkpoint): boolean {
    return c.v === 2 && !c.done && !!c.pid && c.pid !== process.pid && processAlive(c.pid);
  }

  /** Reads the manifest. Old (0.13.0) array form loads, duplicates merged. A damaged file is moved aside and reported. */
  private async readManifest(): Promise<Checkpoint[]> {
    const file = path.resolve(this.root, MANIFEST);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ManifestDamagedError(`Couldn't read the undo history (${(err as Error).message}). Backups are untouched.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const aside = `${file}.damaged-${Date.now().toString(36)}`;
      await rename(file, aside).catch(() => undefined);
      throw new ManifestDamagedError(
        `The undo history was damaged (not valid JSON), so it wasn't used. It was moved to ` +
          `${path.relative(this.root, aside)}; the backups in ${BACKUP_DIR} are untouched.`
      );
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { checkpoints?: unknown }).checkpoints;
    if (!Array.isArray(list)) throw new ManifestDamagedError("The undo history has an unknown format; it was left as it is.");
    // 0.13.0 saved each task twice under one id; keep the last copy.
    const byId = new Map<string, Checkpoint>();
    for (const c of list as Checkpoint[]) {
      if (c && typeof c.id === "string" && Array.isArray(c.changes)) {
        byId.delete(c.id);
        byId.set(c.id, c);
      }
    }
    return [...byId.values()];
  }

  /** For writes: a damaged history is moved aside (by readManifest) and a fresh one started, with a notice. */
  private async loadForWrite(): Promise<Checkpoint[]> {
    try {
      return await this.readManifest();
    } catch (err) {
      this.notice = (err as Error).message;
      return [];
    }
  }

  private async writeManifest(all: Checkpoint[]): Promise<void> {
    const file = path.resolve(this.root, MANIFEST);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    const text = JSON.stringify({ version: 2, checkpoints: all }, null, 2);
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(text.slice(0, Math.floor(text.length / 2)));
      checkpointHooks.midManifestWrite?.();
      await handle.writeFile(text.slice(Math.floor(text.length / 2)));
      await handle.sync().catch(() => undefined);
    } catch (err) {
      await handle.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw err;
    }
    await handle.close();
    await rename(tmp, file);
  }

  /** Deletes stored originals no checkpoint refers to, once they're over an hour old. */
  private async cleanOrphans(kept: Checkpoint[]): Promise<void> {
    const dir = path.resolve(this.root, BLOB_DIR);
    const used = new Set(kept.flatMap((c) => c.changes.map((ch) => ch.backup && path.basename(ch.backup)).filter(Boolean)));
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (used.has(name)) continue;
      const full = path.join(dir, name);
      const info = await stat(full).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > ORPHAN_AGE_MS) await rm(full, { force: true });
    }
  }
}

/**
 * Module-level instance shared by the file tools.
 *
 * Injecting it through every tool would mean threading it through the whole
 * tool registry for one cross-cutting concern; the tools are already
 * process-global in effect (they act on process.cwd()).
 */
export const checkpoints = new CheckpointStore();
