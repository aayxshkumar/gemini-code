import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { findChromeExecutable, isChromeReachable, DEBUG_PORT } from "./openChrome.js";
import { resolveProfileDir, GeminiDriver } from "../driver/GeminiDriver.js";
import { homeDir, userConfigPath, projectConfigPath, readConfigFile } from "../config.js";
import { DEFAULT_MODEL_ALIAS } from "../driver/models.js";
import { c, glyph } from "../ui/format.js";
import { resolveShell } from "../tools/bash.js";

const require = createRequire(import.meta.url);

/**
 * `gemini-code doctor`: everything a fresh machine can have wrong, checked
 * in order, with the fix next to each failure. Exits non-zero if anything
 * that would stop a session is missing, so a setup script can gate on it.
 */
export async function doctor(): Promise<void> {
  let fatal = 0;
  const ok = (m: string) => console.log(`  ${c.green(glyph.ok)} ${m}`);
  const warn = (m: string) => console.log(`  ${c.yellow("!")} ${m}`);
  const bad = (m: string) => {
    fatal++;
    console.log(`  ${c.red(glyph.bad)} ${m}`);
  };

  console.log(`\n${c.bold("gemini-code doctor")}\n`);

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node.js ${process.version}`);
  if (process.platform === "win32") {
    const shell = resolveShell();
    const name = shell === true ? "cmd.exe" : String(shell).split(/[\\/]/).pop();
    if (/bash/i.test(String(name))) ok(`shell for commands: ${name} (Git Bash)`);
    else if (/pwsh|powershell/i.test(String(name))) warn(`shell for commands: ${name} — works, but Git Bash is better for the model; install Git for Windows (https://git-scm.com/download/win)`);
    else warn("shell for commands: cmd.exe — install Git for Windows so commands run in bash (https://git-scm.com/download/win)");
    if (!process.env.WT_SESSION && !process.env.TERM_PROGRAM) warn("legacy console detected — Windows Terminal renders this tool's output better (Microsoft Store: Windows Terminal)");
  }
  else bad(`Node.js ${process.version} — needs 20+. Install from https://nodejs.org or: nvm install 20`);

  // Playwright present (the one runtime dependency)
  try {
    const pw = require("playwright/package.json") as { version: string };
    ok(`playwright ${pw.version} (drives your installed Chrome; no browser download needed)`);
  } catch {
    bad("playwright is not installed — run `npm install` in the app directory, or re-run the installer");
  }

  // Chrome
  const chrome =
    process.env.GEMINI_CODE_CHROME ||
    (process.platform === "darwin"
      ? ["/Applications/Google Chrome.app", path.join(process.env.HOME ?? "", "Applications/Google Chrome.app")].find((p) => existsSync(p))
      : findChromeExecutable());
  if (chrome) ok(`${/msedge/i.test(chrome) ? "Microsoft Edge (Chromium — works like Chrome here)" : "Google Chrome"}: ${chrome}`);
  else bad(process.platform === "win32"
    ? "Neither Google Chrome nor Microsoft Edge found — install one, or set GEMINI_CODE_CHROME to the browser's full path"
    : "Google Chrome not found — install it from https://google.com/chrome, or set GEMINI_CODE_CHROME to its path");

  // Profile + home
  const profile = resolveProfileDir();
  if (existsSync(profile)) ok(`Chrome profile: ${profile} (holds your Gemini sign-in — never share it)`);
  else warn(`Chrome profile not created yet: ${profile} — the first run makes it and asks you to sign in`);

  // Config
  const user = readConfigFile(userConfigPath());
  const project = readConfigFile(projectConfigPath());
  ok(
    `config: ${Object.keys(user).length ? userConfigPath() : `none at ${userConfigPath()} (defaults apply)`}` +
      (Object.keys(project).length ? ` + ${projectConfigPath()}` : "")
  );
  ok(`model: ${process.env.GEMINI_CODE_MODEL ?? DEFAULT_MODEL_ALIAS}${process.env.GEMINI_CODE_MODEL ? "" : " (default)"}`);
  if (process.env.GEMINI_CODE_AUTO_APPROVE === "1") warn("auto-approve is ON — writes and commands run without asking");

  // PATH
  const home = homeDir();
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((d) => existsSync(path.join(d, process.platform === "win32" ? "gemini-code.cmd" : "gemini-code")));
  if (onPath) ok("gemini-code is on your PATH");
  else warn(`gemini-code isn't on your PATH yet (home: ${home}) — the setup script prints the line to add`);

  // Debug Chrome + sign-in
  if (await isChromeReachable()) {
    ok(`a debug Chrome is listening on port ${DEBUG_PORT}`);
    const driver = new GeminiDriver();
    try {
      await driver.attach();
      const loggedIn = await driver.isLoggedIn();
      if (loggedIn) ok("Gemini session: signed in");
      else warn("Gemini session: signed OUT — sign in by hand in that Chrome window (gemini-code open-chrome)");
    } catch (err) {
      warn(`couldn't attach to it: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      await driver.close().catch(() => undefined);
    }
  } else {
    warn(`no debug Chrome on port ${DEBUG_PORT} yet — \`gemini-code\` launches one; sign in the first time`);
  }

  console.log("");
  if (fatal) {
    console.log(`  ${c.red(`${fatal} problem(s) must be fixed before gemini-code can run.`)}\n`);
    process.exitCode = 1;
  } else {
    console.log(`  ${c.green("Ready.")} Run ${c.bold("gemini-code")} in any project.\n`);
  }
}
