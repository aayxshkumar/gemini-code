/**
 * The deny / allow / ask decision for one command line, write path or URL.
 *
 * Commands: the line is split by its shell's rules (shellSyntax.ts). Deny
 * rules are checked against every command in it AND against what each one
 * really runs: through wrappers (sudo, env, xargs, timeout, nohup,
 * find -exec …), PowerShell aliases and cmd synonyms, a path to the program
 * (/usr/bin/git, git.exe), and strings handed to another shell (bash -c,
 * eval, pwsh -Command / -EncodedCommand, cmd /c, Invoke-Expression).
 * Redirections (> file) are checked against the write rules.
 *
 * Allow is stricter: EVERY command in the line must match an allow rule as
 * written, nothing may be uncertain, a wrapper's inner command must be
 * allowed too, and a redirect target must be an allowed write. So
 * `git status && rm -rf x` isn't approved by "git status".
 */
import path from "node:path";
import { compileWildmatch } from "../gitignore.js";
import type { Rule, RuleSet } from "./rules.js";
import { parseLine, type ParsedLine, type ShellFlavour, type SimpleCommand } from "./shellSyntax.js";

export type Verdict = "deny" | "allow" | "ask";

export interface Decision {
  verdict: Verdict;
  /** One line for the user and the model: which rule, or why it asks. */
  reason: string;
  rule?: Rule;
}

const ASK_NO_RULES: Decision = { verdict: "ask", reason: "" };

// ---------------------------------------------------------------- commands

/** PowerShell aliases and cmd synonyms, grouped: a rule for any one matches all. */
const SYNONYMS: string[][] = [
  ["remove-item", "rm", "del", "erase", "rd", "rmdir", "ri"],
  ["copy-item", "cp", "copy", "cpi"],
  ["move-item", "mv", "move", "mi"],
  ["rename-item", "ren", "rename", "rni"],
  ["set-content", "sc"],
  ["add-content", "ac"],
  ["new-item", "ni"],
  ["invoke-webrequest", "iwr", "curl", "wget"],
  ["invoke-restmethod", "irm"],
  ["invoke-expression", "iex"],
  ["start-process", "saps", "start"],
  ["get-childitem", "ls", "dir", "gci"],
  ["get-content", "cat", "type", "gc"],
];

function synonymsOf(name: string): string[] {
  const n = name.toLowerCase();
  return SYNONYMS.find((g) => g.includes(n)) ?? [n];
}

/** Commands that run another command given in their arguments. Returns the inner words, or undefined. */
function unwrap(words: string[]): string[] | undefined {
  const name = programName(words[0] ?? "");
  const rest = words.slice(1);
  const skipFlags = (ws: string[], withValue: string[] = []) => {
    let i = 0;
    while (i < ws.length && ws[i].startsWith("-")) {
      if (ws[i] === "--") return ws.slice(i + 1);
      if (withValue.includes(ws[i])) i++;
      i++;
    }
    return ws.slice(i);
  };
  switch (name) {
    case "sudo":
    case "doas":
      return skipFlags(rest, ["-u", "-g", "-C", "-h", "-p", "-U"]);
    case "env": {
      const r = skipFlags(rest, ["-u", "-C", "-S"]);
      let i = 0;
      while (i < r.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(r[i])) i++;
      return r.slice(i);
    }
    case "nice":
    case "ionice":
    case "stdbuf":
      return skipFlags(rest, ["-n", "-c"]);
    case "nohup":
    case "time":
    case "command":
    case "exec":
    case "builtin":
    case "chronic":
    case "call":
      return skipFlags(rest);
    case "timeout":
      return skipFlags(rest, ["-s", "-k"]).slice(1);
    case "xargs":
      return skipFlags(rest, ["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a"]);
    case "watch":
      return skipFlags(rest, ["-n", "-d"]);
    case "start":
      // cmd's start: an optional "title" first, then flags.
      return skipFlags(rest.filter((w, i) => !(i === 0 && w === "")), ["/d"]).filter((w) => !/^\/[a-z]+$/i.test(w));
    default:
      return undefined;
  }
}

/** The bare program name: no folder, no .exe/.cmd/.bat, lowercase where the OS ignores case. */
export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "");
}

/** Strings a command hands to another shell to run, with that shell's flavour. */
function handedToShell(words: string[]): { line: string; flavour: ShellFlavour }[] {
  const name = programName(words[0] ?? "").toLowerCase();
  const out: { line: string; flavour: ShellFlavour }[] = [];
  if (["bash", "sh", "dash", "zsh", "ksh", "ash", "busybox"].includes(name)) {
    const i = words.findIndex((w, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(w));
    if (i !== -1 && words[i + 1] !== undefined) out.push({ line: words[i + 1], flavour: "bash" });
  } else if (name === "eval") {
    out.push({ line: words.slice(1).join(" "), flavour: "bash" });
  } else if (name === "pwsh" || name === "powershell") {
    for (let i = 1; i < words.length; i++) {
      const w = words[i].toLowerCase();
      if (/^-(c|command)$/.test(w)) {
        out.push({ line: words.slice(i + 1).join(" "), flavour: "powershell" });
        break;
      }
      if (/^-(e|ec|enc|encodedcommand)$/.test(w) && words[i + 1]) {
        out.push({ line: Buffer.from(words[i + 1], "base64").toString("utf16le"), flavour: "powershell" });
        break;
      }
    }
  } else if (name === "cmd") {
    const i = words.findIndex((w) => /^\/[ck]$/i.test(w));
    if (i !== -1) out.push({ line: words.slice(i + 1).join(" "), flavour: "cmd" });
  } else if (name === "invoke-expression" || name === "iex") {
    out.push({ line: words.slice(1).join(" "), flavour: "powershell" });
  }
  return out;
}

/** Programs that run code given to them some other way (stdin, a script file): opaque to the rules. */
const SHELL_PROGRAMS = new Set(["bash", "sh", "dash", "zsh", "ksh", "ash", "fish", "pwsh", "powershell", "cmd", "eval", "iex", "invoke-expression", "source", "."]);

/** Assignments that change what a command does far beyond its arguments. */
const DANGEROUS_ENV = /^(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PATH|BASH_ENV|ENV|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|RUBYOPT|GIT_[A-Z_]+|PROMPT_COMMAND|IFS)=/;

function wordMatches(pattern: string, word: string, ci: boolean): boolean {
  if (!/[*?[]/.test(pattern)) return ci ? pattern.toLowerCase() === word.toLowerCase() : pattern === word;
  const re = compileWildmatch(pattern.replace(/\//g, "\\/"), ci);
  return !!re && re.test(word);
}

/**
 * Does a rule pattern match these words? `*` as a whole word matches the rest
 * (zero or more words) when it's last, or exactly one word elsewhere.
 * `forDeny`: the program name is compared without its folder or extension,
 * and through synonyms.
 */
export function commandMatches(pattern: string, words: string[], flavour: ShellFlavour, forDeny: boolean): boolean {
  const pw = pattern.trim().split(/\s+/);
  if (!words.length) return false;
  const ci = flavour !== "bash";
  const names = forDeny ? synonymsOf(programName(words[0])) : [words[0]];
  const patternNames = forDeny ? synonymsOf(programName(pw[0])) : [pw[0]];
  const nameOk = names.some((n) => patternNames.some((p) => wordMatches(p, n, ci || forDeny && flavour !== "bash")));
  if (!nameOk) return false;
  for (let i = 1; i < pw.length; i++) {
    if (pw[i] === "*" && i === pw.length - 1) return true;
    if (i >= words.length) return false;
    if (pw[i] !== "*" && !wordMatches(pw[i], words[i], ci)) return false;
  }
  return words.length === pw.length;
}

interface CommandView {
  words: string[];
  flavour: ShellFlavour;
  /** True for the command as written; false for one found inside a wrapper/shell string. */
  outer: boolean;
}

/** The command and everything it actually runs. */
function views(cmd: SimpleCommand, flavour: ShellFlavour, depth = 0, notes: string[] = []): CommandView[] {
  if (depth > 5) {
    notes.push("commands nested too deep to read");
    return [];
  }
  let words = cmd.words;
  // Leading FOO=1 assignments: deny sees the command after them.
  let i = 0;
  while (flavour === "bash" && i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
    if (DANGEROUS_ENV.test(words[i])) notes.push(`it sets ${words[i].split("=")[0]}`);
    i++;
  }
  if (i) {
    words = words.slice(i);
    if (!words.length) return [];
  }
  const out: CommandView[] = [{ words, flavour, outer: depth === 0 }];
  const inner = unwrap(words);
  if (inner?.length) {
    // find … -exec cmd … ; is handled below; here, plain wrappers.
    out.push(...views({ words: inner }, flavour, depth + 1, notes).map((v) => ({ ...v, outer: false })));
  }
  if (programName(words[0]).toLowerCase() === "find") {
    for (let k = 1; k < words.length; k++) {
      if (["-exec", "-execdir", "-ok", "-okdir"].includes(words[k])) {
        const end = words.findIndex((w, j) => j > k && (w === ";" || w === "+"));
        const body = words.slice(k + 1, end === -1 ? undefined : end);
        if (body.length) out.push(...views({ words: body }, flavour, depth + 1, notes).map((v) => ({ ...v, outer: false })));
      }
    }
  }
  for (const handed of handedToShell(words)) {
    const parsed = parseLine(handed.line, handed.flavour);
    notes.push(...parsed.uncertain.map((u) => `${u} in a command handed to another shell`));
    if (handed.line.includes("$") || handed.line.includes("%")) notes.push("a command handed to another shell uses variables");
    for (const c of parsed.commands) out.push(...views(c, handed.flavour, depth + 1, notes).map((v) => ({ ...v, outer: false })));
  }
  return out;
}

export interface CommandContext {
  flavour: ShellFlavour;
  /** For redirect targets. */
  cwd: string;
  root: string;
}

export function decideCommand(line: string, rules: RuleSet, ctx: CommandContext): Decision {
  const cmdRules = rules.rules.filter((r) => r.kind === "commands");
  const writeRules = rules.rules.filter((r) => r.kind === "writes");
  if (!cmdRules.length && !writeRules.length) return ASK_NO_RULES;

  const parsed: ParsedLine = parseLine(line, ctx.flavour);
  const notes: string[] = [...parsed.uncertain];
  const all = parsed.commands.map((c) => ({ cmd: c, views: views(c, ctx.flavour, 0, notes) }));

  // Deny first, on everything that runs.
  for (const { views: vs } of all) {
    for (const v of vs) {
      const hit = cmdRules.find((r) => r.effect === "deny" && commandMatches(r.pattern, v.words, v.flavour, true));
      if (hit) return { verdict: "deny", rule: hit, reason: `denied by "${hit.pattern}" (${hit.source})${v.outer ? "" : ` — it runs ${v.words.join(" ")}`}` };
    }
  }
  for (const target of parsed.redirects) {
    const d = decideWrite(path.resolve(ctx.cwd, target), rules, ctx.root);
    if (d.verdict === "deny") return { ...d, reason: `the redirect to ${target} is ${d.reason}` };
  }

  // Allow: every command, as written and through what it runs.
  if (!cmdRules.some((r) => r.effect === "allow")) return { verdict: "ask", reason: "no allow rule covers it" };
  if (notes.length) return { verdict: "ask", reason: `can't be checked safely: ${[...new Set(notes)].join("; ")}` };
  for (const { cmd, views: vs } of all) {
    if (cmd.dynamicName) return { verdict: "ask", reason: `the command name in "${cmd.words.join(" ")}" comes from an expansion` };
    for (const v of vs) {
      const name = programName(v.words[0]).toLowerCase();
      const ok = cmdRules.some((r) => r.effect === "allow" && commandMatches(r.pattern, v.words, v.flavour, false));
      if (!ok) return { verdict: "ask", reason: `"${v.words.join(" ")}" isn't covered by an allow rule` };
      if (SHELL_PROGRAMS.has(name) && !handedToShell(v.words).length && v.words.length > 1) {
        return { verdict: "ask", reason: `${v.words[0]} runs a script the rules can't see into` };
      }
    }
  }
  for (const target of parsed.redirects) {
    if (/^(\/dev\/null|nul|\$null)$/i.test(target)) continue;
    const d = decideWrite(path.resolve(ctx.cwd, target), rules, ctx.root);
    if (d.verdict !== "allow") return { verdict: "ask", reason: `it writes ${target}, which no write rule allows` };
  }
  if (!all.length) return { verdict: "ask", reason: "nothing to check" };
  return { verdict: "allow", reason: `allowed by ${[...new Set(all.map((a) => cmdRules.find((r) => r.effect === "allow" && commandMatches(r.pattern, a.views[0].words, ctx.flavour, false))?.pattern))].map((p) => `"${p}"`).join(", ")}` };
}

// ------------------------------------------------------------------- writes

/** Files a rule can never approve: changing them changes the rules or the history. */
function alwaysAsk(rel: string): boolean {
  return rel === ".gemini-code.json" || rel === ".git" || rel.startsWith(".git/") || rel === ".gemini-code-tmp" || rel.startsWith(".gemini-code-tmp/");
}

/**
 * Normalises a Windows path the way the filesystem will read it: trailing
 * dots and spaces are dropped (".env." IS ".env"), and an alternate data
 * stream (".env:x", ".env::$DATA") writes the same file.
 */
export function normalizeForRules(rel: string): string {
  return rel
    .split("/")
    .map((seg) => seg.replace(/:.*$/, "").replace(/[. ]+$/, (m) => (seg === m ? m : "")))
    .join("/");
}

function writeMatches(pattern: string, rel: string): boolean {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "") + "/**";
  const anchored = p.includes("/") && !p.startsWith("**/");
  const body = p.replace(/^\//, "");
  const ci = process.platform === "win32" || process.platform === "darwin";
  const re = compileWildmatch(body, ci);
  if (!re) return false;
  if (anchored || body.includes("/")) {
    // Also match anything inside a matched folder ("build" anchored → build/x).
    if (re.test(rel)) return true;
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) if (re.test(parts.slice(0, i).join("/"))) return true;
    return false;
  }
  // No slash: the name of the file or of any folder above it.
  return rel.split("/").some((seg) => re.test(seg));
}

export function decideWrite(abs: string, rules: RuleSet, root: string): Decision {
  const writeRules = rules.rules.filter((r) => r.kind === "writes");
  if (!writeRules.length) return ASK_NO_RULES;
  const relRaw = path.relative(root, abs).split(path.sep).join("/");
  if (relRaw.startsWith("..") || path.isAbsolute(relRaw)) return { verdict: "ask", reason: "it's outside the project" };
  const rel = normalizeForRules(relRaw);
  const deny = writeRules.find((r) => r.effect === "deny" && writeMatches(r.pattern, rel));
  if (deny) return { verdict: "deny", rule: deny, reason: `denied by "${deny.pattern}" (${deny.source})` };
  if (alwaysAsk(rel)) return { verdict: "ask", reason: `${rel} always asks: it controls the rules or the history` };
  const allow = writeRules.find((r) => r.effect === "allow" && writeMatches(r.pattern, rel));
  if (allow) return { verdict: "allow", rule: allow, reason: `allowed by "${allow.pattern}" (${allow.source})` };
  return { verdict: "ask", reason: "no write rule covers it" };
}

// -------------------------------------------------------------------- hosts

export function hostMatches(pattern: string, host: string, port: string): boolean {
  const [ph, pp] = pattern.toLowerCase().split(/:(?=\d+$)/);
  if (pp && pp !== port) return false;
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (ph === "*") return true;
  if (ph.startsWith("*.")) return h.endsWith(ph.slice(1)) && h.length > ph.length - 1;
  return h === ph.replace(/\.$/, "");
}

export function decideHost(url: string, rules: RuleSet): Decision {
  const hostRules = rules.rules.filter((r) => r.kind === "hosts");
  if (!hostRules.length) return ASK_NO_RULES;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { verdict: "ask", reason: "not a valid URL" };
  }
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  const deny = hostRules.find((r) => r.effect === "deny" && hostMatches(r.pattern, u.hostname, port));
  if (deny) return { verdict: "deny", rule: deny, reason: `denied by "${deny.pattern}" (${deny.source})` };
  const allow = hostRules.find((r) => r.effect === "allow" && hostMatches(r.pattern, u.hostname, port));
  if (allow) return { verdict: "allow", rule: allow, reason: `allowed by "${allow.pattern}" (${allow.source})` };
  return { verdict: "ask", reason: "no host rule covers it" };
}
