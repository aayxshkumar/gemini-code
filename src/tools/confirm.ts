import readline from "node:readline/promises";
import { getAsker } from "../ui/prompt.js";

/**
 * Serializes prompts. With parallel worker tabs, several tools can want
 * confirmation at the same moment — without this they'd interleave their
 * questions and steal each other's keystrokes.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * What a confirmation is FOR, so approval can be granted by kind rather
 * than all-or-nothing:
 *
 *   GEMINI_CODE_AUTO_APPROVE=1 | all      everything runs without asking
 *   GEMINI_CODE_AUTO_APPROVE=edits        file writes/edits inside the
 *                                         workspace run; commands and
 *                                         network requests still ask
 *   GEMINI_CODE_AUTO_APPROVE=edits,commands   …and shell commands too
 *   unset / 0                             ask for everything
 *
 * That middle setting is the one most people actually want on a real
 * codebase: edits are cheap to review afterwards with git_diff and /undo,
 * while a shell command or a request can't be taken back.
 */
export type ActionKind = "edit" | "command" | "network";

export function autoApproved(kind: ActionKind, env = process.env.GEMINI_CODE_AUTO_APPROVE): boolean {
  const raw = (env ?? "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "none") return false;
  if (raw === "1" || raw === "true" || raw === "all" || raw === "yes") return true;
  const kinds = raw.split(/[\s,+]+/);
  const names: Record<ActionKind, string[]> = {
    edit: ["edit", "edits", "write", "writes", "files"],
    command: ["command", "commands", "bash", "shell", "run"],
    network: ["network", "net", "fetch", "web", "browser"],
  };
  return kinds.some((k) => names[kind].includes(k));
}

/**
 * Shared y/N confirmation gate for any tool that takes a side-effecting
 * local action. One place so they stay in sync, and one escape-hatch env
 * var. Read at call time, not module load, so tests/scripts can toggle it
 * per-invocation.
 */
export async function confirmAction(promptLabel: string, detail: string, kind: ActionKind = "command"): Promise<boolean> {
  if (autoApproved(kind)) return true;

  // Unattended (piped stdin, CI, a script): nobody can type "y", so a
  // question would hang the run until a timeout. Decline at once and say
  // how to allow it — the model gets the same message and can adapt.
  // GEMINI_CODE_PROMPT_UNATTENDED=1 keeps asking anyway, for callers that
  // deliberately pipe answers in (and for the tests).
  if (!process.stdin.isTTY && process.env.GEMINI_CODE_PROMPT_UNATTENDED !== "1") {
    console.log(
      `\n[gemini-code] ${promptLabel} — declined automatically: no terminal to confirm in.\n` +
        `  ${detail.split("\n")[0]}\n` +
        `  Allow this kind of action unattended with GEMINI_CODE_AUTO_APPROVE=${kind === "edit" ? "edits" : kind === "command" ? "edits,commands" : "all"}.`
    );
    return false;
  }

  const run = queue.then(() => ask(promptLabel, detail));
  // Keep the chain alive even if one prompt rejects.
  queue = run.catch(() => undefined);
  return run;
}

async function ask(promptLabel: string, detail: string): Promise<boolean> {
  const question = `\n[gemini-code] ${promptLabel}\n  ${detail}\n  (y/N) `;

  // Prefer the REPL's own readline. Opening a second interface on the same
  // stdin makes the terminal echo each keystroke twice AND delivers the
  // answer to the REPL as well, where "y" gets sent to Gemini as a task.
  const asker = getAsker();
  if (asker) {
    const answer = await asker(question);
    return answer.trim().toLowerCase() === "y";
  }

  // Standalone use (scripts, tests): nobody owns stdin, so make our own.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/** What the model is told when an action wasn't approved. */
export function declinedMessage(what: string, kind: ActionKind): string {
  if (!process.stdin.isTTY && process.env.GEMINI_CODE_PROMPT_UNATTENDED !== "1") {
    return (
      `Not allowed: this session is unattended (no terminal), so nobody could approve the request to ${what}, ` +
      `and ${kind === "edit" ? "file changes" : kind === "command" ? "shell commands" : "network requests"} are not ` +
      `pre-approved. Do not retry it. Finish what you can without it and state clearly in your final answer what ` +
      `was skipped and why.`
    );
  }
  return `User declined to ${what}. Don't repeat the same request; ask what they'd prefer, or continue without it.`;
}
