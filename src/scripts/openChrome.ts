import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveProfileDir } from "../driver/GeminiDriver.js";

export const DEBUG_PORT = 9222;

/**
 * Launches a real, completely normal Google Chrome window — no automation
 * flags, no Playwright involvement — with remote debugging enabled so a
 * later `gemini-code` / `gemini-code login` can attach to it. Log in to
 * Gemini by hand in the window this opens, exactly like you always do;
 * Google's sign-in flow never sees anything automated, because at this
 * point nothing is.
 *
 * Uses a dedicated profile directory (not your everyday Chrome profile),
 * both because Chrome requires a non-default profile to allow remote
 * debugging at all, and to keep this cleanly separate from your normal
 * browsing — it will not touch your regular Chrome windows or data.
 */
/** True when a debug-enabled Chrome is already accepting CDP connections. */
export async function isChromeReachable(port = DEBUG_PORT, timeoutMs = 1_500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes sure a debug-enabled Chrome is running, launching one if it isn't.
 *
 * Launching a browser is not the same thing as automating a login — this
 * only starts the window. Signing in stays manual (and, because the profile
 * persists cookies, is a one-time thing rather than a per-run step).
 *
 * Returns true if it had to launch one, so the caller can explain the wait.
 */
export async function ensureChromeRunning(log: (msg: string) => void = console.log): Promise<boolean> {
  if (await isChromeReachable()) return false;

  log("No debug Chrome found — launching one...");
  launchChrome();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 750));
    if (await isChromeReachable()) return true;
  }
  throw new Error(
    `Launched Chrome but port ${DEBUG_PORT} never came up. Try \`gemini-code open-chrome\` by hand, ` +
      `and check no other Chrome is already using the profile directory.`
  );
}

/**
 * Finds Chrome's executable on Windows and Linux.
 *
 * macOS is handled separately via `open -a`, which resolves the app by name
 * regardless of where it's installed.
 */
export function findChromeExecutable(): string | undefined {
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    // Chrome first; then Microsoft Edge, which is Chromium too, speaks the
    // same DevTools protocol, and is on every Windows machine — so a
    // laptop without Chrome still works out of the box.
    const candidates = [
      path.join(pf, "Google/Chrome/Application/chrome.exe"),
      path.join(pf86, "Google/Chrome/Application/chrome.exe"),
      path.join(local, "Google/Chrome/Application/chrome.exe"),
      path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
      path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
      path.join(local, "Microsoft/Edge/Application/msedge.exe"),
    ];
    return candidates.find((p) => p && existsSync(p));
  }
  // Linux: the usual names, in order of preference.
  const linux = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
  return linux.find((p) => existsSync(p));
}

/** Spawns the browser window (no waiting, no output). */
function launchChrome(): void {
  const profileDir = resolveProfileDir();
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "https://gemini.google.com/app",
  ];

  let command: string;
  let argv: string[];

  if (process.platform === "darwin") {
    // `open -n` forces a separate instance, so this never disturbs the
    // user's everyday Chrome windows.
    command = "open";
    argv = ["-n", "-a", "Google Chrome", "--args", ...args];
  } else {
    const exe = findChromeExecutable();
    if (!exe) {
      throw new Error(
        process.platform === "win32"
          ? "Couldn't find chrome.exe or msedge.exe. Install Google Chrome or Microsoft Edge, or set GEMINI_CODE_CHROME to the browser's full path."
          : "Couldn't find Chrome. Install google-chrome or chromium, or set GEMINI_CODE_CHROME to its path."
      );
    }
    command = process.env.GEMINI_CODE_CHROME || exe;
    argv = args;
  }

  const child = spawn(command, argv, { stdio: "ignore", detached: true });
  child.unref();
}

export function openChrome(): void {
  const profileDir = resolveProfileDir();

  console.log(`[gemini-code] Launching a normal Google Chrome window (debug port ${DEBUG_PORT})`);
  console.log(`[gemini-code] Profile: ${profileDir}`);
  console.log(
    "\nSign in to Gemini by hand in the window that opens — this is your real Chrome, not an " +
      "automated one, so Google's sign-in works normally. Once you're signed in, leave this window " +
      "open and run `gemini-code` in another terminal.\n"
  );

  try {
    launchChrome();
  } catch (err) {
    console.error("[gemini-code]", (err as Error).message);
    process.exit(1);
  }
}
