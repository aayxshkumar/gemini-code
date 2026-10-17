/**
 * The OpenAI chat-completions protocol, mapped onto a Gemini web thread.
 *
 * Everything here is pure — no browser, no HTTP — so the mapping can be tested
 * on its own. The mismatch it bridges:
 *
 *  - The API is stateless: every request carries the whole conversation. A
 *    Gemini tab is stateful: it remembers its thread. So a request either
 *    CONTINUES a tab whose thread is exactly the start of this conversation
 *    (send only what's new), or starts a fresh thread with the conversation
 *    folded into one prompt.
 *  - The API has native function calling. Gemini web does not, so tools are
 *    described in the prompt and the reply is parsed back into tool_calls —
 *    the same prompted-protocol idea the agent itself runs on.
 */
import { randomBytes } from "node:crypto";
import { extractJsonObjects } from "../agent/toolCallParser.js";
import { resolveModel, DEFAULT_MODEL_ALIAS, MODELS } from "../driver/models.js";

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: string | { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content?: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export type ToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: ToolSpec[];
  tool_choice?: ToolChoice;
}

// --- validation -------------------------------------------------------------

const ROLES = new Set<Role>(["system", "developer", "user", "assistant", "tool"]);

/** Returns an error message, or undefined when the request is usable. */
export function validateRequest(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  const req = body as ChatRequest;
  if (!Array.isArray(req.messages) || req.messages.length === 0) return "'messages' must be a non-empty array.";
  for (const [i, m] of req.messages.entries()) {
    if (!m || typeof m !== "object") return `messages[${i}] must be an object.`;
    if (!ROLES.has(m.role)) return `messages[${i}].role "${String(m.role)}" is not supported.`;
  }
  const last = req.messages[req.messages.length - 1];
  if (last.role === "assistant") {
    // Prefilling an assistant turn has no equivalent in the web UI.
    return "The last message must not be from the assistant — there is nothing to reply to.";
  }
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) return "'tools' must be an array.";
    for (const [i, t] of req.tools.entries()) {
      if (t?.type !== "function" || typeof t.function?.name !== "string") {
        return `tools[${i}] must be {"type": "function", "function": {"name": ...}}.`;
      }
    }
  }
  return undefined;
}

// --- models -----------------------------------------------------------------

/** Model ids advertised on /v1/models: one per picker entry. */
export const API_MODELS = MODELS.map((m) => ({
  id: `gemini-web-${m.name.toLowerCase()}`,
  alias: m.aliases[0],
  name: m.name,
}));

/**
 * Maps whatever a client sends as `model` to a picker alias.
 *
 * Lenient on purpose: plenty of clients hard-code "gpt-4o" or similar, and
 * refusing them would make "point your app at this" fail for no benefit.
 * Anything unrecognised gets the default model.
 */
export function modelAliasFor(requested: string | undefined): string {
  if (!requested) return DEFAULT_MODEL_ALIAS;
  const stripped = requested.trim().toLowerCase().replace(/^gemini-web-/, "").replace(/^gemini-/, "");
  const match = resolveModel(stripped);
  if (match) return match.aliases[0];
  // Real Gemini API names carry versions ("gemini-2.5-pro",
  // "gemini-2.0-flash-lite"); pick by the family word inside them. Lite
  // before flash, since "flash-lite" contains both.
  const byKeyword = MODELS.find((m) => m.matches(stripped));
  return byKeyword ? byKeyword.aliases[0] : DEFAULT_MODEL_ALIAS;
}

// --- content ----------------------------------------------------------------

export function textOf(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

export function imagesOf(content: ChatMessage["content"]): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => p?.type === "image_url")
    .map((p) => {
      const img = (p as { image_url: string | { url: string } }).image_url;
      return typeof img === "string" ? img : img?.url;
    })
    .filter((u): u is string => typeof u === "string" && u.length > 0);
}

// --- prompts ----------------------------------------------------------------

function toolsInstructions(tools: ToolSpec[], choice: ToolChoice | undefined): string {
  const specs = tools
    .map((t) => {
      const f = t.function;
      return (
        `- ${f.name}${f.description ? `: ${f.description}` : ""}\n` +
        `  parameters (JSON Schema): ${JSON.stringify(f.parameters ?? { type: "object", properties: {} })}`
      );
    })
    .join("\n");

  let rule = "Call a function only when it is needed to answer; otherwise answer normally.";
  if (choice === "required") rule = "You MUST call at least one function in this reply.";
  else if (typeof choice === "object" && choice?.function?.name) {
    rule = `You MUST call the function "${choice.function.name}" in this reply.`;
  }

  return (
    `You can call these functions:\n${specs}\n\n` +
    `To call functions, reply with ONLY a code block containing JSON in exactly this shape, and nothing else:\n` +
    `{"tool_calls": [{"name": "<function name>", "arguments": { ... }}]}\n` +
    `You may put several calls in the list. The results will be sent back to you, and then you continue. ` +
    rule
  );
}

function describeToolCalls(calls: ToolCall[]): string {
  return calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(", ");
}

/** One message rendered as a transcript entry. */
function transcriptLine(m: ChatMessage): string {
  const text = textOf(m.content).trim();
  const images = imagesOf(m.content).length;
  const imageNote = images ? ` [${images} image${images > 1 ? "s" : ""} attached]` : "";
  switch (m.role) {
    case "user":
      return `User: ${text}${imageNote}`;
    case "assistant":
      return m.tool_calls?.length
        ? `Assistant: [called ${describeToolCalls(m.tool_calls)}]${text ? ` ${text}` : ""}`
        : `Assistant: ${text}`;
    case "tool":
      return `Function result${m.tool_call_id ? ` (${m.tool_call_id})` : ""}: ${text}`;
    default:
      return `${text}`;
  }
}

/** A message sent as-is into an ongoing thread (continuation). */
function deltaLine(m: ChatMessage): string {
  const text = textOf(m.content).trim();
  if (m.role === "tool") return `Function result${m.tool_call_id ? ` (${m.tool_call_id})` : ""}:\n${text}`;
  if (m.role === "system" || m.role === "developer") return `Updated instructions:\n${text}`;
  return text;
}

/**
 * The whole conversation as the first message of a fresh thread.
 *
 * The common case — optional system prompt plus one user message — is sent
 * as plain text, not as a transcript: framing a single question as "User:
 * ..." makes answers stiffer for no gain.
 */
export function buildFreshPrompt(req: ChatRequest): string {
  const system = req.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const turns = req.messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const useTools = !!req.tools?.length && req.tool_choice !== "none";

  const parts: string[] = [];
  if (system) parts.push(`Follow these instructions for this whole conversation:\n${system}`);
  if (useTools) parts.push(toolsInstructions(req.tools!, req.tool_choice));

  if (turns.length === 1 && turns[0].role === "user") {
    parts.push(textOf(turns[0].content).trim());
  } else {
    parts.push(
      `Here is the conversation so far:\n\n${turns.map(transcriptLine).join("\n\n")}\n\n` +
        `Reply to the last message as the Assistant. Write only the reply itself, without an "Assistant:" prefix.`
    );
  }
  return parts.join("\n\n---\n\n");
}

/** Only the messages that are new since the thread's last reply. */
export function buildContinuationPrompt(newMessages: ChatMessage[]): string {
  return newMessages.map(deltaLine).filter(Boolean).join("\n\n");
}

// --- continuation matching -------------------------------------------------

function messageKey(m: ChatMessage): string {
  return JSON.stringify([
    m.role === "developer" ? "system" : m.role,
    textOf(m.content).trim(),
    imagesOf(m.content).length,
    (m.tool_calls ?? []).map((c) => [c.function?.name, c.function?.arguments]),
    m.tool_call_id ?? "",
  ]);
}

/**
 * If `history` (what a tab's thread already holds) is exactly the start of
 * `messages`, returns the messages that come after it; otherwise undefined.
 *
 * The new tail must contain no assistant turns: those would mean the client
 * rewrote the conversation, and the tab's thread no longer matches it.
 */
export function continuationOf(history: ChatMessage[], messages: ChatMessage[]): ChatMessage[] | undefined {
  if (history.length === 0 || messages.length <= history.length) return undefined;
  for (let i = 0; i < history.length; i++) {
    if (messageKey(history[i]) !== messageKey(messages[i])) return undefined;
  }
  const tail = messages.slice(history.length);
  if (tail.some((m) => m.role === "assistant")) return undefined;
  return tail;
}

/** Identifies a tool set, so a thread primed with one set isn't reused for another. */
export function toolsKey(req: ChatRequest): string {
  if (!req.tools?.length || req.tool_choice === "none") return "";
  return JSON.stringify(req.tools.map((t) => [t.function.name, t.function.parameters ?? null]));
}

// --- replies ----------------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

/**
 * Pulls function calls out of a reply, if it made any.
 *
 * Accepts the shape we asked for ({"tool_calls": [...]}) and the shapes models
 * drift into: a single {"name", "arguments"} object, or "args"/"parameters"
 * instead of "arguments". Only names the client actually offered count, so a
 * JSON example in an ordinary answer stays an answer.
 */
export function parseToolCalls(
  reply: { text: string; codeBlocks: string[] },
  tools: ToolSpec[]
): ToolCall[] | undefined {
  const names = new Set(tools.map((t) => t.function.name));
  const sources = [...reply.codeBlocks, reply.text];

  for (const source of sources) {
    for (const obj of extractJsonObjects(source)) {
      const calls = toCalls(obj, names);
      if (calls.length) return calls;
    }
  }
  return undefined;
}

function toCalls(obj: unknown, names: Set<string>): ToolCall[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const list = Array.isArray(o.tool_calls) ? o.tool_calls : typeof o.name === "string" ? [o] : [];
  const calls: ToolCall[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    // Also tolerate the OpenAI wire shape echoed back: {"function": {"name", "arguments"}}.
    const fn = (c.function && typeof c.function === "object" ? c.function : c) as Record<string, unknown>;
    const name = fn.name;
    if (typeof name !== "string" || !names.has(name)) continue;
    const rawArgs = fn.arguments ?? fn.args ?? fn.parameters ?? {};
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
    calls.push({ id: newId("call"), type: "function", function: { name, arguments: args } });
  }
  return calls;
}

/** Rough token count for `usage`: the web UI reports none, and ~4 chars/token is the usual estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What is safe to stream so far.
 *
 * The markdown is rebuilt from a DOM that is still being written, and the
 * last line can change shape as it completes (a code fence closing, a table
 * row filling in). So hold back the unfinished last line, and only ever send
 * text that extends what was already sent — a client can't take text back.
 */
export function streamableDelta(sent: string, current: string, final: boolean): string {
  if (!current.startsWith(sent)) return "";
  const cut = final ? current.length : current.lastIndexOf("\n") + 1;
  return cut > sent.length ? current.slice(sent.length, cut) : "";
}
