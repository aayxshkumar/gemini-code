/**
 * Persistent settings, so a new machine needs one `gemini-code config set`
 * (or none) instead of exporting a row of environment variables in every
 * shell. Imported FIRST by cli.ts, before any module that reads
 * process.env at load time, and it only fills in variables that aren't
 * already set — the environment always wins over the file.
 *
 * Two files, project first:
 *   <project>/.gemini-code.json      per-project overrides (commit if useful)
 *   ~/.gemini-code/config.json       your defaults on this machine
 *
 * Keys are the friendly names below, or any raw GEMINI_CODE_* variable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Friendly key -> environment variable it sets. */
export const CONFIG_KEYS: Record<string, { env: string; hint: string }> = {
  model: { env: "GEMINI_CODE_MODEL", hint: "thinking (default) | auto | fast | fastest | pro | argon, or a picker label like \"3.8 Thinking\"" },
  thinkingLevel: { env: "GEMINI_CODE_THINKING_LEVEL", hint: "low | medium | high (default) — the picker's Thinking level submenu" },
  thinking: { env: "GEMINI_CODE_THINKING", hint: "on | off — the Extended thinking toggle, where the picker has one" },
  addDirs: { env: "GEMINI_CODE_ADD_DIRS", hint: "extra workspace roots (dependency repos), e.g. [\"../shared-lib\"]" },
  compactTurns: { env: "GEMINI_CODE_COMPACT_TURNS", hint: "exchanges per thread before a context reset with handoff (default 40, 0 = off)" },
  workers: { env: "GEMINI_CODE_MAX_WORKERS", hint: "parallel worker tabs (default 3)" },
  orchestrator: { env: "GEMINI_CODE_ORCHESTRATOR", hint: "true (default) | false — one tab does everything when false" },
  autoApprove: { env: "GEMINI_CODE_AUTO_APPROVE", hint: "false (default) | edits | edits,commands | all — what runs without a y/N" },
  maxTurns: { env: "GEMINI_CODE_MAX_TURNS", hint: "tool-call turns one task may take (default 60)" },
  shell: { env: "GEMINI_CODE_SHELL", hint: "shell for run_bash (default: Git Bash on Windows, else sh)" },
  chrome: { env: "GEMINI_CODE_CHROME", hint: "path to the Chrome executable, if it isn't found automatically" },
  profile: { env: "GEMINI_CODE_PROFILE", hint: "Chrome profile dir (default ~/.gemini-code/profile)" },
  gem: { env: "GEMINI_CODE_GEM", hint: "Gem to consult, by name or id" },
  responseTimeoutMs: { env: "GEMINI_CODE_RESPONSE_TIMEOUT_MS", hint: "how long to wait for a reply (default 300000)" },
  apiPort: { env: "GEMINI_CODE_API_PORT", hint: "port for `gemini-code serve` (default 8787)" },
  apiKey: { env: "GEMINI_CODE_API_KEY", hint: "bearer key for `gemini-code serve`" },
};

export function homeDir(): string {
  return process.env.GEMINI_CODE_HOME || path.join(os.homedir(), ".gemini-code");
}

export function userConfigPath(): string {
  return path.join(homeDir(), "config.json");
}

export function projectConfigPath(root = process.cwd()): string {
  return path.join(root, ".gemini-code.json");
}

export type ConfigFile = Record<string, string | number | boolean | string[]>;

export function readConfigFile(file: string): ConfigFile {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ConfigFile;
  } catch (err) {
    // A broken file must not take the whole CLI down; say so and ignore it.
    console.error(`gemini-code: ignoring ${file}: ${(err as Error).message}`);
    return {};
  }
}

/** The environment variable a friendly key (or raw variable name) controls. */
export function envNameFor(key: string): string | undefined {
  if (CONFIG_KEYS[key]) return CONFIG_KEYS[key].env;
  if (/^GEMINI_CODE_[A-Z0-9_]+$/.test(key)) return key;
  return undefined;
}

/** How a config value is spelt in the environment the code already reads. */
export function envValueFor(key: string, value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) return value.map(String).join(path.delimiter);
  if (typeof value === "boolean") {
    // Booleans in the existing env contract: ORCHESTRATOR is "0" to turn off,
    // AUTO_APPROVE is "1" to turn on, THINKING is on/off.
    if (key === "thinking") return value ? "on" : "off";
    return value ? "1" : "0";
  }
  const text = String(value).trim();
  // autoApprove takes words (edits, commands, all); the other booleans are 1/0.
  if (key === "autoApprove") return text;
  if (key !== "thinking" && /^(true|yes|on)$/i.test(text)) return "1";
  if (key !== "thinking" && /^(false|no|off)$/i.test(text)) return "0";
  return text;
}

/**
 * Applies both config files to process.env for variables not already set.
 * Returns which keys came from where, for `gemini-code config`.
 */
export function applyConfig(env: NodeJS.ProcessEnv = process.env): { source: Record<string, string> } {
  const source: Record<string, string> = {};
  const layers: [string, ConfigFile][] = [
    [projectConfigPath(), readConfigFile(projectConfigPath())],
    [userConfigPath(), readConfigFile(userConfigPath())],
  ];
  for (const [file, values] of layers) {
    for (const [key, value] of Object.entries(values)) {
      const name = envNameFor(key);
      if (!name || env[name] !== undefined) continue;
      env[name] = envValueFor(key, value);
      source[name] = file;
    }
  }
  return { source };
}

export function writeUserConfig(values: ConfigFile): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(userConfigPath(), JSON.stringify(values, null, 2) + "\n", "utf8");
}

/** Which env variables the config files supplied at startup, and from where. */
export const configSources: Readonly<Record<string, string>> = applyConfig().source;
