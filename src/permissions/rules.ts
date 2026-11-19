/**
 * Permission rules: what may run, be written or be fetched without asking,
 * and what is refused outright. In ~/.gemini-code/config.json or a
 * project's .gemini-code.json:
 *
 *   "permissions": {
 *     "allow": { "commands": ["git status", "npm test", "git diff *"], "writes": ["src/**"], "hosts": ["api.github.com"] },
 *     "deny":  { "commands": ["git push *", "rm -rf *"], "writes": [".env", "**\/secrets/**"], "hosts": ["*.internal"] }
 *   }
 *
 * Deny refuses without asking, and wins over allow and over
 * GEMINI_CODE_AUTO_APPROVE. Allow skips the question. Anything else asks.
 *
 *   commands  words; `*` as a word matches any rest of the command (or
 *             none), and inside a word is a glob: "git *", "npm run test*"
 *   writes    gitignore-style globs from the project root: "src/**",
 *             ".env" (any .env), "/build" (only the top one)
 *   hosts     "github.com" (exactly), "*.github.com" (any subdomain),
 *             "*" (any); an optional ":port"
 *
 * A project's deny rules always apply. Its allow rules apply only after the
 * user trusts that project (see trust.ts): a cloned repository must not be
 * able to switch the questions off by itself.
 */

export type RuleKind = "commands" | "writes" | "hosts";
export const RULE_KINDS: RuleKind[] = ["commands", "writes", "hosts"];

export interface Rule {
  kind: RuleKind;
  effect: "allow" | "deny";
  pattern: string;
  /** Where it came from: a file path. */
  source: string;
}

export interface RuleSet {
  rules: Rule[];
  /** Problems found while reading (bad types, empty patterns), for /permissions. */
  errors: string[];
}

export const emptyRules = (): RuleSet => ({ rules: [], errors: [] });

/** Reads the `permissions` value of one config file. */
export function readRules(value: unknown, source: string, only?: "deny"): RuleSet {
  const set = emptyRules();
  if (value === undefined) return set;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    set.errors.push(`${source}: "permissions" must be an object with "allow" and/or "deny"`);
    return set;
  }
  for (const [effect, lists] of Object.entries(value as Record<string, unknown>)) {
    if (effect !== "allow" && effect !== "deny") {
      set.errors.push(`${source}: unknown key "permissions.${effect}" (use allow or deny)`);
      continue;
    }
    if (only && effect !== only) continue;
    if (typeof lists !== "object" || lists === null || Array.isArray(lists)) {
      set.errors.push(`${source}: "permissions.${effect}" must be an object of lists`);
      continue;
    }
    for (const [kind, patterns] of Object.entries(lists as Record<string, unknown>)) {
      if (!RULE_KINDS.includes(kind as RuleKind)) {
        set.errors.push(`${source}: unknown list "permissions.${effect}.${kind}" (use commands, writes or hosts)`);
        continue;
      }
      if (!Array.isArray(patterns)) {
        set.errors.push(`${source}: "permissions.${effect}.${kind}" must be a list of strings`);
        continue;
      }
      for (const p of patterns) {
        if (typeof p !== "string" || !p.trim()) {
          set.errors.push(`${source}: an empty or non-string entry in permissions.${effect}.${kind} was ignored`);
          continue;
        }
        set.rules.push({ kind: kind as RuleKind, effect, pattern: p.trim(), source });
      }
    }
  }
  return set;
}

export function mergeRules(...sets: RuleSet[]): RuleSet {
  return { rules: sets.flatMap((s) => s.rules), errors: sets.flatMap((s) => s.errors) };
}
