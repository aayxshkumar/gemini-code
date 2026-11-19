/**
 * `gemini-code probe`: calibration help for a Gemini app whose DOM we
 * haven't seen — in practice, an organisation's Gemini Enterprise tenant.
 *
 * Attaches to the signed-in debug Chrome, and on the app's tab reports, for
 * every selector the driver uses, how many elements match and how many are
 * visible. Then it writes an outline of the page's controls — walking into
 * shadow roots, since Enterprise is built from web components — to
 * ~/.gemini-code/probe.txt, so the right selectors can be written into
 * ~/.gemini-code/selectors.json without a rebuild.
 *
 * Reads only. Text in the outline is cut to a few words per element, but it
 * can still include bits of the page, so look before sharing the file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GeminiDriver, selectorOverridesPath } from "../driver/GeminiDriver.js";
import { selectors } from "../driver/selectors.js";
import { appUrl, isAppPage, isEnterprise, siteName } from "../driver/site.js";
import { homeDir } from "../config.js";
import { ensureChromeRunning } from "./openChrome.js";

/** The selectors that matter for sending and reading, checked first. */
const KEY = ["composerInput", "sendButton", "stopButton", "responseContainer", "newChatButton", "signInButton"];

const OUTLINE_SCRIPT = `(() => {
  const out = [];
  const interesting = (el) => {
    const tag = el.tagName.toLowerCase();
    return (
      tag === "button" || tag === "textarea" || tag === "input" || tag === "a" ||
      el.hasAttribute("role") || el.getAttribute("contenteditable") === "true" ||
      el.hasAttribute("aria-label") || el.hasAttribute("data-test-id") ||
      tag.startsWith("ucs-") || tag.startsWith("md-") || tag.includes("response") || tag.includes("message")
    );
  };
  const describe = (el, depth, inShadow) => {
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    for (const name of ["id", "role", "aria-label", "data-test-id", "contenteditable", "type", "placeholder"]) {
      const v = el.getAttribute(name);
      if (v) attrs.push(name + '="' + v.slice(0, 60) + '"');
    }
    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).slice(0, 3).join(".");
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0;
    const text = (el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    out.push("  ".repeat(Math.min(depth, 30)) + (inShadow ? "#shadow " : "") + tag + (cls ? "." + cls : "") +
      (attrs.length ? " [" + attrs.join(" ") + "]" : "") + (visible ? "" : " (hidden)") + (text ? '  "' + text + '"' : ""));
  };
  const walk = (root, depth, inShadow) => {
    for (const el of root.children) {
      if (out.length > 4000) return;
      const keep = interesting(el);
      if (keep) describe(el, depth, inShadow);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, true);
      walk(el, keep ? depth + 1 : depth, inShadow);
    }
  };
  walk(document, 0, false);
  return out;
})()`;

export async function probe(): Promise<void> {
  await ensureChromeRunning((m) => console.log(m));
  const driver = new GeminiDriver();
  await driver.attach().catch((err: Error) => {
    // A Chrome that's open on the sign-in page still has something to probe.
    console.log(`(attach: ${err.message.split("\n")[0]})`);
  });
  const page = driver.currentPage;
  if (!page) throw new Error("No tab to probe — run `gemini-code open-chrome` and sign in first.");
  const where = page.url();
  console.log(`\nProbing ${siteName()} — ${where}${isAppPage(where) ? "" : `\n  (not the app page ${appUrl()} — signed in?)`}\n`);

  const rows: string[] = [];
  const names = [...KEY, ...Object.keys(selectors).filter((n) => !KEY.includes(n))];
  for (const name of names) {
    const sel = (selectors as Record<string, unknown>)[name];
    if (typeof sel !== "string") continue;
    const all = await page.locator(sel).count().catch(() => -1);
    const visible = await page.locator(`${sel} >> visible=true`).count().catch(() => -1);
    const mark = visible > 0 ? "ok  " : all > 0 ? "hid " : "--  ";
    rows.push(`${mark} ${name.padEnd(20)} ${String(all).padStart(3)} match, ${String(visible).padStart(3)} visible   ${sel}`);
  }
  for (const row of rows) console.log(`  ${row}`);

  const outline = (await page.evaluate(OUTLINE_SCRIPT).catch(() => [])) as string[];
  const file = path.join(homeDir(), "probe.txt");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `gemini-code probe — ${new Date().toISOString()}\nsite: ${siteName()} ${isEnterprise() ? appUrl() : ""}\npage: ${where}\n\n` +
      `Selectors (ok = visible match, hid = only hidden matches, -- = none):\n${rows.join("\n")}\n\n` +
      `Page outline (controls and components, shadow roots marked #shadow):\n${outline.join("\n")}\n`,
    "utf8"
  );
  console.log(
    `\nOutline of ${outline.length} elements written to ${file}.\n` +
      `It can contain a few words of on-page text per element — look before sharing it.\n` +
      `Fix a selector without rebuilding by putting it in ${selectorOverridesPath()}, e.g.\n` +
      `  { "responseContainer": "ucs-summary", "composerInput": "div.ProseMirror[contenteditable=\\"true\\"]" }\n` +
      `For the composer: type something in the box first, then probe, so "composerInput" has text to show.`
  );
  await driver.close();
}
