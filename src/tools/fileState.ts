/**
 * What the model has actually SEEN of each file in this session — the
 * guard behind edit_file and write_file.
 *
 * The failure this prevents is the one every prompted agent has: in a big
 * codebase the model "remembers" a file it never read in this session (or
 * read before a worker changed it) and issues an edit against text that
 * isn't there, or rewrites a file from memory and drops half of it. Claude
 * Code and OpenCode both refuse to edit a file that hasn't been read, and
 * refuse when it changed on disk since. Same here.
 */
import { stat } from "node:fs/promises";

interface Seen {
  /** mtime when it was read, or written by us. */
  mtimeMs: number;
  /** Whether every line was shown (a windowed read is still a read). */
  whole: boolean;
}

const seen = new Map<string, Seen>();

async function mtimeOf(abs: string): Promise<number | undefined> {
  try {
    return (await stat(abs)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Call after read_file returns content for `abs`. */
export async function markRead(abs: string, whole: boolean): Promise<void> {
  const mtimeMs = (await mtimeOf(abs)) ?? 0;
  const prior = seen.get(abs);
  seen.set(abs, { mtimeMs, whole: whole || (prior?.whole ?? false) && prior?.mtimeMs === mtimeMs });
}

/** Call after we wrote `abs` ourselves — the model knows its content now. */
export async function markWritten(abs: string): Promise<void> {
  seen.set(abs, { mtimeMs: (await mtimeOf(abs)) ?? 0, whole: true });
}

export type EditGate = { ok: true } | { ok: false; reason: "unread" | "stale" };

/**
 * May the model edit `abs` now? "unread" = never read this session;
 * "stale" = changed on disk since it was read (another worker, the user,
 * a build step).
 */
export async function checkEditable(abs: string): Promise<EditGate> {
  const record = seen.get(abs);
  if (!record) return { ok: false, reason: "unread" };
  const now = await mtimeOf(abs);
  if (now !== undefined && Math.abs(now - record.mtimeMs) > 1) return { ok: false, reason: "stale" };
  return { ok: true };
}

export function hasSeen(abs: string): boolean {
  return seen.has(abs);
}

/** Tests and /clear. */
export function forgetAll(): void {
  seen.clear();
}
