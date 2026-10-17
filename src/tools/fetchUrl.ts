import type { ToolDefinition } from "../types.js";
import { confirmAction } from "./confirm.js";

const MAX_BODY_CHARS = 200_000;
const TIMEOUT_MS = 30_000;

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: `fetch_url(args: {url: string, method?: string, headers?: object, body?: string}) -> fetches a URL from the LOCAL machine (like curl/wget) and returns status + response body as text. Use for API calls, docs, or anything on the local network that you can't reach yourself. The user confirms each request before it is sent.`,
  async run(args) {
    const url = String(args.url ?? "").trim();
    if (!url) return { ok: false, output: "Error: 'url' is required." };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, output: `Error: "${url}" is not a valid URL.` };
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, output: `Error: only http/https are allowed (got "${parsed.protocol}").` };
    }

    const method = String(args.method ?? "GET").toUpperCase();
    const headers = (args.headers ?? {}) as Record<string, string>;
    const body = args.body === undefined ? undefined : String(args.body);

    // Outbound network request chosen by the model, so it gets the same
    // confirmation gate as run_bash/write_file. The host is shown explicitly:
    // a request can carry local data off the machine, and the user should see
    // exactly where it's going before it goes.
    const detail =
      `${method} ${url}` +
      (Object.keys(headers).length ? `\n  headers: ${Object.keys(headers).join(", ")}` : "") +
      (body ? `\n  body: ${body.length} bytes` : "");
    if (!(await confirmAction("Send network request?", detail, "network"))) {
      return { ok: false, output: "User declined this request." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: "follow" });
      const text = await res.text();
      const truncated = text.length > MAX_BODY_CHARS;
      const shown = truncated ? text.slice(0, MAX_BODY_CHARS) : text;
      const contentType = res.headers.get("content-type") ?? "unknown";
      return {
        ok: res.ok,
        output:
          `HTTP ${res.status} ${res.statusText}\ncontent-type: ${contentType}\n\n${shown}` +
          (truncated ? `\n\n[truncated at ${MAX_BODY_CHARS} characters of ${text.length}]` : ""),
      };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        output: e.name === "AbortError" ? `Error: request timed out after ${TIMEOUT_MS / 1000}s.` : `Error: ${e.message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
