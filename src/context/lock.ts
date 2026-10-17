import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCK = path.join(".gemini-code-tmp", "lock.json");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two gemini-code sessions in the same project would both write
 * GEMINI-PLAN.md and GEMINI.md and both take checkpoints. Not forbidden —
 * sometimes deliberate — but worth a clear warning. The lock is advisory:
 * a stale one (dead pid) is simply replaced.
 */
export function acquireInstanceLock(root = process.cwd()): { other?: { pid: number; since: string } } {
  const file = path.resolve(root, LOCK);
  let other: { pid: number; since: string } | undefined;
  try {
    if (existsSync(file)) {
      const prev = JSON.parse(readFileSync(file, "utf8")) as { pid: number; since: string };
      if (prev.pid !== process.pid && alive(prev.pid)) other = prev;
    }
  } catch {
    // unreadable lock: treat as stale
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), "utf8");
  } catch {
    // a read-only project dir: no lock, no harm
  }
  return { other };
}

export function releaseInstanceLock(root = process.cwd()): void {
  const file = path.resolve(root, LOCK);
  try {
    const cur = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
    if (cur.pid === process.pid) unlinkSync(file);
  } catch {
    // nothing to release
  }
}
