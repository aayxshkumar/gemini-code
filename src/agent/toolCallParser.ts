import type { ToolCall } from "../types.js";
import type { GeminiResponse } from "../driver/IGeminiDriver.js";

// Kept as a fallback in case a tool call ever survives as literal fenced
// text (e.g. a very short reply the UI doesn't wrap in a code-block
// component) — but the primary signal is response.codeBlocks, see below.
const FENCED_TOOL_RE = /```tool\s*\n([\s\S]*?)\n?```/;

export type ParseResult =
  /**
   * `call` is the first tool call in the reply; `calls` is every one found,
   * in order. A reply may carry several independent calls (one code block
   * each, or a JSON array in one block) so that reads and searches that
   * don't depend on each other cost one round trip through the web UI
   * instead of one each.
   */
  | { kind: "tool_call"; call: ToolCall; calls: ToolCall[] }
  | { kind: "final"; text: string }
  | { kind: "malformed"; raw: string; error: string };

/**
 * Every balanced {...} substring in a blob of text, parsed where possible.
 *
 * Quote-aware: a brace inside a JSON string ("{"command": "echo {}"}") must
 * not end the object. Used for the last-resort scan of prose, where Gemini
 * has written the call as a sentence instead of a code block.
 */
export function extractJsonObjects(raw: string): unknown[] {
  const found: unknown[] = [];
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      else if (!inString && ch === "{") depth++;
      else if (!inString && ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            found.push(JSON.parse(raw.slice(start, i + 1)));
          } catch {
            // Not JSON after all — keep scanning from the next brace.
          }
          start = i;
          break;
        }
      }
    }
  }
  return found;
}

/**
 * JSON.parse with the repairs a model's hand-written JSON most often needs:
 * a trailing comma before } or ], and // or /* comments. Only attempted when
 * strict parsing fails, so valid JSON is never altered.
 */
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (strictErr) {
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        repaired += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        repaired += ch;
      } else if (ch === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        repaired += "\n";
      } else if (ch === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end === -1 ? text.length : end + 1;
      } else {
        repaired += ch;
      }
    }
    repaired = repaired.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(repaired);
    } catch {
      throw strictErr;
    }
  }
}

/**
 * Finds the first balanced {...} or [...] substring and parses it, ignoring
 * any surrounding text (a stray "json" label, say).
 */
function extractJsonObject(raw: string): unknown {
  const start = raw.search(/[{[]/);
  if (start === -1) throw new Error("no '{' found");
  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return parseLenientJson(raw.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced braces");
}

const ARG_KEYS = ["args", "arguments", "parameters", "params", "input"] as const;
/** Keys a model uses for the tool's name when it forgets it's `name`. */
const NAME_KEYS = ["name", "tool", "tool_name", "function", "action"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The canonical shape is {name, args}. Gemini also drifts into two others:
 * `arguments`/`parameters` instead of `args`, and args flattened next to
 * `name` ({"name": "search_code", "pattern": "x"}). A real run lost a whole
 * worker to the flat form — it was read as prose, so the worker's "final
 * answer" was a tool call it never got to make.
 *
 * The drifted shapes are only accepted for a name that IS a tool, because
 * {"name": ...} is also what package.json and plenty of other JSON look like.
 */
function asToolCall(parsed: unknown, knownTools?: ReadonlySet<string>): ToolCall | undefined {
  if (!isPlainObject(parsed)) return undefined;
  // OpenAI-style nesting: {"function": {"name": ..., "arguments": {...}}}
  if (isPlainObject(parsed.function) && typeof parsed.function.name === "string") {
    return asToolCall(parsed.function, knownTools);
  }
  if (typeof parsed.name === "string") {
    const name = parsed.name;
    if (isPlainObject(parsed.args)) return { name, args: parsed.args };
    if (!knownTools?.has(name)) return undefined;
    for (const key of ARG_KEYS) {
      if (isPlainObject(parsed[key])) return { name, args: parsed[key] as Record<string, unknown> };
    }
    const { name: _name, ...rest } = parsed;
    return { name, args: rest };
  }
  // The name under another key is only trusted when it IS a tool.
  if (!knownTools?.size) return undefined;
  const nameKey = NAME_KEYS.find((k) => typeof parsed[k] === "string" && knownTools.has(parsed[k] as string));
  if (!nameKey) return undefined;
  const name = parsed[nameKey] as string;
  for (const key of ARG_KEYS) {
    if (isPlainObject(parsed[key])) return { name, args: parsed[key] as Record<string, unknown> };
  }
  const { [nameKey]: _n, ...rest } = parsed;
  return { name, args: rest };
}

/** One candidate block may hold one call, or an array of them. */
function toolCallsIn(parsed: unknown, knownTools?: ReadonlySet<string>): ToolCall[] {
  if (Array.isArray(parsed)) {
    const calls = parsed.map((p) => asToolCall(p, knownTools));
    // All or nothing: a list that is only partly tool calls is not a batch.
    return calls.every((c): c is ToolCall => !!c) ? calls : [];
  }
  const one = asToolCall(parsed, knownTools);
  return one ? [one] : [];
}

/**
 * Looks for a tool call in a Gemini reply.
 *
 * Gemini's web UI renders markdown into HTML before we ever read it, so the
 * ```tool fence we ask for in the prompt does NOT survive as literal
 * backtick text — only the *content* of the resulting rendered code block
 * does (see GeminiResponse's doc comment). So the real signal is "is there
 * a code block whose content is JSON shaped like {name, args}", not the
 * fence markers themselves. `response.codeBlocks` carries exactly that.
 */
export function parseGeminiReply(response: GeminiResponse, knownTools?: ReadonlySet<string>): ParseResult {
  const candidates = [...response.codeBlocks];
  const fencedMatch = response.text.match(FENCED_TOOL_RE);
  if (fencedMatch) candidates.unshift(fencedMatch[1].trim());

  // Every code block that holds a valid call is collected, so a reply with
  // several independent calls runs them all in one turn.
  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    try {
      calls.push(...toolCallsIn(extractJsonObject(candidate), knownTools));
    } catch {
      // Not this candidate — try the next one, or fall through below.
    }
  }
  if (calls.length) return { kind: "tool_call", call: calls[0], calls };

  // Last resort: the call written as prose rather than as a code block
  // ("I'll call {"name": "read_file", "args": {"path": "x"}} now"). The UI
  // renders that as ordinary text, so codeBlocks is empty and the loop used
  // to accept the whole thing as a finished answer and stop. Only accepted
  // for a name that IS a tool, so prose that merely contains JSON stays prose.
  if (knownTools?.size) {
    const inProse: ToolCall[] = [];
    for (const candidate of extractJsonObjects(response.text)) {
      const call = asToolCall(candidate, knownTools);
      if (call && knownTools.has(call.name)) inProse.push(call);
    }
    if (inProse.length) return { kind: "tool_call", call: inProse[0], calls: inProse };
  }

  // No valid tool call found, but if something looks like an attempt at one
  // (has the shape of our tool-call JSON without being valid/complete),
  // treat it as malformed so the loop asks Gemini to retry, rather than
  // silently accepting broken JSON as a final answer.
  const namesKnownTool = (c: string) =>
    [...(knownTools ?? [])].some((t) => new RegExp(`"name"\\s*:\\s*"${t}"`).test(c));
  const attempted = candidates.find((c) => (/"name"\s*:/.test(c) && /"args"\s*:/.test(c)) || namesKnownTool(c));
  if (attempted) {
    return {
      kind: "malformed",
      raw: attempted,
      error: 'Found something shaped like a tool call, but it was not valid {"name": ..., "args": ...} JSON.',
    };
  }

  return { kind: "final", text: response.text.trim() };
}

/**
 * Detects a reply that MEANT to do work but didn't issue a tool call.
 *
 * In long threads Gemini drifts off the protocol — the primer is far back
 * in a context the web UI silently truncates — and starts answering like a
 * chatbot: "Sure, I'll create that file:" followed by the file contents in
 * a code block. The parser can't tell that from a genuine final answer, so
 * the loop ends and nothing happens, which looks exactly like the app
 * ignoring the reply.
 *
 * The tell is not the code block on its own (a real answer may quote code)
 * but code plus language announcing an action the agent was supposed to
 * perform with a tool.
 */
export function looksLikeAbandonedWork(response: GeminiResponse): boolean {
  const text = response.text;
  if (response.codeBlocks.length > 0) {
    return /\b(i'?ll |i will |let me |i'?m going to |here'?s the (code|file|script)|you can (run|save|copy)|create the file|save (this|it) (to|as)|add the following)/i.test(
      text
    );
  }

  // Prose with no code at all can abandon the work just as completely, in two
  // ways seen in real threads: asking permission to start ("Would you like me
  // to proceed?") and narrating an action as if it had happened ("I'll now
  // update the file"). Both end the task having changed nothing. Asking is
  // pointless here — approval is the user's y/N gate, not Gemini's to seek.
  return /\b(would you like me to|shall i|do you want me to|let me know (if|when|whether)|if you'?d like,? i can|i can (do|make|create|write|implement) (that|this|it)|say the word)\b/i.test(
    text
  ) || /\b(i'?ll |i will |let me |i'?m going to )(now )?(create|write|update|edit|modify|add|run|execute|fix|implement|start|begin)\b/i.test(
    text
  );
}

/**
 * Detects a PROGRESS REPORT masquerading as a final answer.
 *
 * Seen in a real migration: after a tool result, Gemini replied
 * "The migration of ClientApp to Vue 3 is underway. 1. Package
 * Architecture — Dependencies Updated…" with no code block and no tool
 * call. Nothing in the reply is wrong; it simply isn't finished. The
 * parser had no way to tell that from a completed answer, so the loop
 * ended mid-migration.
 *
 * Keyed on language that describes work still in flight. Deliberately does
 * NOT fire on completion words ("completed", "done", "finished"), so a
 * genuine summary of what was accomplished still ends the task.
 */
export function looksUnfinished(response: GeminiResponse): boolean {
  const text = response.text;
  if (!text.trim()) return false;

  // An explicit statement of completion wins — it's the model's clearest
  // signal that it considers the work done.
  if (/\b(is|are|has been|have been) (now )?(complete|completed|finished|done)\b|\ball (steps|tasks|files) (are )?(complete|done)\b|\bsuccessfully (completed|finished|implemented)\b/i.test(text)) {
    return false;
  }

  return /\b(is|are) (currently )?(underway|in progress|ongoing)\b|\bnext steps?\b|\bi('| a)?m going to (now )?\b|\bi will (now |next )?(continue|proceed|start|begin|update|create|modify|verify|check|confirm)\b|\b(remaining|still (need|to do|pending))\b|\blet me (now )?(continue|proceed)\b|\bso far[,:]/i.test(
    text
  ) ||
    // Hedged investigation: the model names a place it hasn't looked at and
    // promises to look. "Let's look at X" / "(or the config module)" / "I
    // would need to verify" is an answer that stopped before the evidence.
    /\blet'?s (look|check|verify|see|examine|inspect)\b|\bi (would |will |should )?need to (verify|check|confirm|look)\b|\b(not|un)(?: yet)? ?(verified|confirmed)\b|\blikely (located|defined|in)\b|\bprobably (in|at|defined)\b|\(or (the|a|an) [^)]{3,60}\)/i.test(
      text
    );
}

/**
 * Gemini's OWN failure replies — the web UI answers these when a turn fails
 * on Google's side (overload, a too-large message, a filtered response).
 * They are not the model's answer to the task, so the loop must retry the
 * turn rather than hand them to the user as a result. Kept to short, exact
 * phrasings so a genuine answer that mentions an error isn't mistaken.
 */
export function looksLikeGeminiError(response: GeminiResponse): boolean {
  const text = response.text.trim();
  if (!text || text.length > 300 || response.codeBlocks.length) return false;
  return /^(I encountered an error doing what you asked|Something went wrong|An internal error (has )?occurred|I'?m (currently )?(unable|not able) to (help|respond|process)[^.]*\. ?(Please )?try again|Sorry, something went wrong|I can'?t (help|do that) right now|You'?ve reached your (daily |hourly )?(limit|quota)|You have reached (your|the) (limit|quota))/i.test(
    text
  );
}

/**
 * The model says it can't see a file we attached. Uploads land most of the
 * time, but a long thread sometimes loses the chip or the model answers
 * before the attachment is processed; either way the right move is to
 * resend the content inline, not to argue.
 */
export function looksLikeUnseenAttachment(response: GeminiResponse): boolean {
  const text = response.text.trim();
  if (!text || text.length > 600 || response.codeBlocks.length) return false;
  return /\b(can'?t|cannot|unable to|don'?t|do not|couldn'?t) (seem to )?(see|find|access|open|locate|view|read) (the |an |any |your )?(attach|file|document|upload|context\.md)/i.test(
    text
  ) || /\bno (file|attachment|document) (was|is|has been) (attached|provided|uploaded|included)\b/i.test(text) ||
    /\b(please|could you) (re-?)?(attach|upload|share|provide) (the|that|it|a) /i.test(text);
}
