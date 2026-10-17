import type { ToolDefinition } from "../types.js";
import type { GeminiDriver } from "../driver/GeminiDriver.js";
import { confirmAction } from "./confirm.js";

const MAX_TEXT_CHARS = 30_000;

/**
 * Session-scoped, because it needs the live browser.
 *
 * Complements fetch_url rather than replacing it: fetch_url makes a bare
 * HTTP request (right for APIs and raw files), this one renders the page
 * first. Docs sites, SPAs and dashboards serve an empty shell to a plain
 * fetch, so rendering is the only way to actually read them.
 */
export function createBrowsePageTool(driver: GeminiDriver): ToolDefinition {
  return {
    name: "read_page",
    description:
      `read_page(args: {url: string, selector?: string, clickSelector?: string, includeLinks?: boolean, as?: "text"|"pdf"}) -> ` +
      `opens the URL in a real browser, waits for JavaScript to render, and returns the page's readable text. ` +
      `Use this for documentation, articles, and any site that renders client-side — fetch_url would return an ` +
      `empty shell for those. 'selector' narrows extraction to one element, 'clickSelector' clicks something first ` +
      `(a cookie banner, a tab), 'includeLinks' also returns the links so you can navigate onward. ` +
      `Set as:"pdf" for long or layout-heavy pages — it attaches the page as a PDF you can read directly, ` +
      `which keeps tables and structure that flattened text loses. Works with localhost. The user confirms each URL.`,
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

      // Loads in the same browser as the user's logged-in session, so they
      // see the destination before it opens — same gate as fetch_url and
      // screenshot_page.
      const detail =
        url +
        (args.selector ? `\n  reading: ${String(args.selector)}` : "") +
        (args.clickSelector ? `\n  clicking first: ${String(args.clickSelector)}` : "");
      if (!(await confirmAction("Open page and read it?", detail, "network"))) {
        return { ok: false, output: "User declined to open this page." };
      }

      if (String(args.as ?? "text").toLowerCase() === "pdf") {
        const { mkdir } = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const dir = pathMod.resolve(process.cwd(), ".gemini-code-tmp");
        await mkdir(dir, { recursive: true });
        // Short, stable name — long ones get ellipsized in the chip, which
        // breaks the upload-succeeded check.
        const outPath = pathMod.join(dir, "page.pdf");
        try {
          const info = await driver.printPageToPdf(url, outPath);
          return {
            ok: true,
            output: `${info.url}${info.title ? ` ("${info.title}")` : ""} is attached as a PDF.`,
            attachment: outPath,
          };
        } catch (err) {
          return { ok: false, output: `Error making PDF: ${(err as Error).message.split("\n")[0]}` };
        }
      }

      try {
        const result = await driver.readPageText(url, {
          selector: typeof args.selector === "string" ? args.selector : undefined,
          clickSelector: typeof args.clickSelector === "string" ? args.clickSelector : undefined,
          includeLinks: Boolean(args.includeLinks),
        });

        if (!result.text) {
          return {
            ok: false,
            output:
              `Loaded ${result.url} but found no readable text. The content may be inside an iframe, ` +
              `or behind something that needs clicking — try 'selector' or 'clickSelector', or ` +
              `screenshot_page to look at it instead.`,
          };
        }

        const truncated = result.text.length > MAX_TEXT_CHARS;
        const body = truncated ? result.text.slice(0, MAX_TEXT_CHARS) : result.text;
        const links = result.links.length ? `\n\n--- LINKS ---\n${result.links.join("\n")}` : "";

        return {
          ok: true,
          output:
            `# ${result.title}\n${result.url}\n\n${body}` +
            (truncated ? `\n\n[truncated at ${MAX_TEXT_CHARS} characters]` : "") +
            links,
        };
      } catch (err) {
        return { ok: false, output: `Error reading page: ${(err as Error).message.split("\n")[0]}` };
      }
    },
  };
}
