/**
 * Turns a permission decision into what the tool does: refuse (deny), run
 * without asking (allow), or ask as before — with the reason shown to the
 * user and returned to the model. With no rules configured, every prompt
 * and message is exactly what it was before rules existed.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { confirmAction, type ActionKind } from "../tools/confirm.js";
import { decideCommand, decideHost, decideWrite, type Decision } from "./decide.js";
import { currentPermissions } from "./session.js";
import type { ShellFlavour } from "./shellSyntax.js";

export type GateResult = { run: true } | { run: false; message: string };

function realOrSelf(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

/** The decision for writing `abs`, through symlinks: deny if either spelling is denied, allow only if both are allowed. */
export function writeDecision(abs: string): Decision {
  const { rules, root } = currentPermissions();
  const realRoot = realOrSelf(root);
  const asWritten = decideWrite(path.resolve(abs), rules, root);
  const real = decideWrite(realOrSelf(abs), rules, realRoot);
  if (asWritten.verdict === "deny") return asWritten;
  if (real.verdict === "deny") return { ...real, reason: `${real.reason}, through a link` };
  if (asWritten.verdict === "allow" && real.verdict === "allow") return asWritten;
  return asWritten.verdict === "ask" ? asWritten : real;
}

export function commandDecision(command: string, flavour: ShellFlavour, cwd: string): Decision {
  const { rules, root } = currentPermissions();
  return decideCommand(command, rules, { flavour, cwd, root });
}

export function hostDecision(url: string): Decision {
  return decideHost(url, currentPermissions().rules);
}

async function apply(decision: Decision, label: string, detail: string, kind: ActionKind, what: string): Promise<GateResult> {
  if (decision.verdict === "deny") {
    return {
      run: false,
      message: `Refused: ${what} is ${decision.reason}. A deny rule is never overridden by asking; don't retry it. Do the task another way, or tell the user what you needed.`,
    };
  }
  if (decision.verdict === "allow") return { run: true };
  const approved = await confirmAction(label, decision.reason ? `${detail}\n  why it asks: ${decision.reason}` : detail, kind);
  return approved ? { run: true } : { run: false, message: "" };
}

export function gateCommand(command: string, flavour: ShellFlavour, cwd: string, label: string, detail: string): Promise<GateResult> {
  return apply(commandDecision(command, flavour, cwd), label, detail, "command", "this command");
}

export function gateWrite(abs: string, label: string, detail: string): Promise<GateResult> {
  return apply(writeDecision(abs), label, detail, "edit", `writing ${path.basename(abs)}`);
}

/** Several paths in one action (move, delete, multi_edit): deny if any is denied, allow only if all are allowed. */
export function gateWrites(abses: string[], label: string, detail: string): Promise<GateResult> {
  const decisions = abses.map((abs) => ({ abs, d: writeDecision(abs) }));
  const denied = decisions.find((x) => x.d.verdict === "deny");
  if (denied) return apply(denied.d, label, detail, "edit", `writing ${path.basename(denied.abs)}`);
  if (decisions.every((x) => x.d.verdict === "allow")) return Promise.resolve({ run: true });
  const asks = decisions.filter((x) => x.d.verdict === "ask" && x.d.reason);
  const reason = asks.length ? asks.map((x) => `${path.basename(x.abs)}: ${x.d.reason}`).join("; ") : "";
  return apply({ verdict: "ask", reason }, label, detail, "edit", "these writes");
}

export function gateHost(url: string, label: string, detail: string): Promise<GateResult> {
  return apply(hostDecision(url), label, detail, "network", `this request`);
}

/** Deny only (for the browser tools, whose own per-origin question stays). */
export function hostDenied(url: string): string | undefined {
  const d = hostDecision(url);
  return d.verdict === "deny" ? `Refused: opening ${url} is ${d.reason}. Don't retry it.` : undefined;
}
