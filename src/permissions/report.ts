/**
 * `/permissions`: the rules in force and where each came from; `check`
 * shows the decision for a command, path or URL without running anything;
 * `reset` forgets this project's trust answer.
 */
import path from "node:path";
import { describeHeldBack, forgetTrust, currentPermissions } from "./session.js";
import { commandDecision, hostDecision, writeDecision } from "./gate.js";
import type { ShellFlavour } from "./shellSyntax.js";

export function permissionsReport(): string {
  const { rules, heldBack, trust, root } = currentPermissions();
  const lines: string[] = [];
  if (!rules.rules.length) {
    lines.push("No permission rules: every command, write and request asks (or follows GEMINI_CODE_AUTO_APPROVE).");
  }
  for (const effect of ["deny", "allow"] as const) {
    for (const kind of ["commands", "writes", "hosts"] as const) {
      const rs = rules.rules.filter((r) => r.effect === effect && r.kind === kind);
      if (!rs.length) continue;
      lines.push(`${effect} ${kind}:`);
      for (const r of rs) lines.push(`  ${r.pattern}  (${path.relative(process.cwd(), r.source) || r.source})`);
    }
  }
  if (rules.errors.length) lines.push("Problems in the rules:", ...rules.errors.map((e) => `  ${e}`));
  const held = describeHeldBack(heldBack);
  if (held.length) {
    lines.push(
      trust === "trusted"
        ? `This project is trusted, so its own settings apply:`
        : `Held back until you trust this project (${trust === "untrusted" ? "you said no" : "not asked yet"}):`,
      ...held.map((h) => `  ${h}`),
      `/permissions reset forgets the answer for ${root}, so the next start asks again.`
    );
  }
  lines.push("Deny wins over allow and over autoApprove. /permissions check <command | path | url> shows a decision.");
  return lines.join("\n");
}

export function permissionsCheck(subject: string, flavour: ShellFlavour): string {
  const text = subject.trim();
  if (!text) return "usage: /permissions check <command | path | url>";
  const show = (what: string, d: { verdict: string; reason: string }) => `${what}: ${d.verdict.toUpperCase()}${d.reason ? ` — ${d.reason}` : " — no rules apply, so it asks"}`;
  if (/^https?:\/\//i.test(text)) return show("request", hostDecision(text));
  if (/^(write|path)\s+/i.test(text)) return show("write", writeDecision(path.resolve(text.replace(/^(write|path)\s+/i, ""))));
  const command = show(`command (${flavour})`, commandDecision(text, flavour, process.cwd()));
  // A bare relative path is probably a write question too.
  if (!/\s/.test(text) && /[./\\]/.test(text)) return `${command}\n${show("as a write", writeDecision(path.resolve(text)))}`;
  return command;
}

export function permissionsReset(): string {
  const { root } = currentPermissions();
  return forgetTrust(root)
    ? `Forgot the trust answer for ${root}; the next start asks again.`
    : `No trust answer stored for ${root}.`;
}
