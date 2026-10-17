import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import type { GeminiDriver } from "../driver/GeminiDriver.js";
import { BrowserSession, formatSnapshot, type PageSnapshot } from "../driver/BrowserSession.js";
import { confirmAction } from "./confirm.js";

const TMP_DIR = ".gemini-code-tmp";

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Approval is per ORIGIN, not per session.
 *
 * The browsing tab lives in the same browser as the user's signed-in Google
 * session, so it inherits those cookies. Approving "open example.com" must
 * not silently authorise a later hop to mail.google.com, where the agent
 * would be acting as the user. Each new origin is confirmed on arrival,
 * which bounds the blast radius of a stray click without making every
 * click on an approved site a prompt.
 */
async function ensureOriginApproved(session: BrowserSession, url: string): Promise<boolean> {
  const origin = originOf(url);
  if (!origin || session.approvedOrigins.has(origin)) return true;
  const approved = await confirmAction(
    "Let the agent browse this site?",
    `${origin}\n  (it will be able to click and type there, using this browser's signed-in session)`,
    "network");
  if (approved) session.approvedOrigins.add(origin);
  return approved;
}

export function createBrowserTools(driver: GeminiDriver): ToolDefinition[] {
  let session: BrowserSession | undefined;

  const getSession = (): BrowserSession => {
    if (!session) session = new BrowserSession(driver.browserContext());
    return session;
  };

  const openTool: ToolDefinition = {
    name: "browser_open",
    description:
      `browser_open(args: {url: string}) -> opens a page in a real browser tab you can then INTERACT with, and ` +
      `returns the page's text plus a numbered list of its buttons, links and inputs. This is a live session: the ` +
      `page stays open between calls, so you can click, type, read the result and click again. Use it for anything ` +
      `you need to operate rather than just read — logging into a dev app, filling a form, clicking through a UI, ` +
      `searching a site. For a page you only need to READ once, read_page is cheaper.`,
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

      const s = getSession();
      if (!(await ensureOriginApproved(s, url))) {
        return { ok: false, output: "User declined to browse that site." };
      }

      try {
        const snap = await s.open(url);
        return { ok: true, output: formatSnapshot(snap) };
      } catch (err) {
        return { ok: false, output: `Error opening page: ${(err as Error).message.split("\n")[0]}` };
      }
    },
  };

  const doTool: ToolDefinition = {
    name: "browser_do",
    description:
      `browser_do(args: {action: "click"|"type"|"press"|"scroll"|"back"|"snapshot"|"screenshot", ref?: number, ` +
      `text?: string, submit?: boolean, key?: string, direction?: "up"|"down"}) -> acts on the page opened by ` +
      `browser_open and returns the updated page. 'ref' is a number from the element list — click it, or type ` +
      `into it (set submit: true to press Enter after, e.g. for a search box). 'press' sends a key, 'scroll' takes ` +
      `a direction, 'back' goes back, 'snapshot' just re-reads the page, 'screenshot' attaches a picture of it. ` +
      `REFS CHANGE whenever the page changes — always use the ones from the most recent result.`,
    async run(args) {
      const s = getSession();
      if (!s.isOpen()) {
        return { ok: false, output: "No browsing session is open — use browser_open first." };
      }
      const action = String(args.action ?? "snapshot").toLowerCase();

      try {
        let snap: PageSnapshot;
        switch (action) {
          case "click": {
            const ref = Number(args.ref);
            if (!Number.isFinite(ref)) return { ok: false, output: "Error: 'ref' (a number) is required to click." };
            snap = await s.click(ref);
            break;
          }
          case "type": {
            const ref = Number(args.ref);
            const text = String(args.text ?? "");
            if (!Number.isFinite(ref)) return { ok: false, output: "Error: 'ref' (a number) is required to type." };
            if (!text) return { ok: false, output: "Error: 'text' is required to type." };
            snap = await s.type(ref, text, Boolean(args.submit));
            break;
          }
          case "press":
            snap = await s.press(String(args.key ?? "Enter"));
            break;
          case "scroll":
            snap = await s.scroll(args.direction === "up" ? "up" : "down");
            break;
          case "back":
            snap = await s.back();
            break;
          case "screenshot": {
            const dir = path.resolve(process.cwd(), TMP_DIR);
            await mkdir(dir, { recursive: true });
            const out = path.join(dir, "browser.png");
            await s.screenshot(out);
            return {
              ok: true,
              output: `Screenshot of ${s.currentUrl()} is attached to this message.`,
              attachment: out,
            };
          }
          case "snapshot":
            snap = await s.snapshot();
            break;
          default:
            return {
              ok: false,
              output: `Error: unknown action "${action}". Use click, type, press, scroll, back, snapshot or screenshot.`,
            };
        }

        // An action can navigate somewhere new — re-check before handing
        // back the contents of a site the user never approved.
        if (!(await ensureOriginApproved(s, snap.url))) {
          await s.back().catch(() => undefined);
          return {
            ok: false,
            output: `That action navigated to ${originOf(snap.url)}, which the user declined. Went back.`,
          };
        }

        return { ok: true, output: formatSnapshot(snap) };
      } catch (err) {
        return { ok: false, output: `Error: ${(err as Error).message.split("\n")[0]}` };
      }
    },
  };

  const closeTool: ToolDefinition = {
    name: "browser_close",
    description:
      `browser_close() -> closes the browsing tab. Do this when you're finished with a site, so stray tabs don't ` +
      `pile up.`,
    async run() {
      if (!session || !session.isOpen()) return { ok: true, output: "No browsing session was open." };
      await session.close();
      return { ok: true, output: "Closed the browsing tab." };
    },
  };

  return [openTool, doTool, closeTool];
}
