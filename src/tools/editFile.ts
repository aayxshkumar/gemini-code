import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";
import { checkEditable, markWritten } from "./fileState.js";
import { confirmAction, declinedMessage } from "./confirm.js";
import { checkpoints } from "../context/checkpoint.js";
import { detectEol, findSpans, nearestContext, normalizeEol, reindent } from "./matchText.js";

/** Keeps the confirmation prompt readable when a replacement is large. */
function preview(text: string, lines = 6): string {
  const parts = text.split("\n");
  const shown = parts.slice(0, lines).join("\n");
  return parts.length > lines ? `${shown}\n… (+${parts.length - lines} more lines)` : shown;
}

type EditOutcome =
  | { ok: true; text: string; count: number; how: string; firstLine: number; newLines: number }
  | { ok: false; error: string };

/** One replacement on normalized text. Touches nothing on disk. */
function applyEdit(
  rel: string,
  normalized: string,
  oldText: string,
  newText: string,
  replaceAll: boolean
): EditOutcome {
  const needle = normalizeEol(oldText);
  const replacement = normalizeEol(newText);

  const match = findSpans(normalized, needle);
  if (!match) {
    const near = nearestContext(normalized, needle);
    return {
      ok: false,
      error:
        `Error: that text isn't in ${rel}. Differences in indentation, trailing spaces and line endings are ` +
        `already ignored, so something in the characters themselves differs.` +
        (near
          ? `\n\nThe closest lines in the file are (">" marks the nearest):\n${near}\n\n` +
            `Copy the target text from there, or use write_file if the whole file needs rewriting.`
          : `\n\nRead the file and copy the target text from it.`),
    };
  }

  const occurrences = match.spans.length;
  // Refusing an ambiguous match is the whole safety property here: picking
  // "the first one" would silently edit a line the model didn't mean.
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `Error: that text appears ${occurrences} times in ${rel}, so it's ambiguous. Include more ` +
        `surrounding context to make it unique, or set replace_all: true to change every occurrence.`,
    };
  }

  // Apply back-to-front so earlier spans' offsets stay valid.
  const spans = replaceAll ? [...match.spans].reverse() : [match.spans[0]];
  let edited = normalized;
  for (const span of spans) {
    const text = match.how === "indentation" ? reindent(replacement, span.indent) : replacement;
    edited = edited.slice(0, span.start) + text + edited.slice(span.end);
  }
  // Where the first edited region lands, so the result can show it.
  const first = match.spans[0];
  const firstLine = normalized.slice(0, first.start).split("\n").length;
  const newLines = (match.how === "indentation" ? reindent(replacement, first.indent) : replacement).split("\n").length;
  return { ok: true, text: edited, count: spans.length, how: match.how, firstLine, newLines };
}

async function saveEdited(abs: string, rel: string, edited: string, eol: string): Promise<string | undefined> {
  const updated = eol === "\r\n" ? edited.replace(/\n/g, "\r\n") : edited;
  try {
    await checkpoints.writeFile(abs, updated);
    await markWritten(abs);
    return undefined;
  } catch (err) {
    return `Error writing ${rel}: ${(err as Error).message}`;
  }
}

function gateMessage(rel: string, reason: "unread" | "stale"): string {
  return reason === "unread"
    ? `Error: you haven't read ${rel} in this session, so I won't edit it from memory. Call read_file on it ` +
        `(a window around the target is enough), copy old_text from what comes back, then edit.`
    : `Error: ${rel} changed on disk after you last read it (another worker, a build step or the user). ` +
        `Read it again before editing, so old_text matches what is really there now.`;
}

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    `edit_file(args: {path: string, old_text: string, new_text: string, replace_all?: boolean}) -> replaces an exact ` +
    `piece of text in a file, leaving everything else untouched. PREFER THIS OVER write_file for changing an ` +
    `existing file: you only send the part that changes, instead of regenerating the whole file (which is slow, ` +
    `and risks silently losing any part you don't reproduce exactly). old_text must match the file's text and must ` +
    `be unique unless you set replace_all — differences in line endings, trailing spaces or indentation are ` +
    `tolerated, but nothing else is. You MUST have read the file (read_file) in this session, and re-read it if it ` +
    `changed since — the edit is refused otherwise, because old_text written from memory is the classic way to ` +
    `break a file. The result shows the edited region so you can check it landed where you meant.`,
  async run(args) {
    const rel = String(args.path ?? "");
    const oldText = String(args.old_text ?? "");
    const newText = String(args.new_text ?? "");
    const replaceAll = Boolean(args.replace_all);

    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    if (!oldText) {
      return {
        ok: false,
        output: "Error: 'old_text' is required (use write_file to create a new file).",
      };
    }
    if (oldText === newText) {
      return { ok: false, output: "Error: 'old_text' and 'new_text' are identical — nothing to do." };
    }

    const resolved = resolveInRoot(rel);
    if (!resolved.ok) {
      return { ok: false, output: outsideWorkspace("edit") };
    }
    const abs = resolved.abs;

    const gate = await checkEditable(abs);
    if (!gate.ok) return { ok: false, output: gateMessage(rel, gate.reason) };

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      return { ok: false, output: `Error reading ${rel}: ${(err as Error).message}` };
    }

    // Compare with one line-ending style throughout, then write back in the
    // file's own. Otherwise a CRLF checkout can never match text a model
    // reproduced with LF, and every edit fails no matter how correct it is.
    const eol = detectEol(content);
    const normalized = normalizeEol(content);
    const result = applyEdit(rel, normalized, oldText, newText, replaceAll);
    if (!result.ok) return { ok: false, output: result.error };

    const detail =
      `${rel} — ${replaceAll ? `${result.count} occurrence(s)` : "1 occurrence"}\n` +
      `  - ${preview(oldText).split("\n").join("\n  - ")}\n` +
      `  + ${preview(newText).split("\n").join("\n  + ")}`;
    if (!(await confirmAction("Edit file?", detail, "edit"))) {
      return { ok: false, output: declinedMessage("make this edit", "edit") };
    }

    const failure = await saveEdited(abs, rel, result.text, eol);
    if (failure) return { ok: false, output: failure };

    const delta = result.text.split("\n").length - normalized.split("\n").length;
    // Show the first edited region with a little context, as Claude Code
    // does, so a misplaced edit is visible immediately rather than three
    // tool calls later. No line numbers: this text may be copied into the
    // next old_text.
    const editedLines = result.text.split("\n");
    const from = Math.max(1, result.firstLine - 2);
    const to = Math.min(editedLines.length, result.firstLine + result.newLines - 1 + 2);
    const snippet = editedLines.slice(from - 1, to).join("\n");
    return {
      ok: true,
      output:
        `Edited ${rel} (${replaceAll ? `${result.count} replacements` : "1 replacement"}` +
        `${delta === 0 ? "" : `, ${delta > 0 ? "+" : ""}${delta} lines`}` +
        // Say when the match wasn't exact, so a wrong-looking edit is
        // traceable rather than mysterious.
        `${result.how === "exact" ? "" : `, matched ignoring ${result.how}`}).\n` +
        `Lines ${from}-${to} now read:\n${snippet}`,
    };
  },
};
