export interface ModelChoice {
  /** Canonical name shown in the CLI. */
  name: string;
  /** What the user can type after `/model`. */
  aliases: string[];
  /** One-liner for `/help`. */
  hint: string;
  /**
   * Matches the picker's menu-item text in the live UI. Deliberately keyed
   * on keywords rather than exact labels: the menu carries version numbers
   * ("3.5 Flash-Lite", "3.8 Thinking", "3.1 Pro") that Google bumps
   * regularly, and an exact-match table would silently break on every
   * release.
   */
  matches: (menuItemText: string) => boolean;
  /**
   * Aliases to try, in order, when this model isn't in the picker at all.
   * Google shows different menus to different accounts and tabs, so the
   * preferred model being absent must degrade to the closest thing rather
   * than leave the tab on whatever it happened to start with.
   */
  fallbacks?: string[];
}

/**
 * A picker label that is itself a model named "<version> Thinking" — e.g.
 * "3.8 Thinking" with a description on the next line. Distinct from the
 * older "Standard thinking" / "High thinking" tiers and from the "Extended
 * thinking" toggle, which both also contain the word.
 */
const THINKING_MODEL_RE = /^\s*(?:\d+(?:\.\d+)?\s+)?thinking\b(?!\s*level)/i;

/**
 * Base models — mutually exclusive. Order matters: Flash-Lite must be
 * tested before the looser Flash rule, and Thinking before Pro (a Thinking
 * entry can carry a "complex problem solving" blurb that Pro's rule reads
 * as its own).
 *
 * "Extended thinking" is deliberately NOT here: it's a separate toggle that
 * layers on top of whichever base model is selected (the picker reports
 * e.g. "Flash Extended"), so it gets its own control. Verified live.
 */
export const MODELS: ModelChoice[] = [
  {
    name: "Auto",
    aliases: ["auto"],
    hint: "lets Gemini pick among its current models",
    // The 2026 picker's first entry: "Auto — Gemini 3 models".
    matches: (t) => /^\s*auto\b/i.test(t.split("\n")[0]),
  },
  {
    name: "Flash-Lite",
    aliases: ["fastest", "flash-lite", "lite"],
    hint: "fastest, lightest",
    matches: (t) => /flash[\s-]?lite/i.test(t),
  },
  {
    name: "Thinking",
    aliases: ["thinking", "think", "3.8"],
    hint: "3.8 Thinking — reasons before it answers (default)",
    // The newest picker lists the reasoning model as "<version> Thinking"
    // (currently "3.8 Thinking"). Matched on the first line only, so the
    // description under it can't accidentally satisfy another rule.
    matches: (t) => THINKING_MODEL_RE.test(t.split("\n")[0]) && !/standard|high|extended/i.test(t.split("\n")[0]),
    // Pickers without a standalone Thinking model: Auto (whose depth the
    // Thinking level setting controls — see THINKING_LEVELS) comes first,
    // since Pro is often locked behind a paid tier there.
    fallbacks: ["auto", "pro", "fast"],
  },
  {
    name: "Flash",
    aliases: ["fast", "flash"],
    hint: "all-around help, quickest useful answers",
    // Two picker variants are live at once. One lists "Flash" / "Pro"; the
    // other (seen on freshly opened tabs) lists "Standard thinking — Quick
    // everyday help" / "High thinking — Complex problem solving" with no
    // model family named at all. Match both, or tabs on the newer menu
    // silently stay on whatever model they started with.
    matches: (t) => (/flash/i.test(t) && !/lite/i.test(t)) || /standard thinking|everyday help/i.test(t),
  },
  {
    name: "Pro",
    aliases: ["pro"],
    hint: "advanced reasoning, slowest",
    // The blurb rule is for the menu with unnamed tiers; a "<version>
    // Thinking" entry can carry the same blurb and is not Pro.
    matches: (t) =>
      /\bpro\b/i.test(t) || (/high thinking|complex problem/i.test(t) && !THINKING_MODEL_RE.test(t.split("\n")[0])),
    fallbacks: ["thinking"],
  },
  {
    name: "Argon",
    aliases: ["argon", "4"],
    hint: "Gemini 4 Argon — complex tasks (paid tiers)",
    matches: (t) => /\bargon\b/i.test(t.split("\n")[0]),
    fallbacks: ["pro", "thinking"],
  },
];

/**
 * The picker's "Thinking level" submenu (Low / Medium / High), separate from
 * the model. Google persists it per account, so setting it once in the main
 * tab covers worker tabs too. Deep by default: the account's own default was
 * Low, and this tool exists for work worth thinking about.
 */
export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

export function resolveThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  const needle = (raw ?? "").trim().toLowerCase();
  if (/^(hi|max|deep)/.test(needle)) return "high";
  if (/^(med|mid|bal)/.test(needle)) return "medium";
  if (/^(lo|min|quick|fast)/.test(needle)) return "low";
  return THINKING_LEVELS.find((l) => l === needle);
}

/** The submenu entry that opens the levels, and how each level is labelled. */
export const THINKING_LEVEL_MENU = {
  entry: /thinking level/i,
  item: (level: ThinkingLevel, text: string) => new RegExp(`^\\s*${level}(?![\\w-])`, "i").test(text.split("\n")[0]),
};

/** The separate on/off toggle that stacks on the base model. */
export const EXTENDED_THINKING = {
  name: "Extended thinking",
  // Not bare "thinking": the newer pickers name whole models "Standard
  // thinking", "High thinking" and "3.8 Thinking", and matching those would
  // click a model while trying to flip this toggle.
  matches: (t: string) => {
    const first = t.split("\n")[0];
    if (/extended/i.test(first)) return true;
    return /thinking/i.test(first) && !/standard|high|level/i.test(first) && !THINKING_MODEL_RE.test(first);
  },
  /** The picker's label appends this word while the toggle is on. */
  labelMarker: /extended/i,
};

/** What a fresh session starts on. Override with GEMINI_CODE_MODEL or the config file. */
export const DEFAULT_MODEL_ALIAS = "thinking";
/**
 * The Thinking model already reasons; stacking the Extended toggle on top
 * only slows it down. Left off unless asked for with /thinking on.
 */
export const DEFAULT_EXTENDED_THINKING = false;

export function resolveModel(alias: string): ModelChoice | undefined {
  const needle = alias.trim().toLowerCase();
  return MODELS.find((m) => m.aliases.includes(needle) || m.name.toLowerCase() === needle);
}

/** The model to try, then each fallback in turn, with no repeats. */
export function modelWithFallbacks(choice: ModelChoice): ModelChoice[] {
  const chain: ModelChoice[] = [choice];
  for (const alias of choice.fallbacks ?? []) {
    const next = resolveModel(alias);
    if (next && !chain.includes(next)) chain.push(next);
  }
  return chain;
}

export function modelHelp(): string {
  return MODELS.map((m) => `  ${m.aliases[0].padEnd(10)} ${m.name} — ${m.hint}`).join("\n");
}
