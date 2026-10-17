import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

export const PLAN_FILENAME = "GEMINI-PLAN.md";

export type PlanStatus = "in_progress" | "completed" | "interrupted";

export interface PlanStep {
  title: string;
  done: boolean;
}

export interface PlanState {
  status: PlanStatus;
  task: string;
  started: string;
  updated: string;
  steps: PlanStep[];
  log: string[];
  /** The Gemini conversation URL this task ran in, once known — what /resume reopens. */
  thread?: string;
}

/** Everything a plan file says, parsed back out of the Markdown. */
export interface ParsedPlan {
  status: PlanStatus;
  task: string;
  thread?: string;
  steps: PlanStep[];
  log: string[];
  raw: string;
}

export function parsePlan(raw: string): ParsedPlan {
  const status = (raw.match(/\*\*Status:\*\*\s*(\w+)/)?.[1] as PlanStatus) ?? "in_progress";
  const task = raw.match(/\*\*Task:\*\*\s*(.*)/)?.[1]?.trim() ?? "";
  const thread = raw.match(/\*\*Thread:\*\*\s*(\S+)/)?.[1];
  const section = (name: string) => {
    const m = raw.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return m ? m[1] : "";
  };
  const steps: PlanStep[] = [...section("Plan").matchAll(/^- \[( |x)\] (.*)$/gm)].map((m) => ({
    done: m[1] === "x",
    title: m[2].trim(),
  }));
  const log = [...section("Progress").matchAll(/^- (.*)$/gm)].map((m) => m[1]);
  return { status, task, thread, steps, log, raw };
}

/**
 * The task text that continues an interrupted plan — what a bare "continue"
 * or /resume expands into, so the model gets the goal and the state, not
 * just the word.
 */
export function resumeTaskText(plan: ParsedPlan): string {
  const steps = plan.steps.length
    ? plan.steps.map((st) => `- [${st.done ? "x" : " "}] ${st.title}`).join("\n")
    : "(no step list was recorded; work out what is already done from the files and the progress log)";
  const recent = plan.log.slice(-10).map((l) => `- ${l}`).join("\n") || "(nothing logged)";
  return (
    `Continue the task that was interrupted (the previous session crashed or was stopped).\n\n` +
    `ORIGINAL TASK:\n${plan.task || "(not recorded — infer it from the plan below)"}\n\n` +
    `PLAN STATUS:\n${steps}\n\nLAST ACTIONS BEFORE THE INTERRUPTION:\n${recent}\n\n` +
    `Pick up from the first unfinished step. Files listed as written or edited already contain those changes — ` +
    `check what is on disk before redoing anything, and read a file before editing it. Keep update_plan current. ` +
    `When every step is genuinely done, say so plainly.`
  );
}

function planPath(root = process.cwd()): string {
  return path.resolve(root, PLAN_FILENAME);
}

/**
 * A live journal of the current task, flushed to disk after every step.
 *
 * The point is interruption: a crash, a Ctrl+C, a closed browser tab, or a
 * Gemini session that dies mid-task otherwise loses everything the agent had
 * worked out. Because this is written as it goes rather than at the end, a
 * file left at status `in_progress` is itself the signal that work was cut
 * short — the next run picks it up and continues instead of starting over.
 *
 * Kept separate from GEMINI.md on purpose: that file is durable knowledge
 * worth keeping forever, this one is transient state for the task in flight.
 */
export class PlanJournal {
  private state: PlanState | undefined;
  private readonly root: string;
  /** Set by resume(): the next begin() continues this plan instead of replacing it. */
  private resumedPending = false;

  constructor(root = process.cwd()) {
    this.root = root;
  }

  async begin(task: string): Promise<void> {
    const now = new Date().toISOString();
    if (this.resumedPending && this.state) {
      // Continuing an interrupted plan: keep its steps, log and thread.
      this.resumedPending = false;
      this.state.status = "in_progress";
      this.state.log.push(`${now.slice(11, 19)} resumed: ${task.split("\n")[0].slice(0, 120)}`);
      await this.flush();
      return;
    }
    this.state = { status: "in_progress", task, started: now, updated: now, steps: [], log: [] };
    await this.flush();
  }

  /** Loads an interrupted plan so the next task continues it rather than starting over. */
  resume(plan: ParsedPlan): void {
    const now = new Date().toISOString();
    this.state = {
      status: "in_progress",
      task: plan.task,
      started: now,
      updated: now,
      steps: plan.steps,
      log: plan.log,
      thread: plan.thread,
    };
    this.resumedPending = true;
  }

  /** Records the Gemini thread this task runs in (idempotent). */
  async setThread(url: string | undefined): Promise<void> {
    if (!this.state || !url || this.state.thread === url) return;
    this.state.thread = url;
    await this.flush();
  }

  get thread(): string | undefined {
    return this.state?.thread;
  }

  /** Records the model's intended checklist (via the update_plan tool). */
  async setSteps(steps: PlanStep[]): Promise<void> {
    if (!this.state) return;
    this.state.steps = steps;
    await this.flush();
  }

  /** Appends one line of progress — a tool call, a result, a note. */
  async log(entry: string): Promise<void> {
    if (!this.state) return;
    const stamp = new Date().toISOString().slice(11, 19);
    this.state.log.push(`${stamp} ${entry}`);
    await this.flush();
  }

  /**
   * Steps the model recorded but hasn't ticked off.
   *
   * The strongest available signal that a "final" answer isn't actually
   * final: if the agent wrote itself a six-step plan and answers after
   * three, the work is demonstrably unfinished regardless of how confident
   * the prose sounds.
   */
  pendingSteps(): string[] {
    return (this.state?.steps ?? []).filter((s) => !s.done).map((s) => s.title);
  }

  /**
   * What the journal alone can say about the task, for re-priming a fresh
   * thread when the model couldn't write a handoff itself (the tab died).
   */
  summaryForHandoff(): string | undefined {
    const s = this.state;
    if (!s) return undefined;
    const steps = s.steps.length
      ? s.steps.map((st) => `- [${st.done ? "x" : " "}] ${st.title}`).join("\n")
      : "(no plan was recorded)";
    const recent = s.log.slice(-15).map((l) => `- ${l}`).join("\n") || "(nothing yet)";
    return (
      `## Goal\n${s.task}\n\n## Plan so far\n${steps}\n\n## Last actions (from the journal — the previous thread ` +
      `died before it could write a note)\n${recent}\n\nFiles listed as written or edited above already contain ` +
      `those changes; read them before touching them again.`
    );
  }

  async complete(summary: string): Promise<void> {
    if (!this.state) return;
    this.state.status = "completed";
    this.state.log.push(`${new Date().toISOString().slice(11, 19)} finished`);
    await this.flush(summary);
  }

  async markInterrupted(reason: string): Promise<void> {
    if (!this.state || this.state.status === "completed") return;
    this.state.status = "interrupted";
    this.state.log.push(`${new Date().toISOString().slice(11, 19)} interrupted: ${reason}`);
    await this.flush();
  }

  private async flush(summary?: string): Promise<void> {
    if (!this.state) return;
    this.state.updated = new Date().toISOString();
    const s = this.state;

    const steps = s.steps.length
      ? s.steps.map((st) => `- [${st.done ? "x" : " "}] ${st.title}`).join("\n")
      : "_(the agent hasn't recorded a plan for this task)_";

    const body = `# gemini-code session plan

- **Status:** ${s.status}
- **Task:** ${s.task.replace(/\n/g, " ")}${s.thread ? `\n- **Thread:** ${s.thread}` : ""}
- **Started:** ${s.started}
- **Updated:** ${s.updated}

## Plan

${steps}

## Progress

${s.log.length ? s.log.map((l) => `- ${l}`).join("\n") : "_(nothing yet)_"}
${summary ? `\n## Result\n\n${summary}\n` : ""}`;

    await writeFile(planPath(this.root), body, "utf8").catch(() => {
      /* journalling must never break the task it's journalling */
    });
  }
}

/** Reads an existing plan file, if any. */
export async function readPlan(root = process.cwd()): Promise<ParsedPlan | undefined> {
  try {
    return parsePlan(await readFile(planPath(root), "utf8"));
  } catch {
    return undefined;
  }
}

/** True when the last run didn't finish — i.e. there's work to resume. */
export async function findResumablePlan(root = process.cwd()): Promise<ParsedPlan | undefined> {
  const plan = await readPlan(root);
  if (!plan) return undefined;
  return plan.status === "completed" ? undefined : plan;
}

export async function clearPlan(root = process.cwd()): Promise<void> {
  await rm(planPath(root), { force: true }).catch(() => undefined);
}
