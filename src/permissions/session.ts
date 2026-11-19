/**
 * The rules in force for this session, and trust-on-first-use for the
 * project's own settings.
 *
 * Read once, at startup: the user's ~/.gemini-code/config.json (applies as
 * written) and the project's .gemini-code.json, whose deny rules always
 * apply but whose allow rules — and its trust-required settings (see
 * config.ts TRUST_REQUIRED_ENV), and a .gemini-code-profile folder — are
 * held back until the user says they trust exactly those settings. The
 * answer is stored against a hash of them in ~/.gemini-code/trust.json and
 * asked again when they change. Unattended sessions never trust.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyHeldBack, heldBackSettings, homeDir, projectConfigPath, projectTrust, readConfigFile, userConfigPath } from "../config.js";
import { emptyRules, mergeRules, readRules, type RuleSet } from "./rules.js";

export interface PermissionState {
  rules: RuleSet;
  /** The project's allow rules and settings waiting on trust. */
  heldBack: { rules: RuleSet; settings: Record<string, string>; profileFolder: boolean };
  trust: "none-needed" | "trusted" | "untrusted" | "unanswered";
  root: string;
}

let state: PermissionState = { rules: emptyRules(), heldBack: { rules: emptyRules(), settings: {}, profileFolder: false }, trust: "none-needed", root: process.cwd() };

export function currentPermissions(): PermissionState {
  return state;
}

/** Tests: put a rule set in force directly. */
export function setRulesForTests(rules: RuleSet, root = process.cwd()): void {
  state = { ...state, rules, root };
}

const trustFile = () => path.join(homeDir(), "trust.json");

function readTrust(): Record<string, { hash: string; trusted: boolean; at: string }> {
  try {
    return JSON.parse(readFileSync(trustFile(), "utf8").replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

export function trustHash(held: PermissionState["heldBack"]): string {
  const stable = {
    allow: held.rules.rules.map((r) => `${r.kind}:${r.pattern}`).sort(),
    settings: Object.keys(held.settings).sort().map((k) => [k, held.settings[k]]),
    profileFolder: held.profileFolder,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function rememberTrust(root: string, hash: string, trusted: boolean): void {
  const all = readTrust();
  all[path.resolve(root)] = { hash, trusted, at: new Date().toISOString() };
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(trustFile(), JSON.stringify(all, null, 2) + "\n", "utf8");
}

export function forgetTrust(root: string): boolean {
  const all = readTrust();
  const key = path.resolve(root);
  if (!(key in all)) return false;
  delete all[key];
  writeFileSync(trustFile(), JSON.stringify(all, null, 2) + "\n", "utf8");
  return true;
}

/** What the trust question lists. */
export function describeHeldBack(held: PermissionState["heldBack"]): string[] {
  return [
    ...held.rules.rules.map((r) => `allow ${r.kind}: ${r.pattern}`),
    ...Object.entries(held.settings).map(([k, v]) => `${k}=${k === "GEMINI_CODE_API_KEY" ? "***" : v}`),
    ...(held.profileFolder ? ["use the browser profile in ./.gemini-code-profile (someone's Google session)"] : []),
  ];
}

/**
 * Loads the rules and settles trust. `ask` puts the question to a person and
 * returns their y/N; without it (unattended), nothing held back is trusted
 * unless it was trusted before.
 */
export async function loadPermissions(opts: { root?: string; ask?: (question: string) => Promise<boolean>; log?: (msg: string) => void } = {}): Promise<PermissionState> {
  const root = path.resolve(opts.root ?? process.cwd());
  const userFile = userConfigPath();
  const projectFile = projectConfigPath(root);
  const user = readRules(readConfigFile(userFile).permissions, userFile);
  const projectValue = path.resolve(projectFile) === path.resolve(userFile) ? undefined : readConfigFile(projectFile).permissions;
  const projectDeny = readRules(projectValue, projectFile, "deny");
  const projectAll = readRules(projectValue, projectFile);
  const projectAllow: RuleSet = { rules: projectAll.rules.filter((r) => r.effect === "allow"), errors: [] };
  const profileFolder = existsSync(path.join(root, ".gemini-code-profile")) && !process.env.GEMINI_CODE_PROFILE;
  const held = { rules: projectAllow, settings: { ...heldBackSettings }, profileFolder };

  let trust: PermissionState["trust"] = "none-needed";
  if (held.rules.rules.length || Object.keys(held.settings).length || held.profileFolder) {
    const hash = trustHash(held);
    const stored = readTrust()[root];
    if (stored && stored.hash === hash) trust = stored.trusted ? "trusted" : "untrusted";
    else if (opts.ask) {
      const yes = await opts.ask(
        `This project's .gemini-code.json (or folder) asks for settings that need your trust:\n` +
          describeHeldBack(held).map((l) => `    ${l}`).join("\n") +
          `\n  Trust them for ${root}? Until you do, they're ignored. (/permissions reset asks again)`
      );
      rememberTrust(root, hash, yes);
      trust = yes ? "trusted" : "untrusted";
    } else {
      trust = "unanswered";
      opts.log?.(`gemini-code: this project's trust-required settings are ignored (no terminal to ask in): ${describeHeldBack(held).join("; ")}`);
    }
  }

  if (trust === "trusted") {
    applyHeldBack();
    projectTrust.trustedRoot = root;
  }
  const rules = mergeRules(user, projectDeny, trust === "trusted" ? projectAllow : emptyRules(), { rules: [], errors: projectAll.errors });
  state = { rules, heldBack: held, trust, root };
  return state;
}
