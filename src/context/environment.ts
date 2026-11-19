import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SHELL_NAME } from "../tools/bash.js";

/**
 * The machine the agent's commands run on, for the primer.
 *
 * Gemini otherwise writes for whatever it guesses: bash on Windows' cmd.exe,
 * GNU `sed -i` on a Mac, `python` where only `python3` exists. Each of those
 * fails a turn, and a turn is a whole web-UI message.
 */
export interface EnvironmentInfo {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  shell: string;
  /** Commands worth knowing about, and whether each is on PATH. */
  commands: Record<string, boolean>;
}

const PROBED = ["python3", "python", "pip3", "pip", "node", "npm", "git", "docker", "brew", "winget"];

/** Like `which`, without running anything. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return dirs.some((dir) => extensions.some((ext) => existsSync(path.join(dir, command + ext.toLowerCase())) || existsSync(path.join(dir, command + ext))));
}

/**
 * Python has to be run to be found. On Windows, a Store install is an app
 * link that a file check can't see, and a PC without Python has a fake
 * python.exe that only opens the Store, so looking for the file is wrong both
 * ways. Running it tells them apart.
 */
function runs(command: string): boolean {
  const result = spawnSync(command, ["--version"], { timeout: 3_000, windowsHide: true, stdio: "ignore" });
  return result.status === 0;
}

let detected: EnvironmentInfo | undefined;

/** Measured once a run: it takes most of a second, and every worker's primer asks. */
export function detectEnvironment(): EnvironmentInfo {
  detected ??= measureEnvironment();
  return detected;
}

function measureEnvironment(): EnvironmentInfo {
  const commands = Object.fromEntries(PROBED.map((command) => [command, onPath(command)]));
  for (const python of ["python3", "python", "pip3", "pip"]) commands[python] = runs(python);
  return {
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    shell: SHELL_NAME,
    commands,
  };
}

function osName(platform: NodeJS.Platform): string {
  return { win32: "Windows", darwin: "macOS", linux: "Linux" }[platform as string] ?? platform;
}

/** How to write commands for this shell, which is what actually goes wrong. */
function shellRules(info: EnvironmentInfo): string[] {
  const shell = info.shell.toLowerCase();
  if (/powershell|pwsh/.test(shell)) {
    return [
      "run_bash uses PowerShell, so write PowerShell: Get-ChildItem, Remove-Item, $env:NAME, and `;` between commands.",
      "There is no `&&` in Windows PowerShell 5, and no rm -rf, grep or export.",
    ];
  }
  if (/^cmd/.test(shell)) {
    return [
      "run_bash uses cmd.exe, so write cmd: dir, del, copy, set NAME=value, and && between commands.",
      "There is no ls, rm, grep, cat or export here, and paths use backslashes.",
    ];
  }
  if (info.platform === "win32") {
    return [
      "run_bash uses Git Bash, so write bash: ls, rm -rf, grep, export.",
      "It's still Windows underneath: give paths as C:/Users/... with forward slashes, and Windows programs " +
        "(.exe) are what's installed. Files you create may need CRLF line endings for Windows tools.",
    ];
  }
  const rules = [`run_bash uses ${info.shell}, so write POSIX shell.`];
  if (info.platform === "darwin") {
    rules.push(
      "macOS has BSD tools, not GNU: `sed -i ''` (with the empty string) to edit in place, no `grep -P`, " +
        "`date` and `stat` take different flags. `open` opens a file or URL."
    );
  } else if (info.platform === "linux") {
    rules.push("Linux has GNU tools. `xdg-open` opens a file or URL.");
  }
  return rules;
}

/** The Environment section of the primer. */
export function describeEnvironment(info: EnvironmentInfo = detectEnvironment()): string {
  const have = (command: string) => info.commands[command];
  // `python` first on Windows, where it's what installers and docs use.
  const order = info.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  const python = order.find(have);
  const pip = python ? `\`${python} -m pip\`` : undefined;
  const available = PROBED.filter(have).join(", ");
  const missing = ["python", "node", "git"].filter((c) => c === "python" ? !python : !have(c));

  return [
    `ENVIRONMENT: ${osName(info.platform)} ${info.release} (${info.arch}). Write every command and path for this ` +
      `system, not another one.`,
    ...shellRules(info).map((rule) => `- ${rule}`),
    ...(python ? [`- Python is \`${python}\`; install packages with ${pip}.`] : []),
    `- On PATH: ${available || "none of the usual tools"}.${missing.length ? ` Not installed: ${missing.join(", ")}.` : ""}`,
  ].join("\n");
}
