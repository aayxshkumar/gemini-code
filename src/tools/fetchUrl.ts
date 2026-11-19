import type { ToolDefinition } from "../types.js";
import { gateHost, hostDecision } from "../permissions/gate.js";
import { currentPermissions } from "../permissions/session.js";

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
    const gate = await gateHost(parsed.toString(), "Send network request?", detail);
    if (!gate.run) return { ok: false, output: gate.message || "User declined this request." };
    // With host rules, redirects are followed by hand so every hop is checked.
    const hostRules = currentPermissions().rules.rules.some((r) => r.kind === "hosts");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // Send exactly the URL that was checked.
      let target = parsed.toString();
      let res = await fetch(target, { method, headers, body, signal: controller.signal, redirect: hostRules ? "manual" : "follow" });
      for (let hop = 0; hostRules && res.status >= 300 && res.status < 400 && res.headers.get("location"); hop++) {
        if (hop >= 5) return { ok: false, output: "Error: more than 5 redirects." };
        target = new URL(res.headers.get("location")!, target).toString();
        const d = hostDecision(target);
        if (d.verdict === "deny") return { ok: false, output: `Refused: the redirect to ${target} is ${d.reason}. Don't retry it.` };
        if (d.verdict !== "allow" && new URL(target).host !== parsed.host) {
          return { ok: false, output: `Stopped at a redirect to ${target}: ${d.reason}. Ask the user, or fetch that URL directly so it can be approved.` };
        }
        const keepBody = res.status === 307 || res.status === 308;
        res = await fetch(target, { method: keepBody ? method : "GET", headers, body: keepBody ? body : undefined, signal: controller.signal, redirect: "manual" });
      }
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
