/**
 * Command-line flag parsing, kept out of cli.ts so tests can import it.
 * cli.ts runs the agent as a side effect of being imported, so a test that
 * imported a helper from it started a whole session and hung.
 */

/** Reads a `--name value` / `--name=value` flag. */
function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length).trim() || undefined;
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) return argv[i + 1]?.trim() || undefined;
  return undefined;
}

/**
 * How a Gem is used.
 *
 * "reference" (the default) keeps the coding thread a plain Gemini chat and
 * lets the agent consult the Gem through the ask_gem tool — the Gem is
 * background knowledge, not the thing running the session. "inside" runs the
 * whole conversation in the Gem, which also subjects every turn to the Gem's
 * own instructions.
 */
export type GemMode = "reference" | "inside";

export function gemModeFlag(argv: string[], env = process.env.GEMINI_CODE_GEM_MODE): GemMode {
  const raw = (flagValue(argv, "gem-mode") ?? env ?? "reference").toLowerCase();
  return raw === "inside" ? "inside" : "reference";
}

/** Reads `--model <alias or picker label>`; `--model=` works too. */
export function modelFlag(argv: string[]): string | undefined {
  return flagValue(argv, "model");
}

/** `--choose-model` / `--pick`: show the live picker and ask, even if a model is configured. */
export function chooseModelFlag(argv: string[]): boolean {
  return argv.includes("--choose-model") || argv.includes("--pick") || argv.includes("--pick-model");
}

/** Reads `--gem <name>` / `--gem=<name>`. */
export function gemFlag(argv: string[]): string | undefined {
  return flagValue(argv, "gem");
}

export interface ServeArgs {
  host: string;
  port: number;
  tabs: number;
  apiKey?: string;
  allowedOrigins: string[];
}

/**
 * `gemini-code serve` options, from flags first and then the environment.
 * Throws on a value that can't be used, so a typo fails at startup instead of
 * the server quietly listening somewhere unexpected.
 */
export function serveArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServeArgs {
  const host = flagValue(argv, "host") ?? env.GEMINI_CODE_API_HOST ?? "127.0.0.1";

  const portRaw = flagValue(argv, "port") ?? env.GEMINI_CODE_API_PORT ?? "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port "${portRaw}".`);

  const tabsRaw = flagValue(argv, "tabs") ?? env.GEMINI_CODE_API_TABS ?? "2";
  const tabs = Number(tabsRaw);
  if (!Number.isInteger(tabs) || tabs < 1 || tabs > 8) throw new Error(`--tabs must be 1-8, got "${tabsRaw}".`);

  const apiKey = flagValue(argv, "api-key") ?? (env.GEMINI_CODE_API_KEY || undefined);

  const origins = [
    ...argv.flatMap((a, i) =>
      a === "--cors-origin" ? [argv[i + 1] ?? ""] : a.startsWith("--cors-origin=") ? [a.slice("--cors-origin=".length)] : []
    ),
    ...(env.GEMINI_CODE_API_CORS ?? "").split(","),
  ]
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  return { host, port, tabs, apiKey, allowedOrigins: [...new Set(origins)] };
}
