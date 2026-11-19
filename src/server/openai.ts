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
import { QueueAbortedError, QueueFullError, QueueTimeoutError, TabPool, type PooledTab } from "./tabPool.js";
import { fetchImage, ImageFetchError, IMAGE_DEADLINE_MS, MAX_IMAGE_BYTES, redactUrl, type ImageFetchOptions } from "./imageFetch.js";
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
  /** Most requests waiting for a tab at once; more get 429 (default 8). */
  maxQueue?: number;
  /** How long a request may wait for a tab before a 503, in ms (default 120 s). */
  queueTimeoutMs?: number;
  /** Fetch http(s) image_url parts (default true); data: URLs always work. */
  remoteImages?: boolean;
  /** Allow image hosts on private/local addresses (default false). */
  privateImages?: boolean;
  /** Test seams for the image fetcher (fake resolver, CA, dial log). */
  imageFetch?: Pick<ImageFetchOptions, "resolve" | "ca" | "onDial" | "dialOverride" | "maxBytes">;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 10;
/** How long to keep pressing Stop on a tab whose client left. */
const STOP_RETRY_MS = 10_000;
/** What a busy server asks clients to wait before retrying. */
const RETRY_AFTER_SECONDS = "30";

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
    readonly code: string | null = null,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

/** The client closed the connection; nothing is written back. Logged as 499. */
class ClientGoneError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, type = "invalid_request_error", code: string | null = null, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { message, type, code, param: null } }, headers);
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
interface ImagePolicy {
  remote: boolean;
  allowPrivate: boolean;
  seams?: ServerOptions["imageFetch"];
}

/**
 * Turns image_url parts into files to attach. http(s) goes through the safe
 * fetcher (imageFetch.ts) under one deadline for the whole request; the
 * client hanging up aborts it.
 */
async function materializeImages(urls: string[], dir: string, policy: ImagePolicy, signal: AbortSignal): Promise<string[]> {
  if (urls.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images per request.`);
  if (!urls.length) return [];
  await mkdir(dir, { recursive: true });
  const deadline = AbortSignal.timeout(IMAGE_DEADLINE_MS);
  const both = AbortSignal.any([signal, deadline]);
  const files: string[] = [];
  for (const [i, url] of urls.entries()) {
    let data: Buffer;
    let ext = "png";
    const dataUrl = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(url);
    if (dataUrl) {
      ext = dataUrl[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
      data = Buffer.from(dataUrl[2], "base64");
    } else if (/^https?:\/\//i.test(url)) {
      if (!policy.remote) throw new HttpError(400, "Remote image URLs are turned off on this server (--remote-images off). Send the image as a data: URL.");
      try {
        ({ data, ext } = await fetchImage(url, { allowPrivate: policy.allowPrivate, signal: both, ...policy.seams }));
      } catch (err) {
        if (signal.aborted) throw new ClientGoneError("the client went away while an image downloaded");
        const why = deadline.aborted ? `took longer than ${IMAGE_DEADLINE_MS / 1000}s` : (err as Error).message;
        throw new HttpError(400, `Couldn't use image ${redactUrl(url)}: ${why}`);
      }
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
      if (err instanceof ClientGoneError) {
        opts.log(`${req.method} ${url.pathname} -> 499 client closed the connection (${err.message})`);
        return;
      }
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
        sendError(res, e.status, e.message, e.type, e.code, e.headers);
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

    // The client hanging up — an aborted stream, a closed socket — is how
    // SDKs cancel. Without this a cancelled request kept its tab busy until
    // Gemini finished, and a few of them blocked the whole server.
    const gone = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) gone.abort();
    };
    res.on("close", onClose);

    let lease;
    try {
      lease = await pool.acquire(request.messages, tKey, { signal: gone.signal, maxQueue: opts.maxQueue, timeoutMs: opts.queueTimeoutMs });
    } catch (err) {
      res.off("close", onClose);
      const retry = { "Retry-After": RETRY_AFTER_SECONDS };
      if (err instanceof QueueFullError) throw new HttpError(429, `Server busy: ${err.message}. Retry later.`, "rate_limit_error", "queue_full", retry);
      if (err instanceof QueueTimeoutError) throw new HttpError(503, `Server busy: ${err.message}. Retry later.`, "server_error", "queue_timeout", retry);
      if (err instanceof QueueAbortedError) throw new ClientGoneError(err.message);
      throw err;
    }
    const tab: PooledTab = lease.tab;
    const imageDir = path.join(tmpdir(), "gemini-code-api", id);
    let ok = false;
    /** Once the prompt is in Gemini, a retry would send it twice: errors say so. */
    let promptSent = false;
    /** Whether the tab's thread was touched (a refused image leaves it as it was). */
    let touched = false;
    let stopping: Promise<void> | undefined;
    const stopGemini = () => {
      stopping ??= (async () => {
        const stop = (tab.driver as { stopGenerating?: () => Promise<boolean> }).stopGenerating?.bind(tab.driver);
        if (!stop) return;
        const until = Date.now() + STOP_RETRY_MS;
        // The Stop button can appear a moment after sending; keep pressing.
        while (Date.now() < until) {
          if (await stop().catch(() => false)) return;
          await new Promise((r) => setTimeout(r, 500));
        }
        opts.log(`couldn't stop Gemini on a cancelled request within ${STOP_RETRY_MS / 1000}s`);
      })();
      return stopping;
    };
    const onGone = () => {
      if (promptSent) void stopGemini();
    };
    gone.signal.addEventListener("abort", onGone, { once: true });
    const checkGone = () => {
      if (gone.signal.aborted) throw new ClientGoneError("the client went away");
    };

    try {
      let prompt: string;
      let images: string[];
      const fresh = !lease.continuation;
      if (lease.continuation) {
        prompt = buildContinuationPrompt(lease.continuation);
        images = lease.continuation.flatMap((m) => imagesOf(m.content));
      } else {
        prompt = buildFreshPrompt(request);
        images = request.messages.flatMap((m) => imagesOf(m.content));
      }

      // Images first, before anything touches the tab: a refused or slow
      // image then costs nothing, and the thread is left as it was.
      const files = await materializeImages(
        images,
        imageDir,
        { remote: opts.remoteImages !== false, allowPrivate: opts.privateImages === true, seams: opts.imageFetch },
        gone.signal
      );
      checkGone();

      touched = true;
      if (fresh) await tab.driver.newConversation();

      if (tab.model !== alias && !isEnterprise()) {
        try {
          await tab.driver.setModel(alias);
          tab.model = alias;
        } catch (err) {
          // Still answer on whatever model is selected — better than failing.
          opts.log(`couldn't select model ${alias}: ${(err as Error).message.split("\n")[0]}`);
        }
      }

      // Left while the tab was being prepared: the prompt is never sent.
      checkGone();
      await tab.driver.sendPrompt(prompt, files.length ? { attachFile: files } : {});
      promptSent = true;
      if (gone.signal.aborted) void stopGemini();

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

      checkGone();
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
    } catch (err) {
      if (gone.signal.aborted && !(err instanceof HttpError)) throw new ClientGoneError("the client went away");
      // After the prompt reached Gemini, an SDK retry would send it again.
      if (promptSent && !(err instanceof ClientGoneError)) {
        const e = err instanceof HttpError ? err : new HttpError(500, (err as Error).message.split("\n")[0], "server_error");
        throw new HttpError(e.status, e.message, e.type, e.code, { ...e.headers, "x-should-retry": "false" });
      }
      throw err;
    } finally {
      gone.signal.removeEventListener("abort", onGone);
      res.off("close", onClose);
      // The tab is released only once the driver call on it has returned and
      // any Stop has been pressed, so a cancelled request can't overlap the next.
      if (stopping) await stopping;
      // A failed or cancelled request leaves the thread in an unknown state;
      // one that never touched the tab leaves it as it was.
      if (!ok && touched) pool.reset(tab);
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
