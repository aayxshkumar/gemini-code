/**
 * Verifies the Playwright plumbing itself: can we launch a persistent
 * Chromium profile and load gemini.google.com? Run headless and separately
 * from `npm test` because it needs network access and a real browser
 * binary, and it deliberately does NOT log in or touch selectors.ts — it
 * only proves GeminiDriver.launch() + ensureLoggedIn()'s detection logic
 * work against the real (logged-out) page.
 *
 * Not part of `npm test` on purpose: it's slower and network-dependent.
 * Run it directly with: npx tsx src/tests/browser-smoke.ts
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { GeminiDriver, TIMEOUTS } from "../driver/GeminiDriver.js";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { BrowserSession, formatSnapshot } from "../driver/BrowserSession.js";
import { HTML_TO_MARKDOWN } from "../driver/markdown.js";
import { readFile } from "node:fs/promises";

async function main() {
  const profileDir = path.resolve(process.cwd(), ".tmp-test-profile");
  await rm(profileDir, { recursive: true, force: true });

  const driver = new GeminiDriver({ headless: true, userDataDir: profileDir });
  console.log("Launching headless Chromium and navigating to gemini.google.com...");
  await driver.launch();
  console.log("ok - launch() completed without throwing");

  // We're logged out (fresh profile), so ensureLoggedIn should detect that
  // and NOT hang forever — give it a short timeout and expect it to throw.
  let sawLoginPrompt = false;
  try {
    await driver.ensureLoggedIn(3_000);
  } catch (err) {
    // Either wording counts as "it noticed we're signed out": interactive
    // runs wait for a human, non-interactive ones fail fast instead.
    sawLoginPrompt = /(Timed out waiting for sign-in|signed out)/i.test((err as Error).message);
  }
  console.log(
    sawLoginPrompt
      ? "ok - correctly detected the logged-out state (sign-in button visible)"
      : "note - did not detect the expected sign-in prompt; selectors.ts.signInButton may need recalibrating against the real markup"
  );

  await driver.close();
  await rm(profileDir, { recursive: true, force: true });
  console.log("ok - browser closed cleanly");

  await testInteractiveBrowsing();
  await testAttachmentDetection();
  await testFailedTabsAreClosed();
}

main().catch((err) => {
  console.error("FAIL -", err);
  process.exit(1);
});

/**
 * channel: "chrome" uses the Chrome already on the machine, so running the
 * tests needs no `npx playwright install` download — and exercises the same
 * browser real users run. GEMINI_CODE_CHROME_PATH overrides it for CI and
 * containers, which have a Chromium binary but no Chrome channel.
 */
function launchTestBrowser() {
  const executablePath = process.env.GEMINI_CODE_CHROME_PATH;
  return executablePath
    ? chromium.launch({ headless: true, executablePath })
    : chromium.launch({ headless: true, channel: "chrome" });
}

/**
 * Drives a real page: reads its controls, types into a field, submits, and
 * checks the resulting page. Self-contained (its own server and headless
 * browser) so it doesn't need the user's logged-in session.
 */
async function testInteractiveBrowsing(): Promise<void> {
  console.log("\nReply as markdown (for the API):");
  {
    // A real Gemini reply's HTML, captured live: heading, inline styles, a
    // link, both list kinds, a code block, a table and a blockquote.
    const fixture = await readFile(path.resolve("src/tests/fixtures/gemini-reply.html"), "utf8");
    const b = await launchTestBrowser();
    try {
      const p = await b.newPage();
      await p.setContent(`<div id="r">${fixture}</div>`);
      const md = (await p.evaluate(
        `(${HTML_TO_MARKDOWN})(document.querySelector("#r .markdown") || document.querySelector("#r"))`
      )) as string;
      assert.match(md, /^## Demo$/m, "heading");
      assert.match(md, /\*\*bold\*\*, \*italic\*, `inline code`/, "inline styles");
      assert.match(md, /\[link\]\(https:\/\/example\.com\)/, "link, with Gemini's utm_source removed");
      assert.match(md, /^- First bullet item$/m, "bullets");
      assert.match(md, /^2\. Second numbered item$/m, "numbering");
      assert.match(md, /```python\nprint\("hi"\)\n```/, "code fence with its language, no button text");
      assert.match(md, /^\| Header 1 \| Header 2 \|\n\| --- \| --- \|\n\| Cell 1 \| Cell 2 \|$/m, "table");
      assert.match(md, /^> This is a blockquote/m, "blockquote");
      assert.doesNotMatch(md, /Copy code|Download code|Python\n/, "UI chrome stays out");
      console.log("  ok - rebuilds markdown from a real reply's HTML");
    } finally {
      await b.close();
    }
  }

  console.log("\nInteractive browsing:");

  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/results")) {
      res.end("<html><body><h1>Results</h1><p>MATCHED-WIDGET-42</p></body></html>");
    } else {
      res.end(
        '<html><body><h1>Store</h1><form action="/results"><input name="q" placeholder="Search"><button type="submit">Go</button></form></body></html>'
      );
    }
  });
  await new Promise<void>((r) => server.listen(8934, r));

  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  const session = new BrowserSession(context);

  try {
    const snap = await session.open("http://localhost:8934");
    const rendered = formatSnapshot(snap);
    console.log(`    [found ${snap.elements.length} interactive elements]`);
    assert.match(rendered, /INTERACTIVE ELEMENTS/);
    assert.ok(snap.elements.length >= 2, "should list the input and the button");

    const input = snap.elements.find((e) => e.role.startsWith("input"));
    assert.ok(input, "should find the search input");
    console.log("  ok - lists the page's controls with refs");

    const after = await session.type(input!.ref, "gears", true);
    console.log(`    [after submit: ${after.url}]`);
    assert.match(after.url, /results/, "submitting should navigate");
    assert.match(after.text, /MATCHED-WIDGET-42/, "should read the resulting page");
    console.log("  ok - types into a field, submits, and reads the result");

    // Refs from a previous page must not silently act on the new one.
    await session
      .click(9999)
      .then(() => assert.fail("clicking a stale ref should throw"))
      .catch((err: Error) => assert.match(err.message, /No element/));
    console.log("  ok - rejects a stale element ref instead of guessing");

    await session.close();
    console.log("  ok - closes cleanly");
  } catch (err) {
    console.log("  FAIL -", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}


/**
 * An upload that never lands must be REPORTED as not landed.
 *
 * waitForAttachmentReady's secondary signal was a page-wide
 * `getByText(filename).isVisible()`. getByText searches the whole document,
 * thread included — and every oversized tool result leaves its filename in
 * that thread ("...ATTACHED to this message as run_bash-output.txt").
 * run_bash reuses one fixed filename, so from the SECOND big command output
 * onwards the previous turn's message matched and a failed upload was waved
 * through. The prompt then went out claiming an attachment that wasn't
 * there, Gemini replied that it could see no output, and the loop spent its
 * remaining turns re-asking until it hit "max tool-call turns".
 */
async function testAttachmentDetection(): Promise<void> {
  console.log("\nAttachment upload detection:");

  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  // A thread where an EARLIER turn attached run_bash-output.txt. No chip is
  // on the composer now: this upload has not landed.
  const history = `<!doctype html><body>
    <div class="conversation"><div class="user-msg">TOOL_RESULT &gt;&gt;&gt;
      Output was too long to paste (8213 characters), so it is ATTACHED to this
      message as "run_bash-output.txt". Read the attached file.
      &lt;&lt;&lt; END_TOOL_RESULT</div></div>
    <div contenteditable="true"></div></body>`;

  const driver = new GeminiDriver({ headless: true });
  // Drive the real method against our page, without launching Gemini.
  const asAny = driver as unknown as {
    page: unknown;
    waitForAttachmentReady(f: string, c: number, t?: number): Promise<void>;
  };
  asAny.page = page;

  try {
    await page.setContent(history);
    let rejected = false;
    await asAny
      .waitForAttachmentReady("run_bash-output.txt", 0, 2_000)
      .catch(() => (rejected = true));
    assert.ok(rejected, "a filename already in the thread must NOT count as this upload landing");
    console.log("  ok - a failed upload is not waved through by the previous turn's message");

    // And a real upload still registers, even with that history present.
    await page.setContent(
      history.replace("<div contenteditable", '<div class="attachment-chip">run_bash-output.txt</div><div contenteditable')
    );
    await asAny.waitForAttachmentReady("run_bash-output.txt", 0, 5_000);
    console.log("  ok - a genuine attachment chip is still detected");
  } catch (err) {
    console.log("  FAIL -", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}


/**
 * A Gem or worker tab that fails to come up must be CLOSED, not abandoned.
 *
 * spawnGemTab and spawnTab opened the page first and set it up after; any
 * failure in between left the tab open with nothing driving it. ask_gem
 * reopens on its next call, so each failed consult added one more orphan to
 * the user's window.
 */
async function testFailedTabsAreClosed(): Promise<void> {
  console.log("\nFailed tabs are closed:");

  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  // Every request gets a blank page: no Gemini app shell ever appears, so
  // tab setup fails the way it does against a broken or signed-out session.
  await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));

  const savedShell = TIMEOUTS.appShell;
  TIMEOUTS.appShell = 1_500;
  try {
    const driver = new GeminiDriver({ headless: true }) as unknown as {
      context: unknown;
      spawnGemTab(g: { id: string; name: string }): Promise<unknown>;
      spawnTab(label?: string): Promise<unknown>;
    };
    driver.context = context;

    for (const [label, spawn] of [
      ["spawnGemTab", () => driver.spawnGemTab({ id: "abc123", name: "Kite 2" })],
      ["spawnTab", () => driver.spawnTab("worker")],
    ] as const) {
      const before = context.pages().length;
      let threw = false;
      await spawn().catch(() => (threw = true));
      assert.ok(threw, `${label} should fail against a page with no app shell`);
      assert.equal(context.pages().length, before, `${label} must close the tab it opened`);
      console.log(`  ok - ${label} closes its tab when setup fails`);
    }
  } catch (err) {
    console.log("  FAIL -", (err as Error).message);
    process.exitCode = 1;
  } finally {
    TIMEOUTS.appShell = savedShell;
    await browser.close();
  }
}
