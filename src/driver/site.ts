/**
 * Which Gemini the agent drives: the consumer web app at gemini.google.com,
 * or an organisation's Gemini Enterprise (formerly Agentspace) app, which
 * lives at a per-organisation link such as
 *
 *   https://vertexaisearch.cloud.google.com/home/cid/<uuid>
 *   https://business.gemini.google/home/cid/<uuid>
 *
 * The link is the only thing that identifies the organisation's app, so the
 * user gives it once — `--enterprise <url>`, `/enterprise <url>` in the REPL,
 * the first-start prompt, `gemini-code config set enterprise <url>`, or the
 * desktop app's settings — and everything that used to hard-code
 * gemini.google.com asks this module instead.
 *
 * Read at call time from GEMINI_CODE_ENTERPRISE_URL, so `/enterprise` can
 * switch a running session without a restart.
 */

export const CONSUMER_URL = "https://gemini.google.com/app";

/** Hosts Google serves Gemini Enterprise from. Others are accepted with a warning. */
const KNOWN_ENTERPRISE_HOSTS = [/(^|\.)vertexaisearch\.cloud\.google\.com$/i, /(^|\.)gemini\.google$/i, /(^|\.)cloud\.google\.com$/i];

/** Hosts a signed-out Enterprise session is redirected to. */
const SIGN_IN_HOSTS = [/^accounts\.google\.com$/i, /(^|\.)auth\.cloud\.google$/i, /^auth\.cloud\.google\.com$/i, /^login\./i, /^sso\./i];

export interface EnterpriseLink {
  /** The link as it should be opened: https, no trailing fragment. */
  url: string;
  host: string;
  /** The /cid/<id> part, which tells one organisation's app from another. */
  cid?: string;
  /** False for a host Google isn't known to use; still allowed, just flagged. */
  knownHost: boolean;
}

/**
 * Validates and normalises a Gemini Enterprise link. Accepts it with or
 * without "https://", since people paste it from the address bar either way.
 * Throws with a readable reason when it can't be a link at all.
 */
export function parseEnterpriseUrl(raw: string): EnterpriseLink {
  let text = raw.trim().replace(/^["'<]+|[">']+$/g, "");
  if (!text) throw new Error("The Gemini Enterprise link is empty.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${raw.trim()}" isn't a link. Paste the address of your Gemini Enterprise page, e.g. https://vertexaisearch.cloud.google.com/home/cid/<id>.`);
  }
  if (url.protocol !== "https:") throw new Error(`The Gemini Enterprise link must be https, not ${url.protocol.replace(":", "")}.`);
  if (/^gemini\.google\.com$/i.test(url.hostname)) {
    throw new Error("That's the consumer Gemini app, not Gemini Enterprise. Use `/enterprise off` to go back to it.");
  }
  url.hash = "";
  const cid = url.pathname.match(/\/cid\/([^/?#]+)/i)?.[1];
  return {
    url: url.toString(),
    host: url.hostname.toLowerCase(),
    cid,
    knownHost: KNOWN_ENTERPRISE_HOSTS.some((re) => re.test(url.hostname)),
  };
}

/** The configured Enterprise link, or undefined for consumer Gemini. A bad value is ignored, loudly, once. */
let warnedBad = "";
export function enterpriseLink(env = process.env.GEMINI_CODE_ENTERPRISE_URL): EnterpriseLink | undefined {
  const raw = (env ?? "").trim();
  if (!raw || /^(off|none|false|0)$/i.test(raw)) return undefined;
  try {
    return parseEnterpriseUrl(raw);
  } catch (err) {
    if (warnedBad !== raw) {
      warnedBad = raw;
      console.error(`gemini-code: ignoring GEMINI_CODE_ENTERPRISE_URL — ${(err as Error).message}`);
    }
    return undefined;
  }
}

export function isEnterprise(): boolean {
  return enterpriseLink() !== undefined;
}

/** Where a fresh thread starts. */
export function appUrl(): string {
  return enterpriseLink()?.url ?? CONSUMER_URL;
}

/** A short name for messages: "Gemini" or "Gemini Enterprise". */
export function siteName(): string {
  return isEnterprise() ? "Gemini Enterprise" : "Gemini";
}

/**
 * Is this tab on the app we drive? For Enterprise, the same host and — when
 * the link has one — the same /cid/, so a tab on another organisation's app
 * (or the consumer app) isn't claimed.
 */
export function isAppPage(pageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  const link = enterpriseLink();
  if (!link) return /^gemini\.google\.com$/i.test(url.hostname);
  if (url.hostname.toLowerCase() !== link.host) return false;
  return !link.cid || url.pathname.includes(`/cid/${link.cid}`);
}

/** Is this page a sign-in step (Google account, workforce identity, SSO)? */
export function isSignInPage(pageUrl: string): boolean {
  try {
    return SIGN_IN_HOSTS.some((re) => re.test(new URL(pageUrl).hostname));
  } catch {
    return false;
  }
}
