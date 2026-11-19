/**
 * An OpenAI-compatible HTTP API in front of the Gemini web UI.
 *
 * Point any OpenAI client at http://127.0.0.1:<port>/v1 and it talks to your
 * signed-in Gemini session:
 *
 *   GET  /v1/models
 *   POST /v1/chat/completions   (streaming, images and function calling)
 *   GET  /health
 *
 * No dependencies: node:http is enough for three routes, and it keeps the
 * release tarball as it is.
 */
import { isEnterprise } from "../driver/site.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeminiDriver } from "../driver/GeminiDriver.js";
import { TabPool, type PooledTab } from "./tabPool.js";
import {
  API_MODELS,
  buildContinuationPrompt,
  buildFreshPrompt,
  estimateTokens,
  imagesOf,
  modelAliasFor,
  newId,
  parseToolCalls,
  streamableDelta,
  textOf,
  toolsKey,
  validateRequest,
  type ChatMessage,
  type ChatRequest,
  type ToolCall,
} from "./protocol.js";

export interface ServerOptions {
  driver: GeminiDriver;
  host: string;
  port: number;
  /** Max parallel Gemini tabs (= max concurrent requests). */
  tabs: number;
  /** Required as `Authorization: Bearer <key>` when set. */
  apiKey?: string;
  /** Browser origins allowed to call the API (CORS). Default: none. */
  allowedOrigins: string[];
  log: (msg: string) => void;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 10;

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error"
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
  sendJson(res, status, { error: { message, type, code: null, param: null } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `Request body over ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Saves request images to temp files, since the web UI uploads files. */
async function materializeImages(urls: string[], dir: string): Promise<string[]> {
  if (urls.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images per request.`);
  const files: string[] = [];
  for (const [i, url] of urls.entries()) {
    let data: Buffer;
    let ext = "png";
    const dataUrl = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(url);
    if (dataUrl) {
      ext = dataUrl[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
      data = Buffer.from(dataUrl[2], "base64");
    } else if (/^https?:\/\//i.test(url)) {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
        throw new HttpError(400, `Couldn't fetch image ${url}: ${e.message}`);
      });
      if (!r.ok) throw new HttpError(400, `Couldn't fetch image ${url}: HTTP ${r.status}`);
      const type = r.headers.get("content-type") ?? "";
      ext = /jpe?g/.test(type) ? "jpg" : /webp/.test(type) ? "webp" : /gif/.test(type) ? "gif" : "png";
      data = Buffer.from(await r.arrayBuffer());
    } else {
      throw new HttpError(400, "image_url must be a data: URL or an http(s) URL.");
    }
    if (data.length > MAX_IMAGE_BYTES) throw new HttpError(400, `Image ${i + 1} is over 15 MB.`);
    const file = path.join(dir, `image-${i + 1}.${ext}`);
    await writeFile(file, data);
    files.push(file);
  }
  return files;
}

/** Reads and discards what's left of a request body, for at most 2s. */
function drainRequest(req: IncomingMessage): Promise<void> {
  if (req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 2_000);
    req.once("end", done);
    req.once("error", done);
    req.resume();
  });
}

export async function startServer(opts: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  // Exposing a signed-in Gemini account to the network with no key would let
  // anyone who can reach the port use it. Refuse rather than warn.
  if (!isLoopback(opts.host) && !opts.apiKey) {
    throw new Error(
      `Refusing to listen on ${opts.host} without an API key — anyone who can reach it could use your ` +
        `Gemini account. Set --api-key (or GEMINI_CODE_API_KEY), or keep the default host 127.0.0.1.`
    );
  }

  const pool = new TabPool(opts.driver, opts.tabs, opts.log);
  const created = Math.floor(Date.now() / 1000);

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://local");
    const origin = req.headers.origin;

    try {
      // A web page the user happens to visit can send requests to localhost.
      // Without this, any site could quietly use the account. Browsers always
      // send Origin on cross-site requests; SDKs and curl don't.
      if (origin) {
        if (!opts.allowedOrigins.includes(origin) && !opts.allowedOrigins.includes("*")) {
          throw new HttpError(403, `Origin ${origin} is not allowed. Start the server with --cors-origin ${origin}.`, "permission_error");
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true, ...pool.stats });
        return;
      }

      if (opts.apiKey) {
        const auth = req.headers.authorization ?? "";
        const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!keyMatches(given, opts.apiKey)) {
          throw new HttpError(401, "Invalid or missing API key (Authorization: Bearer <key>).", "authentication_error");
        }
      }

      const route = url.pathname.replace(/\/+$/, "");
      if (req.method === "GET" && route === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: API_MODELS.map((m) => ({ id: m.id, object: "model", created, owned_by: "gemini-web" })),
        });
        return;
      }

      if (req.method === "POST" && route === "/v1/chat/completions") {
        // JSON content type forces a CORS preflight in browsers, which is
        // what makes the Origin check above airtight: a "simple" text/plain
        // POST would otherwise reach us without one.
        if (!/application\/json/i.test(req.headers["content-type"] ?? "")) {
          throw new HttpError(415, "Content-Type must be application/json.");
        }
        const body = await readBody(req);
        const invalid = validateRequest(body);
        if (invalid) throw new HttpError(400, invalid);
        await chatCompletion(body as ChatRequest, res, started);
        return;
      }

      throw new HttpError(404, `No route for ${req.method} ${url.pathname}.`, "not_found_error");
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, (err as Error).message.split("\n")[0], "server_error");
      if (res.headersSent) {
        // Mid-stream: the status is already sent, so report it in-band.
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message, type: e.type } })}\n\n`);
          res.end();
        }
      } else {
        // An early refusal (401, 403, 415…) comes before the body is read.
        // Closing with it unread resets the connection, and on macOS the
        // client then sees "fetch failed" instead of the error. Drain first.
        await drainRequest(req);
        sendError(res, e.status, e.message, e.type);
      }
      opts.log(`${req.method} ${url.pathname} -> ${e.status} ${e.message}`);
    }
  });

  // Gemini can take minutes on a long answer; node's default request
  // timeout (5 min) would cut those off mid-reply.
  server.requestTimeout = 0;

  async function chatCompletion(request: ChatRequest, res: ServerResponse, started: number): Promise<void> {
    const alias = modelAliasFor(request.model);
    const modelId = API_MODELS.find((m) => m.alias === alias)?.id ?? `gemini-web-${alias}`;
    const tools = request.tool_choice === "none" ? [] : request.tools ?? [];
    const tKey = toolsKey(request);
    const id = newId("chatcmpl");
    const stamp = Math.floor(Date.now() / 1000);

    const lease = await pool.acquire(request.messages, tKey);
    const tab: PooledTab = lease.tab;
    const imageDir = path.join(tmpdir(), "gemini-code-api", id);
    let ok = false;

    try {
      let prompt: string;
      let images: string[];
      if (lease.continuation) {
        prompt = buildContinuationPrompt(lease.continuation);
        images = lease.continuation.flatMap((m) => imagesOf(m.content));
      } else {
        await tab.driver.newConversation();
        prompt = buildFreshPrompt(request);
        images = request.messages.flatMap((m) => imagesOf(m.content));
      }

      if (tab.model !== alias && !isEnterprise()) {
        try {
          await tab.driver.setModel(alias);
          tab.model = alias;
        } catch (err) {
          // Still answer on whatever model is selected — better than failing.
          opts.log(`couldn't select model ${alias}: ${(err as Error).message.split("\n")[0]}`);
        }
      }

      await mkdir(imageDir, { recursive: true });
      const files = await materializeImages(images, imageDir);
      await tab.driver.sendPrompt(prompt, files.length ? { attachFile: files } : {});

      const streaming = request.stream === true;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
        id,
        object: "chat.completion.chunk",
        created: stamp,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const write = (payload: unknown) => {
        if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      let sent = "";
      if (streaming) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        write(chunk({ role: "assistant", content: "" }));
        if (!tools.length) {
          // Text can go out as it's written. With tools we have to see the
          // whole reply first to know whether it's a call or an answer.
          await tab.driver.streamResponse((md) => {
            const delta = streamableDelta(sent, md, false);
            if (delta) {
              sent += delta;
              write(chunk({ content: delta }));
            }
          });
        } else {
          await tab.driver.waitForResponseComplete();
        }
      } else {
        await tab.driver.waitForResponseComplete();
      }

      const raw = await tab.driver.getLastResponse();
      const markdown = (await tab.driver.getLastResponseMarkdown().catch(() => "")) || raw.text;
      const calls: ToolCall[] | undefined = tools.length ? parseToolCalls(raw, tools) : undefined;
      const assistant: ChatMessage = calls
        ? { role: "assistant", content: null, tool_calls: calls }
        : { role: "assistant", content: markdown };
      const finish = calls ? "tool_calls" : "stop";

      const promptText = request.messages.map((m) => textOf(m.content)).join("\n");
      const usage = {
        prompt_tokens: estimateTokens(promptText),
        completion_tokens: estimateTokens(calls ? JSON.stringify(calls) : markdown),
        total_tokens: 0,
      };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

      if (streaming) {
        if (calls) {
          write(
            chunk({
              tool_calls: calls.map((c, index) => ({ index, id: c.id, type: "function", function: c.function })),
            })
          );
        } else {
          const rest = sent ? streamableDelta(sent, markdown, true) : markdown;
          if (rest) write(chunk({ content: rest }));
        }
        write(chunk({}, finish));
        if (request.stream_options?.include_usage) {
          write({ id, object: "chat.completion.chunk", created: stamp, model: modelId, choices: [], usage });
        }
        if (!res.writableEnded) res.end("data: [DONE]\n\n");
      } else {
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created: stamp,
          model: modelId,
          choices: [{ index: 0, message: assistant, finish_reason: finish, logprobs: null }],
          usage,
        });
      }

      // The thread now holds this exchange; the next request that extends it
      // can continue here instead of starting over.
      tab.history = [...request.messages, assistant];
      tab.toolsKey = tKey;
      ok = true;
      opts.log(
        `chat ${modelId}${streaming ? " stream" : ""}${calls ? ` -> ${calls.length} tool call(s)` : ""}` +
          `${lease.continuation ? " (continued thread)" : ""} ${((Date.now() - started) / 1000).toFixed(1)}s`
      );
    } finally {
      // A failed request leaves the thread in an unknown state.
      if (!ok) pool.reset(tab);
      pool.release(tab);
      await rm(imageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  const shownHost = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${shownHost}:${opts.port}/v1`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.close();
    },
  };
}
