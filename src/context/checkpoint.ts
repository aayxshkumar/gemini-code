import { mkdir, copyFile, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";

const BACKUP_DIR = path.join(".gemini-code-tmp", "backups");
const MANIFEST = path.join(BACKUP_DIR, "manifest.json");

export interface FileChange {
  /** Path relative to the project root. */
  file: string;
  /** Where the original was stashed, or null when the file didn't exist before. */
  backup: string | null;
}

export interface Checkpoint {
  id: string;
  task: string;
  at: string;
  changes: FileChange[];
}

/**
 * Snapshots files before the agent overwrites them, so a task can be undone.
 *
 * This matters most with GEMINI_CODE_AUTO_APPROVE=1, where nobody is
 * eyeballing each write: a confidently wrong edit across several files is
 * otherwise unrecoverable unless the project happens to be in git with a
 * clean tree. Snapshots are per task, because "undo that last thing you
 * did" almost always means the whole task, not one of its six writes.
 */
export class CheckpointStore {
  private current: Checkpoint | undefined;
  private readonly root: string;

  constructor(root = process.cwd()) {
    this.root = root;
  }

  /** Starts a new checkpoint for a task. */
  begin(task: string): void {
    this.current = {
      id: `ck_${Date.now().toString(36)}`,
      task: task.slice(0, 200),
      at: new Date().toISOString(),
      changes: [],
    };
  }

  /**
   * Call immediately BEFORE modifying a file. Records its current state
   * (or that it didn't exist), once per file per task — the first version
   * is the one worth restoring, not the intermediate ones.
   */
  async recordBeforeWrite(absPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.current) return { ok: true };
    const rel = path.relative(this.root, absPath);
    if (this.current.changes.some((c) => c.file === rel)) return { ok: true };

    const dir = path.resolve(this.root, BACKUP_DIR);
    await mkdir(dir, { recursive: true });

    const existed = await access(absPath).then(
      () => true,
      () => false
    );

    if (!existed) {
      this.current.changes.push({ file: rel, backup: null });
    } else {
      // The position in the checkpoint keeps a/b.txt and a_b.txt apart:
      // flattened, both names were "a_b.txt" and shared one backup.
      const backupName = `${this.current.id}-${this.current.changes.length}-${rel.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const backupPath = path.join(dir, backupName);
      try {
        await copyFile(absPath, backupPath);
        this.current.changes.push({ file: rel, backup: path.relative(this.root, backupPath) });
      } catch (err) {
        // A file we can't back up is one we shouldn't claim we can restore.
        await this.persist();
        return { ok: false, error: (err as Error).message };
      }
    }
    await this.persist();
    return { ok: true };
  }

  /** Finishes the current checkpoint, keeping it only if anything changed. */
  async commit(): Promise<void> {
    if (!this.current || this.current.changes.length === 0) {
      this.current = undefined;
      return;
    }
    const all = await this.readManifest();
    all.push(this.current);
    // Keep the last 10 tasks' worth; older backups are noise.
    const kept = all.slice(-10);
    await this.writeManifest(kept);
    this.current = undefined;
  }

  private async persist(): Promise<void> {
    if (!this.current) return;
    const all = (await this.readManifest()).filter((c) => c.id !== this.current!.id);
    all.push(this.current);
    await this.writeManifest(all.slice(-10));
  }

  async list(): Promise<Checkpoint[]> {
    return this.readManifest();
  }

  /** Restores the most recent checkpoint. Returns what it did. */
  async undoLast(): Promise<{ ok: boolean; message: string }> {
    const all = await this.readManifest();
    const last = all.pop();
    if (!last) return { ok: false, message: "Nothing to undo." };

    const restored: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];

    for (const change of last.changes) {
      const target = path.resolve(this.root, change.file);
      try {
        if (change.backup === null) {
          // The file didn't exist before this task — undoing means removing it.
          await rm(target, { force: true });
          removed.push(change.file);
        } else {
          await copyFile(path.resolve(this.root, change.backup), target);
          restored.push(change.file);
        }
      } catch {
        failed.push(change.file);
      }
    }

    await this.writeManifest(all);

    const parts = [
      restored.length ? `restored ${restored.length} file(s): ${restored.join(", ")}` : "",
      removed.length ? `removed ${removed.length} newly-created file(s): ${removed.join(", ")}` : "",
      failed.length ? `FAILED on: ${failed.join(", ")}` : "",
    ].filter(Boolean);

    return {
      ok: failed.length === 0,
      message: `Undid "${last.task.slice(0, 60)}" — ${parts.join("; ") || "nothing to change"}.`,
    };
  }

  private async readManifest(): Promise<Checkpoint[]> {
    try {
      return JSON.parse(await readFile(path.resolve(this.root, MANIFEST), "utf8")) as Checkpoint[];
    } catch {
      return [];
    }
  }

  private async writeManifest(all: Checkpoint[]): Promise<void> {
    const dir = path.resolve(this.root, BACKUP_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.resolve(this.root, MANIFEST), JSON.stringify(all, null, 2), "utf8").catch(
      () => undefined
    );
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
