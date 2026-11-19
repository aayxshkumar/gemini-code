/**
 * multi_edit: several edits across one or more files, applied all or nothing.
 *
 * The failure it exists for: a rename across files done as separate
 * edit_file calls, where the fourth fails and the project is left
 * half-edited. Here:
 *
 *   1. Everything is checked before anything is touched — workspace,
 *      read-before-edit, changed-on-disk, writable, valid UTF-8, and every
 *      old_text with edit_file's tolerant matching and ambiguity refusal.
 *      All problems are reported together.
 *   2. Every old_text is matched against the file AS READ, never against
 *      another edit's output, so the order of edits doesn't matter. Two
 *      edits whose matched regions overlap are refused, and so is an edit
 *      that only matches text another edit produces (merge them instead).
 *      Edits that merely touch (one ends where the next starts) are fine.
 *   3. One confirmation lists every edit in every file.
 *   4. After the answer, under a process-wide lock, each file is re-read and
 *      compared byte for byte with what was planned against; a file that
 *      changed while the question was open is not overwritten.
 *   5. Every file is backed up for /undo first; if a backup fails, nothing
 *      is written. New contents go to a flushed temp file beside each
 *      original, then are renamed over it. If a rename fails partway, the
 *      files already replaced are put back from their original bytes
 *      (timestamps too), and the result says exactly what state each is in.
 */
import { randomBytes } from "node:crypto";
import { access, chmod, open, readFile, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";
import { checkEditable, markWritten } from "./fileState.js";
import { confirmAction, declinedMessage } from "./confirm.js";
import { checkpoints } from "../context/checkpoint.js";
import { detectEol, findSpans, nearestContext, normalizeEol, reindent } from "./matchText.js";
import { displayPath } from "../workspace.js";

export const MAX_EDITS = 100;

interface EditInput {
  index: number; // 1-based, as the model numbered them
  path: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

interface PlannedFile {
  abs: string;
  rel: string;
  original: Buffer;
  eol: "\r\n" | "\n";
  updated: string;
  edits: { index: number; count: number; how: string; firstLine: number }[];
}

/**
 * Test seams: inject a failure at a step of the write, so the rollback
 * paths can be exercised without a broken disk. Never set outside tests.
 */
export const multiEditHooks: {
  beforeStage?: (abs: string, i: number) => void | Promise<void>;
  beforeRename?: (abs: string, i: number) => void | Promise<void>;
  beforeRestore?: (abs: string) => void | Promise<void>;
  afterConfirm?: () => void | Promise<void>;
} = {};

/** Serializes the re-check-and-write phase, so parallel workers' multi_edits can't interleave. */
let writeLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.catch(() => undefined);
  return run;
}

function parseEdits(args: Record<string, unknown>): { edits: EditInput[] } | { error: string } {
  const top = typeof args.path === "string" ? args.path : undefined;
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return { error: "Error: 'edits' must be a non-empty array of {path, old_text, new_text, replace_all?}." };
  }
  if (args.edits.length > MAX_EDITS) return { error: `Error: at most ${MAX_EDITS} edits in one multi_edit.` };
  const edits: EditInput[] = [];
  for (const [i, raw] of args.edits.entries()) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const p = typeof e.path === "string" && e.path ? e.path : top;
    if (!p) return { error: `Error in edit ${i + 1}: 'path' is required (each edit names its own file).` };
    const oldText = typeof e.old_text === "string" ? e.old_text : "";
    if (!oldText) return { error: `Error in edit ${i + 1}: 'old_text' is required (multi_edit changes existing text; use write_file for new files).` };
    const newText = typeof e.new_text === "string" ? e.new_text : "";
    if (oldText === newText) return { error: `Error in edit ${i + 1}: old_text and new_text are identical.` };
    edits.push({ index: i + 1, path: p, oldText, newText, replaceAll: Boolean(e.replace_all) });
  }
  return { edits };
}

const validUtf8 = (buf: Buffer) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
};

/**
 * Plans one file's edits against its text as read. Returns the new text or
 * every problem found. Exported for the tests.
 */
export function planFile(
  rel: string,
  normalized: string,
  edits: Pick<EditInput, "index" | "oldText" | "newText" | "replaceAll">[]
): { ok: true; text: string; edits: PlannedFile["edits"] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const regions: { index: number; start: number; end: number; text: string }[] = [];
  const results: PlannedFile["edits"] = [];

  for (const e of edits) {
    const needle = normalizeEol(e.oldText);
    const replacement = normalizeEol(e.newText);
    const match = findSpans(normalized, needle);
    if (!match) {
      // Would it match after another edit in the batch? Then it depends on
      // that edit's output, which multi_edit doesn't chain — say so.
      const producer = edits.find((o) => o !== e && normalizeEol(o.newText).includes(needle.trim()) && needle.trim());
      if (producer) {
        problems.push(
          `Edit ${e.index} (${rel}): its old_text only appears in edit ${producer.index}'s new_text. Edits are matched ` +
            `against the file as it is now, not against each other's results — merge the two into one edit.`
        );
        continue;
      }
      const near = nearestContext(normalized, needle);
      problems.push(
        `Edit ${e.index} (${rel}): old_text isn't in the file. Line endings, trailing spaces and indentation are ` +
          `already tolerated, so the characters themselves differ.` +
          (near ? `\nThe closest lines (">" marks the nearest):\n${near}` : " Read the file and copy the text from it.")
      );
      continue;
    }
    if (match.spans.length > 1 && !e.replaceAll) {
      problems.push(
        `Edit ${e.index} (${rel}): old_text appears ${match.spans.length} times. Add surrounding context to make it ` +
          `unique, or set replace_all: true.`
      );
      continue;
    }
    const spans = e.replaceAll ? match.spans : [match.spans[0]];
    for (const span of spans) {
      const text = match.how === "indentation" ? reindent(replacement, span.indent) : replacement;
      regions.push({ index: e.index, start: span.start, end: span.end, text });
    }
    results.push({
      index: e.index,
      count: spans.length,
      how: match.how,
      firstLine: normalized.slice(0, spans[0].start).split("\n").length,
    });
  }

  // Overlap: two regions sharing at least one character, or two edits of
  // the same empty position. Touching (a.end === b.start) is allowed.
  regions.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < regions.length; i++) {
    const prev = regions[i - 1];
    const cur = regions[i];
    if (cur.start < prev.end || (cur.start === prev.start && cur.end === prev.end)) {
      if (prev.index === cur.index) continue; // replace_all spans of one edit never overlap themselves
      const line = normalized.slice(0, cur.start).split("\n").length;
      const msg =
        `Edits ${Math.min(prev.index, cur.index)} and ${Math.max(prev.index, cur.index)} (${rel}) overlap around line ${line}. ` +
        `Combine them into one edit covering both changes.`;
      if (!problems.includes(msg)) problems.push(msg);
    }
  }
  if (problems.length) return { ok: false, problems };

  let text = normalized;
  for (const r of [...regions].reverse()) text = text.slice(0, r.start) + r.text + text.slice(r.end);
  return { ok: true, text, edits: results.sort((a, b) => a.index - b.index) };
}

function preview(text: string, lines = 4): string {
  const parts = text.split("\n");
  return parts.slice(0, lines).join("\n") + (parts.length > lines ? `\n… (+${parts.length - lines} more lines)` : "");
}

async function syncedWrite(file: string, data: Buffer | string, mode?: number): Promise<void> {
  const handle = await open(file, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

export const multiEditTool: ToolDefinition = {
  name: "multi_edit",
  description:
    `multi_edit(args: {edits: [{path: string, old_text: string, new_text: string, replace_all?: boolean}]}) -> makes ` +
    `several edits across one or more existing files ALL OR NOTHING: if any edit fails to match, is ambiguous, or ` +
    `overlaps another, no file is changed and every problem is reported. Use it for a rename or an API change that ` +
    `touches several places, instead of a run of edit_file calls that can leave the project half-edited. Every ` +
    `old_text is matched against the file as it is now (not against other edits' results), so order doesn't matter ` +
    `and two edits must not touch the same text. Same tolerant matching and read-before-edit rule as edit_file.`,
  async run(args) {
    const parsed = parseEdits(args);
    if ("error" in parsed) return { ok: false, output: parsed.error };

    // Group by real file, so two spellings of one path (or a symlink) are one file.
    const byFile = new Map<string, { abs: string; rel: string; edits: EditInput[] }>();
    const problems: string[] = [];
    for (const e of parsed.edits) {
      const resolved = resolveInRoot(e.path);
      if (!resolved.ok) {
        problems.push(`Edit ${e.index}: ${outsideWorkspace("edit")}`);
        continue;
      }
      const key = await realpath(resolved.abs).catch(() => resolved.abs);
      const entry = byFile.get(key) ?? { abs: resolved.abs, rel: displayPath(resolved.abs), edits: [] };
      entry.edits.push(e);
      byFile.set(key, entry);
    }

    const planned: PlannedFile[] = [];
    for (const { abs, rel, edits } of byFile.values()) {
      const which = edits.map((e) => e.index).join(", ");
      const info = await stat(abs).catch(() => undefined);
      if (!info) {
        problems.push(`Edit ${which} (${rel}): the file doesn't exist. multi_edit only changes existing files; create new ones with write_file.`);
        continue;
      }
      if (!info.isFile()) {
        problems.push(`Edit ${which} (${rel}): not a regular file.`);
        continue;
      }
      const gate = await checkEditable(abs);
      if (!gate.ok) {
        problems.push(
          gate.reason === "unread"
            ? `Edit ${which} (${rel}): you haven't read this file in this session. read_file it first, then copy old_text from what you read.`
            : `Edit ${which} (${rel}): the file changed on disk after you read it. Read it again.`
        );
        continue;
      }
      if (!(await access(abs, fsConstants.W_OK).then(() => true, () => false))) {
        problems.push(`Edit ${which} (${rel}): the file is read-only.`);
        continue;
      }
      const original = await readFile(abs);
      if (!validUtf8(original)) {
        problems.push(`Edit ${which} (${rel}): not valid UTF-8 text, so it isn't edited as text.`);
        continue;
      }
      const content = original.toString("utf8");
      const plan = planFile(rel, normalizeEol(content), edits);
      if (!plan.ok) {
        problems.push(...plan.problems);
        continue;
      }
      planned.push({ abs, rel, original, eol: detectEol(content), updated: plan.text, edits: plan.edits });
    }

    if (problems.length) {
      return {
        ok: false,
        output:
          `multi_edit changed nothing: ${problems.length} problem${problems.length === 1 ? "" : "s"} in ` +
          `${parsed.edits.length} edit${parsed.edits.length === 1 ? "" : "s"}.\n\n${problems.join("\n\n")}`,
      };
    }

    const detail = planned
      .map((f) => {
        const lines = parsed.edits
          .filter((e) => f.edits.some((p) => p.index === e.index))
          .map(
            (e) =>
              `  [${e.index}]${e.replaceAll ? " (every occurrence)" : ""}\n` +
              `    - ${preview(e.oldText).split("\n").join("\n    - ")}\n` +
              `    + ${preview(e.newText).split("\n").join("\n    + ")}`
          );
        return `${f.rel}\n${lines.join("\n")}`;
      })
      .join("\n");
    const summary = `${parsed.edits.length} edit${parsed.edits.length === 1 ? "" : "s"} in ${planned.length} file${planned.length === 1 ? "" : "s"}`;
    if (!(await confirmAction(`Apply ${summary}?`, detail, "edit"))) {
      return { ok: false, output: declinedMessage(`apply these ${summary}`, "edit") };
    }
    await multiEditHooks.afterConfirm?.();

    return withLock(async () => {
      // Changed while the question was open? Then the plan is stale.
      for (const f of planned) {
        const now = await readFile(f.abs).catch(() => undefined);
        if (!now || !now.equals(f.original)) {
          return {
            ok: false,
            output: `multi_edit changed nothing: ${f.rel} changed on disk while the edits waited for approval. Read it again and redo the edits.`,
          };
        }
      }

      // Backups for /undo, all before the first write.
      for (const f of planned) {
        const backup = await checkpoints.recordBeforeWrite(f.abs);
        if (!backup.ok) {
          return { ok: false, output: `multi_edit changed nothing: couldn't back up ${f.rel} for /undo (${backup.error}).` };
        }
      }

      // Stage every new version beside its original.
      const staged: { file: PlannedFile; tmp: string; mode: number; atime: Date; mtime: Date }[] = [];
      const cleanup = async () => Promise.all(staged.map((s) => rm(s.tmp, { force: true }).catch(() => undefined)));
      try {
        for (const [i, f] of planned.entries()) {
          await multiEditHooks.beforeStage?.(f.abs, i);
          const info = await stat(f.abs);
          const tmp = path.join(path.dirname(f.abs), `.gemini-code-${randomBytes(6).toString("hex")}.tmp`);
          const data = f.eol === "\r\n" ? f.updated.replace(/\n/g, "\r\n") : f.updated;
          staged.push({ file: f, tmp, mode: info.mode & 0o7777, atime: info.atime, mtime: info.mtime });
          await syncedWrite(tmp, data, info.mode & 0o7777);
          await chmod(tmp, info.mode & 0o7777).catch(() => undefined);
        }
      } catch (err) {
        await cleanup();
        return { ok: false, output: `multi_edit changed nothing: couldn't prepare the new files (${(err as Error).message}).` };
      }

      // Swap them in. A failure partway puts back what was already replaced.
      const replaced: typeof staged = [];
      try {
        for (const [i, s] of staged.entries()) {
          await multiEditHooks.beforeRename?.(s.file.abs, i);
          await rename(s.tmp, s.file.abs);
          replaced.push(s);
        }
      } catch (err) {
        const states: string[] = [];
        for (const s of replaced) {
          try {
            await multiEditHooks.beforeRestore?.(s.file.abs);
            await syncedWrite(s.file.abs, s.file.original, s.mode);
            await utimes(s.file.abs, s.atime, s.mtime).catch(() => undefined);
            states.push(`${s.file.rel}: restored to its original content`);
          } catch (restoreErr) {
            states.push(`${s.file.rel}: STILL HAS THE NEW CONTENT — couldn't restore it (${(restoreErr as Error).message}); /undo has its backup`);
          }
        }
        for (const s of staged.slice(replaced.length)) states.push(`${s.file.rel}: unchanged`);
        await Promise.all(staged.slice(replaced.length).map((s) => rm(s.tmp, { force: true }).catch(() => undefined)));
        return {
          ok: false,
          output: `multi_edit failed while writing (${(err as Error).message}), and was rolled back:\n${states.map((l) => `  ${l}`).join("\n")}`,
        };
      }

      for (const f of planned) {
        await checkpoints.recordAfterWrite(f.abs);
        await markWritten(f.abs);
      }
      const lines = planned.map((f) => {
        const total = f.edits.reduce((n, e) => n + e.count, 0);
        const fuzzy = f.edits.filter((e) => e.how !== "exact").map((e) => `edit ${e.index} matched ignoring ${e.how}`);
        return `  ${f.rel}: ${total} replacement${total === 1 ? "" : "s"} (from line ${Math.min(...f.edits.map((e) => e.firstLine))})${fuzzy.length ? `; ${fuzzy.join(", ")}` : ""}`;
      });
      return { ok: true, output: `Applied ${summary}:\n${lines.join("\n")}\n/undo reverts all of it together.` };
    });
  },
};

