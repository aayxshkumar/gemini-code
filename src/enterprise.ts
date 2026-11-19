/**
 * Choosing and remembering the Gemini Enterprise link — shared by the REPL
 * (first-start prompt, `--enterprise`, `/enterprise`), `open-chrome` and
 * `gemini-code config`. The driver itself only reads the environment
 * variable, through driver/site.ts.
 */
import readline from "node:readline/promises";
import { parseEnterpriseUrl, type EnterpriseLink } from "./driver/site.js";
import { readConfigFile, userConfigPath, writeUserConfig } from "./config.js";

export const ENTERPRISE_ENV = "GEMINI_CODE_ENTERPRISE_URL";

/** Saves the link (or "off") to ~/.gemini-code/config.json, keeping every other setting. */
export function saveEnterpriseSetting(value: string): void {
  const config = readConfigFile(userConfigPath());
  config.enterprise = value;
  writeUserConfig(config);
}

/**
 * Applies a link for this process and, unless `persist` is false, for later
 * runs too. "off" goes back to consumer Gemini. Returns the parsed link, or
 * undefined for "off". Throws on a link that can't be one.
 */
export function setEnterprise(raw: string, persist = true): EnterpriseLink | undefined {
  const off = /^(off|none|false|0|consumer)$/i.test(raw.trim());
  const link = off ? undefined : parseEnterpriseUrl(raw);
  process.env[ENTERPRISE_ENV] = link ? link.url : "off";
  if (persist) saveEnterpriseSetting(link ? link.url : "off");
  return link;
}

/** Has the user ever answered — a link, or "off"? Env, project or user config all count. */
export function enterpriseConfigured(): boolean {
  return (process.env[ENTERPRISE_ENV] ?? "").trim() !== "";
}

/**
 * The first-start question: where do you sign in? Asked once, in a terminal,
 * when nothing is configured. A blank answer means consumer Gemini and is
 * remembered as "off", so it isn't asked again (`/enterprise <url>` changes it).
 */
export async function askForEnterpriseLink(): Promise<EnterpriseLink | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      "\nWhere do you sign in to Gemini?\n" +
        "  • Gemini Enterprise: paste your organisation's link, e.g.\n" +
        "      https://vertexaisearch.cloud.google.com/home/cid/<id>\n" +
        "  • gemini.google.com: just press Enter\n" +
        "(Saved to ~/.gemini-code/config.json. Change it later with /enterprise <link> or /enterprise off.)"
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await rl.question("Gemini Enterprise link › ")).trim();
      if (!answer) {
        setEnterprise("off");
        return undefined;
      }
      try {
        return setEnterprise(answer);
      } catch (err) {
        console.log(`  ${(err as Error).message}`);
      }
    }
    console.log("  Using gemini.google.com for now.");
    process.env[ENTERPRISE_ENV] = "off";
    return undefined;
  } finally {
    rl.close();
  }
}
