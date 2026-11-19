import type { RunTaskOptions } from "../agent/loop.js";
import { checkpoints } from "../context/checkpoint.js";
import { appendMemory, readMemory } from "../context/memory.js";
import { clearPlan, readPlan } from "../context/plan.js";
import { readClipboardImageDetailed } from "../context/clipboard.js";
import type { ModelMenu } from "../driver/models.js";
import { discoverSkills, installSkills, listInstalled, removeSkill } from "../tools/skillInstall.js";
import { findSkills } from "../tools/skills.js";
import type { McpServerStatus } from "../tools/mcp.js";
import { setAsker, setQuestioner } from "../ui/prompt.js";

/**
 * The agent's commands and events as JSON, one object per line, so the desktop
 * UI can run it without scraping a terminal.
 *
 *   in  {"id": 1, "cmd": "task", "text": "...", "images": ["a.png"]}
 *   out {"type": "reply", "id": 1, "ok": true, "data": ...}
 *   out {"type": "activity", "kind": "tool", "text": "read_file(a.ts)"}
 *   out {"type": "confirm", "id": 1, "label": "...", "detail": "..."}
 *   out {"type": "answer", "text": "..."} / {"type": "task_end", ...}
 *
 * `reply` answers one command; everything else arrives whenever it happens.
 * Commands run while a task is in flight are limited to the ones that can't
 * disturb it (see DURING_TASK): the tab belongs to the task until it ends.
 */
export type BridgeEvent = { type: string } & Record<string, unknown>;
export type Emit = (event: BridgeEvent) => void;

export interface BridgeCommand {
  id?: number;
  cmd: string;
  [field: string]: unknown;
}

/** The live session, behind an interface so tests need no browser. */
export interface BridgeHost {
  runTask(task: string, options: RunTaskOptions): Promise<string>;
  /** The latest reply as markdown; empty when it can't be read. */
  latestMarkdown(): Promise<string>;
  listModels(): Promise<ModelMenu>;
  setModel(name: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  newThread(): Promise<void>;
  /** Read-only until the user approves a plan. Survives a new thread. */
  setPlanMode(on: boolean): void;
  /** The model can change it too, so the UI asks rather than assuming. */
  inPlanMode(): boolean;
  /** Connects MCP servers, asking the user about any that need approval. */
  connectMcp(): Promise<void>;
  mcpStatus(): McpServerStatus[];
  listGems(): Promise<{ id: string; name: string }[]>;
  /** Points the session at a Gem, or none. Returns the name now in use. */
  setGem(name: string | null): Promise<string | null>;
  /** Marks the journal interrupted, for a task the user stopped. */
  markInterrupted(reason: string): Promise<void>;
  shutdown(): Promise<void>;
}

/** Thrown out of the task through getSteering, the loop's per-turn hook. */
class TaskStopped extends Error {}

const DURING_TASK = new Set([
  "steer",
  "stop",
  "confirm",
  "answer",
  "plan",
  "memory",
  "remember",
  "mcp",
  "skills",
  "skill_find",
  "skill_install",
  "skill_remove",
  "paste_image",
  "shutdown",
]);

/** Parses one line of input, or throws with a message worth showing. */
export function parseCommand(line: string): BridgeCommand {
  const parsed = JSON.parse(line) as BridgeCommand;
  if (typeof parsed?.cmd !== "string") throw new Error('expected an object with a "cmd" field');
  return parsed;
}

export interface Activity {
  /** "tool" is a call; "detail" sits under the call before it; "note" stands alone. */
  kind: "tool" | "detail" | "note";
  text: string;
  /** The worker tab this came from, when it wasn't the main one. */
  worker?: string;
  failed?: boolean;
}

/**
 * Sorts the loop's log lines. They are formatted for a terminal (see
 * ui/format.ts), and colour is off here because stdout is a pipe, so a failed
 * tool result can only be told from a good one by its wording.
 */
export function classifyActivity(line: string): Activity {
  const tagged = /^\[([^\]]+)\] ([\s\S]*)$/.exec(line);
  const worker = tagged?.[1];
  const body = tagged ? tagged[2] : line;

  // Both glyph sets: on a legacy Windows console (and so under the desktop
  // app on Windows) ui/format.ts prints "*" and "|-" instead of "⏺" and "⎿".
  const call = /^\s*(?:⏺|\*) ([\s\S]*)$/.exec(body);
  if (call) return { kind: "tool", text: call[1], worker };

  const detail = /^\s*(?:⎿|\|-) ?([\s\S]*)$/.exec(body);
  if (detail) {
    const failed = /^(error|exit code [1-9]|failed|timed out|declined|denied|refused)/i.test(detail[1]);
    return { kind: "detail", text: detail[1], worker, ...(failed ? { failed } : {}) };
  }
  return { kind: "note", text: body.trim(), worker };
}

/** The label and detail out of confirm.ts's terminal-formatted question. */
export function parseQuestion(question: string): { label: string; detail: string } {
  const m = /^\s*\[gemini-code\] (.*)\n {2}([\s\S]*)\n {2}\(y\/N\) $/.exec(question);
  return m ? { label: m[1], detail: m[2] } : { label: "Allow this?", detail: question.trim() };
}

export class Bridge {
  private busy = false;
  private stopping = false;
  private steering: string[] = [];
  private nextConfirmId = 1;
  private pendingConfirm?: { id: number; resolve: (answer: string) => void };
  private nextQuestionId = 1;
  private pendingQuestion?: { id: number; resolve: (answer: string) => void };
  private task: Promise<void> = Promise.resolve();
  /** Tail of the work using the tab, so two commands never share its menus. */
  private tabWork: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: BridgeHost,
    private readonly emit: Emit
  ) {
    setAsker((question) => this.askUser(question));
    setQuestioner((question, options) => this.askQuestion(question, options));
  }

  /** Resolves once the running task, if any, has ended. */
  idle(): Promise<void> {
    return this.task;
  }

  /**
   * Runs after `ready`, because approving a server needs the UI listening. In
   * the queue, so a task sent meanwhile waits and gets the servers' tools.
   */
  connectMcp(): Promise<void> {
    return this.onTab(async () => {
      await this.host.connectMcp();
      this.emit({ type: "mcp", servers: this.host.mcpStatus() });
    });
  }

  private onTab<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tabWork.then(work, work);
    this.tabWork = run.catch(() => undefined);
    return run;
  }

  async handleLine(line: string): Promise<void> {
    let command: BridgeCommand;
    try {
      command = parseCommand(line);
    } catch (err) {
      this.emit({ type: "reply", ok: false, error: `bad command: ${(err as Error).message}` });
      return;
    }

    const { id, cmd } = command;
    if (this.busy && !DURING_TASK.has(cmd)) {
      this.emit({ type: "reply", id, ok: false, error: `can't ${cmd} while a task is running` });
      return;
    }
    try {
      const data = await this.dispatch(command);
      this.emit({ type: "reply", id, ok: true, data });
    } catch (err) {
      this.emit({ type: "reply", id, ok: false, error: (err as Error).message.split("\n")[0] });
    }
  }

  private async dispatch(command: BridgeCommand): Promise<unknown> {
    const { cmd } = command;
    const text = String(command.text ?? "").trim();
    switch (cmd) {
      case "task": {
        if (!text) throw new Error("the task is empty");
        const images = Array.isArray(command.images) ? command.images.map(String) : [];
        // Not awaited: the reply only says it started, so steering and
        // confirmations keep flowing while it runs. Busy from here, not from
        // when it reaches the front of the queue.
        this.busy = true;
        this.task = this.onTab(() => this.runTask(text, images));
        return undefined;
      }

      case "steer":
        if (!this.busy) throw new Error("no task is running");
        if (text) this.steering.push(text);
        return undefined;

      case "stop":
        if (!this.busy) return undefined;
        this.stopping = true;
        this.answerPendingConfirm("n");
        this.answerPendingQuestion("");
        return undefined;

      case "answer":
        if (this.pendingQuestion?.id !== command.question_id) throw new Error("that question has already been answered");
        this.answerPendingQuestion(text);
        return undefined;

      case "plan_mode":
        this.host.setPlanMode(command.on === true);
        return { on: command.on === true };

      case "confirm": {
        if (this.pendingConfirm?.id !== command.confirm_id) throw new Error("that request has already been answered");
        this.answerPendingConfirm(command.approve === true ? "y" : "n");
        return undefined;
      }

      case "models":
        return { menu: await this.onTab(() => this.host.listModels()) };

      // Both answer with the menu as it now reads, so the UI can't drift from
      // what's really selected.
      case "model":
        return {
          menu: await this.onTab(async () => {
            await this.host.setModel(text);
            return this.host.listModels();
          }),
        };

      case "thinking":
        return {
          menu: await this.onTab(async () => {
            await this.host.setThinkingLevel(text);
            return this.host.listModels();
          }),
        };

      case "new_chat":
        await this.onTab(() => this.host.newThread());
        return undefined;

      case "gems":
        return { gems: await this.onTab(() => this.host.listGems()) };

      case "gem":
        return { gem: await this.onTab(() => this.host.setGem(text || null)) };

      case "undo":
        // text "force": keep conflicting files as .conflict copies and undo anyway.
        return checkpoints.undoLast({ force: text === "force" });

      case "plan":
        return { plan: (await readPlan())?.raw ?? null };

      case "mcp":
        return { servers: this.host.mcpStatus() };

      // These come from the app's Skills page. The agent has no way to send
      // them, because a skill is instructions it would go on to follow.
      case "skills": {
        const installed = await listInstalled();
        const known = new Set(installed.map((skill) => skill.name));
        const others = [...(await findSkills()).values()].filter((skill) => !known.has(skill.name));
        return {
          installed,
          others: others.map(({ name, description, source }) => ({ name, description, source })),
        };
      }

      case "skill_find":
        return { found: await discoverSkills(text) };

      case "skill_install": {
        const names = Array.isArray(command.names) ? command.names.map(String) : [];
        return { installed: await installSkills(text, names) };
      }

      case "skill_remove":
        await removeSkill(text);
        return undefined;

      case "plan_clear":
        await clearPlan();
        return undefined;

      case "memory":
        return { memory: (await readMemory()) ?? null };

      case "remember":
        if (!text) throw new Error("the note is empty");
        await appendMemory(text);
        return { memory: (await readMemory()) ?? null };

      case "paste_image": {
        const { path, reason } = await readClipboardImageDetailed();
        if (!path) throw new Error(reason ?? "no image on the clipboard");
        return { path };
      }

      case "shutdown":
        await this.host.shutdown();
        return undefined;

      default:
        throw new Error(`unknown command "${cmd}"`);
    }
  }

  private async runTask(text: string, images: string[]): Promise<void> {
    this.busy = true;
    this.stopping = false;
    this.steering = [];
    this.emit({ type: "task_start", text });

    let turnChecks = 0;
    checkpoints.begin(text);
    try {
      const answer = await this.host.runTask(text, {
        attachments: images,
        onEvent: (line) => this.emit({ type: "activity", ...classifyActivity(line) }),
        onInterimReply: async (reply) => {
          this.emit({ type: "answer", text: (await this.host.latestMarkdown()) || reply, interim: true });
        },
        getSteering: () => {
          // The loop calls this once before the first send. Stopping there
          // would leave the session believing its primer went out when it
          // never did, so the first check always lets the turn through.
          if (this.stopping && turnChecks > 0) throw new TaskStopped("stopped");
          turnChecks++;
          return this.steering.splice(0);
        },
      });
      await checkpoints.commit();
      // The agent reads replies as rendered text, which loses code fences and
      // tables. Except when the loop wrote the answer itself, the reply is
      // still on the page, so read it again as markdown for display.
      const fromLoop = answer.startsWith("(Stopped:");
      const markdown = fromLoop ? "" : await this.host.latestMarkdown();
      this.emit({ type: "answer", text: markdown || answer });
      this.emit({ type: "task_end", status: "done", planMode: this.host.inPlanMode() });
    } catch (err) {
      await checkpoints.commit(); // keep snapshots from a failed run too
      const planMode = this.host.inPlanMode();
      if (err instanceof TaskStopped) {
        await this.host.markInterrupted("stopped by the user");
        this.emit({ type: "task_end", status: "stopped", planMode });
      } else {
        this.emit({ type: "task_end", status: "error", error: (err as Error).message, planMode });
      }
    } finally {
      this.busy = false;
      this.stopping = false;
    }
  }

  /** confirm.ts serializes these, so there's only ever one outstanding. */
  private askUser(question: string): Promise<string> {
    if (this.stopping) return Promise.resolve("n");
    const id = this.nextConfirmId++;
    return new Promise((resolve) => {
      this.pendingConfirm = { id, resolve };
      this.emit({ type: "confirm", id, ...parseQuestion(question) });
    });
  }

  private askQuestion(question: string, options: string[]): Promise<string> {
    if (this.stopping) return Promise.resolve("");
    const id = this.nextQuestionId++;
    return new Promise((resolve) => {
      this.pendingQuestion = { id, resolve };
      this.emit({ type: "question", id, question, options });
    });
  }

  private answerPendingQuestion(answer: string): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = undefined;
    this.emit({ type: "question_closed", id: pending.id, answer });
    pending.resolve(answer);
  }

  private answerPendingConfirm(answer: string): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    this.pendingConfirm = undefined;
    this.emit({ type: "confirm_closed", id: pending.id });
    pending.resolve(answer);
  }
}
