import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import type { GeminiDriver } from "../driver/GeminiDriver.js";
import { confirmAction } from "./confirm.js";

export const SCREENSHOT_DIR = ".gemini-code-tmp";

/**
 * Session-scoped (like delegate_tasks) because it needs the live browser.
 *
 * Gives Gemini eyes: it can look at a page it just built rather than
 * reasoning about the HTML blind — "does this actually render?", "is the
 * header centred?", "what does the error page say?".
 */
export function createScreenshotTool(driver: GeminiDriver): ToolDefinition {
  return {
    name: "screenshot_page",
    description:
      `screenshot_page(args: {url: string, fullPage?: boolean, selector?: string, width?: number, height?: number}) -> ` +
      `opens the URL in a browser tab, screenshots it, and ATTACHES the image to your next message so you can see it. ` +
      `Use it to check how a page you built actually renders, or to read a page that's easier to see than to parse. ` +
      `Works with localhost dev servers. 'selector' captures just that element. The user confirms each URL first.`,
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

      // Confirmed like any other outward action. This one loads the page in
      // the SAME browser as your logged-in session, so the user should see
      // exactly where it's pointing before it opens.
      const detail = `${url}${args.selector ? `\n  element: ${String(args.selector)}` : ""}`;
      if (!(await confirmAction("Open page and screenshot it?", detail, "network"))) {
        return { ok: false, output: "User declined to open this page." };
      }

      const dir = path.resolve(process.cwd(), SCREENSHOT_DIR);
      await mkdir(dir, { recursive: true });
      // Short, stable name: the attachment chip ellipsizes long filenames,
      // which breaks the upload-succeeded check.
      const outPath = path.join(dir, "screenshot.png");

      try {
        const width = Number(args.width);
        const height = Number(args.height);
        const info = await driver.screenshotPage(url, outPath, {
          fullPage: Boolean(args.fullPage),
          selector: typeof args.selector === "string" ? args.selector : undefined,
          viewport:
            Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined,
        });
        return {
          ok: true,
          output: `Screenshot of ${info.url}${info.title ? ` ("${info.title}")` : ""} is attached to this message.`,
          attachment: outPath,
        };
      } catch (err) {
        return { ok: false, output: `Error taking screenshot: ${(err as Error).message.split("\n")[0]}` };
      }
    },
  };
}
