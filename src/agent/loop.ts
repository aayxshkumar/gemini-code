import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { IGeminiDriver } from "../driver/IGeminiDriver.js";
import { tools } from "../tools/index.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import {
  buildSystemPrimer,
  buildContextDocument,
  buildProtocolReminder,
  formatToolResult,
  type PrimerContext,
  type AgentRole,
} from "./promptTemplate.js";
import {
  parseGeminiReply,
  looksLikeAbandonedWork,
  looksUnfinished,
  looksLikeGeminiError,
  looksLikeUnseenAttachment,
} from "./toolCallParser.js";
import { toolCallLine, toolResultLine, noteLine } from "../ui/format.js";
import { forgetAll } from "../tools/fileState.js";
import { missingCitedPaths } from "./citations.js";
import type { PlanJournal } from "../context/plan.js";

/**
 * Turns one task may take. A real migration hit the old limit of 25 while
 * still making progress and stopped half-done, which is the opposite of
 * running unattended. Raised, and tunable — the limit exists to stop a loop
 * that is going nowhere, not to cap honest work.
 */
const MAX_TOOL_TURNS_PER_TASK = Math.max(1, Number(process.env.GEMINI_CODE_MAX_TURNS ?? 60));

/**
 * A task is abandoned when it stops PROGRESSING, not when it gets slow. Two
 * measures of "going nowhere", both deliberately generous: nothing but failed
 * tool calls for this many turns, and the same tool failing the same way over
 * and over.
 */
const STALL_TURNS = Math.max(2, Number(process.env.GEMINI_CODE_STALL_TURNS ?? 8));
const REPEAT_FAILURE_LIMIT = Math.max(2, Number(process.env.GEMINI_CODE_REPEAT_FAILURES ?? 3));

/**
 * Tool output longer than this gets uploaded as a file attachment rather
 * than pasted into the composer. The web UI has a practical text-length
 * limit on a single message that a real API wouldn't — pasting a big file
 * either gets truncated or fails outright, so we attach it instead.
 */
const MAX_INLINE_RESULT_CHARS = 4_000;

/**
 * The composer silently truncates at 32,000 characters (measured live:
 * 50,000 pasted, 32,000 kept). A message over this would lose its tail —
 * usually the TASK, which comes last — so anything longer is split: the
 * head stays inline and the whole message also goes up as a file.
 */
const COMPOSER_MAX_CHARS = 30_000;

/**
 * Context (tree + memory + project docs) longer than this is uploaded as a
 * file instead of pasted. Lower than the tool-result limit because the
 * primer's rules share the same first message and must stay inline.
 */
const MAX_INLINE_CONTEXT_CHARS = 2_500;

const TMP_DIR = ".gemini-code-tmp";

/**
 * How often the tool-call contract is restated, and how many times a reply
 * that abandoned it gets nudged. Long threads drift: the primer falls out
 * of a context the web UI truncates without telling us, and Gemini reverts
 * to chatting instead of calling tools.
 */
const REMINDER_EVERY_TURNS = Math.max(0, Number(process.env.GEMINI_CODE_REMINDER_TURNS ?? 5));
const MAX_DRIFT_NUDGES = Math.max(0, Number(process.env.GEMINI_CODE_DRIFT_NUDGES ?? 3));

/**
 * A task that ends without a single tool call did nothing, whatever the reply
 * says. The heuristics below catch the usual phrasings, but they are patterns
 * and patterns miss; this is the backstop that doesn't depend on wording. One
 * nudge only — a question really can be answered from the primer's context
 * alone, and that answer should not be argued with twice.
 */
function maxIdleNudges(): number {
  // Read per call, not at import, so tests and scripts can turn it off
  // without having to control module load order.
  return Math.max(0, Number(process.env.GEMINI_CODE_IDLE_NUDGES ?? 1));
}

/**
 * How many times a "final" answer that clearly isn't final gets pushed to
 * carry on. Separate from drift nudges because this is a different failure:
 * the model is following the protocol correctly, it has just stopped early.
 */
const MAX_CONTINUE_NUDGES = Math.max(0, Number(process.env.GEMINI_CODE_CONTINUE_NUDGES ?? 3));

/**
 * After this many exchanges in one thread, the thread is closed and a fresh
 * one opened with a handoff note the model writes for itself — the same
 * idea as Claude Code's auto-compact. The web UI silently truncates long
 * threads, and what falls off first is the primer and the early reads, so
 * a long task on a big codebase degrades into guesses. 0 disables.
 */
const COMPACT_TURNS = Math.max(0, Number(process.env.GEMINI_CODE_COMPACT_TURNS ?? 40));

/** Transient driver failures (send/response) are retried this many times. */
const TURN_RETRIES = Math.max(0, Number(process.env.GEMINI_CODE_TURN_RETRIES ?? 2));

/**
 * No single tool call may block the loop for longer than this. A foreground
 * command has its own shorter timeout; this is the backstop for everything
 * else (a browser page that never settles, a network call with no timeout,
 * a worker pool that wedged). The call keeps running in the background;
 * the model just gets an error and moves on.
 */
const toolTimeoutMs = () => Math.max(1_000, Number(process.env.GEMINI_CODE_TOOL_TIMEOUT_MS ?? 600_000));

/**
 * After this many consecutive READ-ONLY calls the model is reminded that
 * exploring is not the task. Generous: a big codebase legitimately needs a
 * lot of reading. 0 disables.
 */
const exploreNudgeTurns = () => Math.max(0, Number(process.env.GEMINI_CODE_EXPLORE_NUDGE_TURNS ?? 20));

/** Hard wall-clock cap on one task, in minutes. 0 = none (the turn limit still applies). */
const taskTimeoutMin = () => Math.max(0, Number(process.env.GEMINI_CODE_TASK_TIMEOUT_MIN ?? 0));

/** How long to wait for the network to come back before giving up a turn. */
const OFFLINE_WAIT_MS = Math.max(0, Number(process.env.GEMINI_CODE_OFFLINE_WAIT_MS ?? 5 * 60_000));

/** Tools that only look. Used by the exploring-forever nudge. */
const READ_ONLY_TOOLS = new Set([
  "read_file", "search_code", "find_files", "list_files", "git_status", "git_diff", "check_output",
  "web_search", "fetch_url", "read_page", "browser_open", "browser_do", "browser_close", "screenshot_page",
  "ask_gem", "update_plan",
]);

/** Thrown inside exchange() when the tab was lost and replaced: the thread must be re-primed. */
class ThreadLostError extends Error {
  constructor() {
    super("the Gemini tab was lost and replaced; the thread needs re-priming");
  }
}

/** Thrown when the user cancelled the task (Ctrl+C once). */
export class TaskCancelledError extends Error {
  constructor() {
    super("cancelled by the user");
  }
}

export interface RunTaskOptions {
  onEvent?: (msg: string) => void;
  /**
   * Returns anything the user typed WHILE the task was running. Drained
   * before each turn and injected as steering, so you can redirect a task
   * mid-flight instead of waiting for it to finish and starting over.
   */
  getSteering?: () => string[];
  /** Images/files the user attached to this task (e.g. a pasted screenshot). */
  attachments?: string[];
  /**
   * Aborting this cancels the task at the next safe point: between turns,
   * or mid-wait (generation is stopped). The journal is marked interrupted
   * so the next task can resume.
   */
  cancelSignal?: AbortSignal;
}

export class AgentSession {
  private primed = false;
  /** Exchanges sent in the current thread, for compaction. */
  private exchanges = 0;
  /** The task in flight, so a compaction mid-task can restate it. */
  private currentTask = "";
  /** Static tools plus any session-scoped ones (e.g. delegate_tasks). */
  private readonly tools: ToolDefinition[];
  private readonly toolsByName: Record<string, ToolDefinition>;
  private readonly toolNames: ReadonlySet<string>;

  constructor(
    private readonly driver: IGeminiDriver,
    private context: PrimerContext = {},
    extraTools: ToolDefinition[] = [],
    /**
     * Written to after every step so an interrupted run can be resumed.
     * Optional: worker sessions and tests run without one.
     */
    private readonly journal?: PlanJournal,
    /** Shapes the primer: orchestrator delegates, worker reports back short. */
    private readonly role: AgentRole = "solo"
  ) {
    this.tools = [...tools, ...extraTools];
    this.toolsByName = Object.fromEntries(this.tools.map((t) => [t.name, t]));
    this.toolNames = new Set(Object.keys(this.toolsByName));
  }

  /** Runs one user task to completion, including any tool-call back-and-forth. Returns Gemini's final plain-text answer. */
  async runTask(
    userTask: string,
    onEventOrOptions?: ((msg: string) => void) | RunTaskOptions
  ): Promise<string> {
    const options: RunTaskOptions =
      typeof onEventOrOptions === "function" ? { onEvent: onEventOrOptions } : onEventOrOptions ?? {};
    const log = options.onEvent ?? (() => {});

    await this.journal?.begin(userTask);
    let message = userTask;
    let attachFile: string[] = [...(options.attachments ?? [])];
    let driftNudges = 0;
    let continueNudges = 0;
    let idleNudges = 0;
    let citationNudges = 0;
    let geminiErrorRetries = 0;
    let attachmentResends = 0;
    let toolCallsMade = 0;
    const taskStartedAt = Date.now();
    // Loop detection: the last few call signatures, and how many read-only
    // calls in a row.
    const recentCalls: string[] = [];
    let repeatNoted = "";
    let readOnlyStreak = 0;
    let exploreNoted = false;
    const cancelled = () => options.cancelSignal?.aborted === true;
    // Progress tracking, so a task that is stuck can be told so instead of
    // quietly repeating itself until the turn limit.
    let turnsSinceProgress = 0;
    let lastFailure = "";
    let sameFailureCount = 0;

    this.currentTask = userTask;
    if (COMPACT_TURNS > 0 && this.exchanges >= COMPACT_TURNS && !this.primed) {
      // Thread already long from earlier tasks: start this one fresh.
      await this.compact("thread is long", log);
    }
    if (!this.primed) {
      const primed = await this.buildPrimedMessage(userTask, log);
      message = primed.message;
      if (primed.attach) attachFile.push(primed.attach);
    }

    for (let turn = 0; turn < MAX_TOOL_TURNS_PER_TASK; turn++) {
      if (cancelled()) {
        await this.journal?.markInterrupted("cancelled by the user");
        return "(Cancelled. The plan was journalled; your next task can continue it.)";
      }
      const limitMin = taskTimeoutMin();
      if (limitMin > 0 && Date.now() - taskStartedAt > limitMin * 60_000) {
        await this.journal?.markInterrupted(`hit the ${limitMin}-minute task limit`);
        return `(Stopped: this task ran for more than ${limitMin} minutes (GEMINI_CODE_TASK_TIMEOUT_MIN). The plan was journalled; asking me to continue picks it up.)`;
      }

      // Fold in anything the user typed since the last turn, so they can
      // steer a running task rather than wait for it to finish.
      const steering = options.getSteering?.() ?? [];
      if (steering.length) {
        log(noteLine(`steering: ${steering.join(" | ")}`));
        await this.journal?.log(`user steered: ${steering.join(" | ")}`);
        message =
          `USER UPDATE — take this into account and adjust your plan:\n${steering.join("\n")}\n\n` +
          message;
      }

      // Periodically restate the contract before it drifts out of a long
      // thread's context — cheap insurance against the model reverting to
      // chatting instead of calling tools.
      if (REMINDER_EVERY_TURNS > 0 && turn > 0 && turn % REMINDER_EVERY_TURNS === 0) {
        message = `${buildProtocolReminder()}\n\n${message}`;
      }

      if (COMPACT_TURNS > 0 && this.exchanges >= COMPACT_TURNS && this.primed) {
        const note = await this.compact(`${this.exchanges} exchanges in this thread`, log);
        if (note !== undefined) {
          const primed = await this.buildPrimedMessage(
            `CONTINUE the task below — it is already in progress; your handoff note in the context says where you ` +
              `got to.\n\nORIGINAL TASK:\n${userTask}\n\nThe last tool result before the reset was:\n${message}`,
            log
          );
          message = primed.message;
          if (primed.attach) attachFile.push(primed.attach);
        }
      }

      let reply;
      try {
        reply = await this.exchange(message, attachFile, log, options.cancelSignal);
      } catch (err) {
        if (err instanceof TaskCancelledError) {
          await this.journal?.markInterrupted("cancelled by the user");
          return "(Cancelled. The plan was journalled; your next task can continue it.)";
        }
        if (err instanceof ThreadLostError) {
          // The tab is back but the conversation isn't. Re-prime from the
          // journal and resend the message that was in flight.
          log(noteLine("thread lost — re-priming a fresh thread from the journal and resending"));
          await this.journal?.log("thread lost: re-primed from the journal");
          this.context.handoff = this.journal?.summaryForHandoff() ?? this.context.handoff;
          forgetAll();
          this.primed = false;
          this.exchanges = 0;
          const primed = await this.buildPrimedMessage(
            `CONTINUE the task below — it was in progress when the browser tab was lost; the handoff in the ` +
              `context says where it got to.\n\nORIGINAL TASK:\n${userTask}\n\nThe message that was about to be ` +
              `sent (a tool result or instruction) was:\n${message}`,
            log
          );
          message = primed.message;
          attachFile = primed.attach ? [...attachFile, primed.attach] : attachFile;
          continue;
        }
        throw err;
      }

      // The model says it can't see what we attached: send it inline.
      if (attachFile.length && attachmentResends < 2 && looksLikeUnseenAttachment(reply)) {
        attachmentResends++;
        log(noteLine(`Gemini says it can't see the attachment — resending the content inline (${attachmentResends}/2)`));
        await this.journal?.log("attachment not seen: resent inline");
        const parts: string[] = [];
        for (const file of attachFile) {
          const text = await readFile(file, "utf8").catch(() => "");
          if (!text) continue;
          const cap = 12_000;
          parts.push(`===== ${path.basename(file)} =====\n${text.slice(0, cap)}${text.length > cap ? `\n[truncated after ${cap} of ${text.length} characters — ask for a specific part if you need more]` : ""}`);
        }
        await this.cleanupAttachments(attachFile);
        attachFile = [];
        message =
          `The attachment didn't reach you, so here is its content inline. Continue with the task using this:\n\n` +
          (parts.join("\n\n") || "(the file was binary or empty — proceed without it)");
        continue;
      }

      // "I encountered an error doing what you asked" is Gemini failing, not
      // answering. Re-send the same message (attachments included — they are
      // only cleaned up once a real reply is in hand).
      if (looksLikeGeminiError(reply) && geminiErrorRetries < TURN_RETRIES + 1) {
        geminiErrorRetries++;
        log(noteLine(`Gemini returned its own error ("${reply.text.trim().slice(0, 60)}") — resending (${geminiErrorRetries}/${TURN_RETRIES + 1})`));
        await this.journal?.log(`gemini error reply, retrying: ${reply.text.trim().slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, 4_000 * geminiErrorRetries));
        continue;
      }
      await this.cleanupAttachments(attachFile);
      attachFile = [];

      const parsed = parseGeminiReply(reply, this.toolNames);

      if (parsed.kind === "final") {
        // A reply that pastes code while saying "I'll create the file" was
        // trying to work and forgot how — accepting it would silently end
        // the task having done nothing. Nudge, but only a couple of times,
        // since a genuine answer may legitimately quote code.
        if (driftNudges < MAX_DRIFT_NUDGES && looksLikeAbandonedWork(reply)) {
          driftNudges++;
          log(noteLine(`reply had code but no tool call — restating the protocol (${driftNudges}/${MAX_DRIFT_NUDGES})`));
          await this.journal?.log("protocol drift: reminded Gemini to use tools");
          message = buildProtocolReminder();
          continue;
        }

        // Backstop: the task is ending and nothing was ever done. No
        // wording to match on — just the fact that no tool ran.
        if (toolCallsMade === 0 && idleNudges < maxIdleNudges()) {
          idleNudges++;
          log(noteLine("answered without using any tool — asking it to act instead"));
          await this.journal?.log("idle nudge: reply used no tools");
          message =
            `${buildProtocolReminder()}\n\n` +
            `You answered without using a single tool, so nothing has actually been done. ` +
            `If the task needs work in this project, start now with a tool call. ` +
            `If it was only a question and your answer is complete, say so in one line and stop.`;
          continue;
        }

        // The model stopped and reported progress instead of finishing.
        // Two signals, strongest first: steps it recorded but never ticked
        // off, then language describing work still in flight ("is
        // underway", "next steps"). Either way, push it to carry on rather
        // than ending the task half-done.
        const pending = this.journal?.pendingSteps() ?? [];
        const stoppedEarly = pending.length > 0 || looksUnfinished(reply);
        if (continueNudges < MAX_CONTINUE_NUDGES && stoppedEarly) {
          continueNudges++;
          const why = pending.length
            ? `${pending.length} plan step(s) still open`
            : "the reply describes work still in progress";
          log(noteLine(`not finished — ${why}; continuing (${continueNudges}/${MAX_CONTINUE_NUDGES})`));
          await this.journal?.log(`continue nudge: ${why}`);
          message =
            `That was a progress report, not a finished task — do not stop here.\n` +
            (pending.length
              ? `These plan steps are still open:\n${pending.map((p) => `- ${p}`).join("\n")}\n\n`
              : "") +
            `Carry on now with the next action. Reply with a tool call (a code block containing ` +
            `{"name": ..., "args": ...}) and keep going until every step is actually done. ` +
            `Only answer in plain prose when the work is genuinely complete — and say so explicitly.`;
          continue;
        }
        // A final answer that names files which don't exist is wrong in the
        // way nobody reading a terminal can detect. Check mechanically, once.
        const missing = citationNudges < 1 ? missingCitedPaths(parsed.text) : [];
        if (missing.length) {
          citationNudges++;
          log(noteLine(`answer cites ${missing.length} path(s) that don't exist (${missing.slice(0, 3).join(", ")}) — asking it to verify`));
          await this.journal?.log(`citation check: missing ${missing.join(", ")}`);
          message =
            `Your answer cites files that do NOT exist in this workspace:\n${missing.map((p) => `- ${p}`).join("\n")}\n\n` +
            `Do not guess paths. Use find_files / search_code to locate the real files (or establish that they don't ` +
            `exist), read them, then give the answer again citing only paths and lines you have actually seen in a ` +
            `tool result in this thread. If something could not be found, say so plainly instead of naming a likely place.`;
          continue;
        }
        await this.journal?.complete(parsed.text);
        return parsed.text;
      }

      if (parsed.kind === "malformed") {
        log(noteLine("malformed tool call — asking Gemini to retry"));
        message = formatToolResult(
          `Error: that wasn't valid tool-call JSON: ${parsed.error}\nRaw content: ${parsed.raw}\nPlease reissue a single valid tool call (a code block containing only {"name": ..., "args": ...}), or answer in plain text instead.`
        );
        continue;
      }

      // kind === "tool_call" — one call, or several independent ones that
      // the model batched into one reply. They run in order; every result
      // goes back in the same message, so N reads cost one web-UI round
      // trip instead of N.
      const batch = parsed.calls;
      if (batch.length > 1) log(noteLine(`${batch.length} tool calls in one reply — running them in order`));
      const sections: string[] = [];
      let stalled = false;
      for (let i = 0; i < batch.length; i++) {
        const { name, args } = batch[i];
        toolCallsMade++;
        log(toolCallLine(name, args));
        const tool = this.toolsByName[name];
        const result: ToolResult = tool
          ? await this.runWithWatchdog(tool, args)
          : { ok: false, output: `Error: unknown tool "${name}". Available: ${Object.keys(this.toolsByName).join(", ")}` };

        log(toolResultLine(result.ok, result.output));

        // Loop detection. Two shapes seen in long runs: the same call with
        // the same args over and over (re-reading a file it already has),
        // and ping-pong between two calls. Say so once per streak, inside
        // the result, so the model can't miss it.
        const signature = `${name}:${JSON.stringify(args).slice(0, 400)}`;
        recentCalls.push(signature);
        if (recentCalls.length > 6) recentCalls.shift();
        const n = recentCalls.length;
        const identical = n >= 3 && recentCalls.slice(-3).every((c) => c === signature);
        const pingPong =
          n >= 4 && recentCalls[n - 1] === recentCalls[n - 3] && recentCalls[n - 2] === recentCalls[n - 4] && recentCalls[n - 1] !== recentCalls[n - 2];
        const streakKey = identical ? `same:${signature}` : pingPong ? `pingpong:${recentCalls[n - 1]}|${recentCalls[n - 2]}` : "";
        if (streakKey && streakKey !== repeatNoted && result.ok) {
          repeatNoted = streakKey;
          log(noteLine(identical ? "same call three times in a row — pointing it out" : "alternating between two calls — pointing it out"));
          await this.journal?.log(`loop detected: ${identical ? "identical call x3" : "ping-pong"} (${name})`);
          result.output +=
            `\n\n[NOTE: ${identical ? `this is the third identical ${name} call in a row, and the result has not changed` : `you are alternating between the same two calls`}. ` +
            `You already have this information. Use it to take the next real step — an edit, a command, or your final answer — ` +
            `or, if you are stuck, say what is blocking you.]`;
        } else if (!streakKey) {
          repeatNoted = "";
        }

        // Exploring forever is its own kind of stall.
        if (READ_ONLY_TOOLS.has(name)) readOnlyStreak++;
        else {
          readOnlyStreak = 0;
          exploreNoted = false;
        }
        if (exploreNudgeTurns() > 0 && readOnlyStreak >= exploreNudgeTurns() && !exploreNoted) {
          exploreNoted = true;
          log(noteLine(`${readOnlyStreak} read-only calls in a row — asking it to act or report`));
          await this.journal?.log(`explore nudge after ${readOnlyStreak} read-only calls`);
          result.output +=
            `\n\n[NOTE: that is ${readOnlyStreak} consecutive read-only calls. If you now have what you need, make the ` +
            `change. If the task only needed an answer, give it. If something blocks you, say exactly what.]`;
        }

        if (result.ok) {
          turnsSinceProgress = 0;
          lastFailure = "";
          sameFailureCount = 0;
        } else {
          turnsSinceProgress++;
          // Same tool, same first line of error = the same wall, hit again.
          const signature = `${name}: ${result.output.split("\n")[0].slice(0, 120)}`;
          sameFailureCount = signature === lastFailure ? sameFailureCount + 1 : 1;
          lastFailure = signature;
        }
        await this.journal?.log(
          `${name}(${truncateArgs(args)}) -> ${result.ok ? "ok" : "ERROR"}: ${result.output.replace(/\s+/g, " ").slice(0, 160)}`
        );

        // Repeating one failing call wastes the whole task. Say plainly that
        // this approach is not working and name the ways out, once — the
        // model otherwise tends to re-send a near-identical call.
        if (!result.ok && (sameFailureCount >= REPEAT_FAILURE_LIMIT || turnsSinceProgress >= STALL_TURNS)) {
          const why =
            sameFailureCount >= REPEAT_FAILURE_LIMIT
              ? `That is ${sameFailureCount} attempts at ${name} failing the same way.`
              : `Nothing has succeeded for ${turnsSinceProgress} turns.`;
          log(noteLine(`stuck — telling it to change approach (${why})`));
          await this.journal?.log(`stall: ${why}`);
          sections.push(
            `${this.label(batch, i)}${result.output}\n\n` +
              `STOP AND CHANGE APPROACH. ${why} Repeating it will not start working.\n` +
              `- If an edit will not match, read the file again and copy the target text from what you just read, ` +
              `or replace the whole file with write_file.\n` +
              `- If a command keeps failing, read its error with check_output before running it again.\n` +
              `- If this step cannot be done, move on to the next one and report what you skipped at the end.`
          );
          turnsSinceProgress = 0;
          sameFailureCount = 0;
          lastFailure = "";
          stalled = true;
          break;
        }

        if (result.attachment) {
          // A tool handed back a file (e.g. a screenshot) for Gemini to see.
          attachFile.push(result.attachment);
          log(noteLine(`attaching ${path.basename(result.attachment)}`));
          sections.push(`${this.label(batch, i)}${result.output}`);
        } else if (result.output.length > MAX_INLINE_RESULT_CHARS) {
          const attached = await this.writeAttachment(name, args, result.output, batch.length > 1 ? i + 1 : undefined);
          attachFile.push(attached);
          log(noteLine(`too long to paste — attaching ${path.basename(attached)}`));
          sections.push(
            `${this.label(batch, i)}Output was too long to paste (${result.output.length} characters), so it is ATTACHED ` +
              `to this message as "${path.basename(attached)}". Read the attached file for the full result.`
          );
        } else {
          sections.push(`${this.label(batch, i)}${result.output}`);
        }
      }
      if (stalled && batch.length > 1) {
        sections.push(`(The remaining ${batch.length - sections.length} call(s) in that batch were not run.)`);
      }
      message = formatToolResult(sections.join("\n\n"));
    }

    await this.journal?.markInterrupted("hit the max tool-call turns");
    return (
      `(Stopped: hit the ${MAX_TOOL_TURNS_PER_TASK}-turn limit for one task without a final answer. ` +
      `The plan was journalled, so asking me to continue picks up where it left off. ` +
      `If this keeps happening on the same step, that step is looping rather than progressing.)`
    );
  }

  /** Runs a tool with a hard timeout, so one wedged call can't stall the loop. */
  private async runWithWatchdog(tool: ToolDefinition, args: Record<string, unknown>): Promise<ToolResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            output:
              `Error: ${tool.name} did not finish within ${Math.round(toolTimeoutMs() / 1000)}s and was abandoned. ` +
              `If it was a long-running command, run it with background: true and read it with check_output; ` +
              `otherwise try a narrower call.`,
          }),
        toolTimeoutMs()
      );
    });
    try {
      return await Promise.race([
        tool.run(args).catch((err): ToolResult => ({ ok: false, output: `Error: ${tool.name} threw: ${(err as Error).message}` })),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The first message of a thread: rules inline, knowledge attached when big. */
  private async buildPrimedMessage(
    taskText: string,
    log: (msg: string) => void
  ): Promise<{ message: string; attach?: string }> {
    this.primed = true;
    const primer = buildSystemPrimer(this.tools, this.role);
    const contextDoc = buildContextDocument(this.context);

    if (!contextDoc) {
      return { message: `${primer}\n\n---\n\nTASK:\n${taskText}` };
    }
    if (contextDoc.length <= MAX_INLINE_CONTEXT_CHARS) {
      return { message: `${primer}\n\n---\n\n${contextDoc}\n\n---\n\nTASK:\n${taskText}` };
    }
    // Too big for the composer — send the rules inline (they must not
    // depend on Gemini opening a file) and attach the knowledge.
    const attach = await this.writeContextFile(contextDoc);
    log(noteLine(`context is ${contextDoc.length} chars — attaching context.md`));
    return {
      message:
        `${primer}\n\n---\n\nProject context (structure, memory, and the project's own docs) ` +
        `is ATTACHED to this message as "context.md". Read it first.\n\n` +
        `---\n\nTASK:\n${taskText}`,
      attach,
    };
  }

  /**
   * Closes the current thread and opens a fresh one, carrying a handoff note
   * the model writes for itself. Returns the note, or undefined when the
   * driver can't start threads (tests) or nothing has been sent yet.
   */
  async compact(reason: string, log: (msg: string) => void = () => {}): Promise<string | undefined> {
    if (!this.driver.newConversation || !this.primed) return undefined;
    log(noteLine(`compacting — ${reason}: asking for a handoff note, then starting a fresh thread`));
    let note = "";
    try {
      const reply = await this.exchange(
        `CONTEXT RESET COMING. Do not call tools. Reply with ONLY a handoff note in exactly this Markdown ` +
          `template, for another instance of you that will continue this work with none of this thread:\n\n` +
          `## Goal\nWhat the user asked for and what they actually want, in two or three sentences.\n\n` +
          `## Done\nEach file created or changed, with what changed and why. Commands that were run and their outcome.\n\n` +
          `## Active\nWhat was in the middle of being done when the reset came, precisely.\n\n` +
          `## Next\nThe remaining steps, in order, concrete enough to execute.\n\n` +
          `## Key files\nAt most 15 paths another agent must open to continue, most important first, including paths ` +
          `in other workspace roots. Not every file that was read.\n\n` +
          `## Facts\nThings that cannot be rediscovered cheaply: exact function names and signatures, commands that ` +
          `work (and ones that don't), conventions observed, decisions made and why. Or "(none)".\n\n` +
          `## Open questions\nUnresolved doubts, blockers, things the user still needs to decide. Or "(none)".\n\n` +
          `Leave out the tool protocol, the project instructions and the repository layout — the next instance ` +
          `receives those separately. Under 700 words. Do not mention that the context was compacted.`,
        [],
        log
      );
      note = reply.text.trim();
    } catch (err) {
      log(noteLine(`couldn't get a handoff note (${(err as Error).message.split("\n")[0]}) — using the plan journal only`));
    }
    const plan = this.journal?.pendingSteps() ?? [];
    const journalPart = plan.length ? `\n\nOpen plan steps:\n${plan.map((p) => `- [ ] ${p}`).join("\n")}` : "";
    this.context.handoff = `${note || "(no note was produced)"}${journalPart}`;
    await this.driver.newConversation();
    forgetAll(); // the new thread has read nothing yet
    this.primed = false;
    this.exchanges = 0;
    await this.journal?.log(`compacted thread (${reason})`);
    return this.context.handoff;
  }

  /** `/compact`: the same, at the user's request, between tasks. */
  async compactNow(log: (msg: string) => void = () => {}): Promise<string | undefined> {
    return this.compact("requested with /compact", log);
  }

  /**
   * Sends one message and returns Gemini's reply, retrying the WHOLE
   * exchange on failure.
   *
   * Retrying only the wait (the obvious-looking version) is useless: the
   * common failure is Gemini accepting a message and then never generating
   * a reply, so waiting again just burns another timeout. Re-sending is what
   * actually recovers. A duplicated tool result in the thread is a much
   * cheaper problem than a hung task.
   */
  private async exchange(
    message: string,
    attachFile: string[],
    log: (msg: string) => void,
    cancelSignal?: AbortSignal
  ) {
    let lastError: Error | undefined;

    if (message.length > COMPOSER_MAX_CHARS) {
      const file = await this.writeAttachment("message", {}, message);
      log(noteLine(`message is ${message.length} chars — over the composer's limit; attaching it in full as ${path.basename(file)}`));
      attachFile = [...attachFile, file];
      message =
        `${message.slice(0, COMPOSER_MAX_CHARS - 600)}\n\n[... this message was too long for the composer. ` +
        `The COMPLETE message, including everything cut here, is ATTACHED as "${path.basename(file)}" — read it before acting.]`;
    }

    // Cancellation can arrive while we wait minutes for a reply: race the
    // wait against it, and stop the generation so the tab is reusable.
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      if (!cancelSignal) return;
      if (cancelSignal.aborted) reject(new TaskCancelledError());
      onAbort = () => reject(new TaskCancelledError());
      cancelSignal.addEventListener("abort", onAbort, { once: true });
    });
    // Promise.race observes the rejection, so no unhandled rejection; but the
    // listener must not pile up turn after turn on one signal.
    const detach = () => {
      if (cancelSignal && onAbort) cancelSignal.removeEventListener("abort", onAbort);
    };

    // Attempts that hit a recoverable environment problem (offline, signed
    // out) don't count against the retry budget — they aren't Gemini's fault.
    let environmentPauses = 0;
    for (let attempt = 0; attempt <= TURN_RETRIES; attempt++) {
      try {
        const send = async () => {
          if (attachFile.length && attempt === 0) {
            try {
              await this.driver.sendPrompt(message, { attachFile });
            } catch (err) {
              // Uploading is best-effort: fall back to pasting a truncated
              // version rather than killing the task. Losing some context
              // beats losing the run.
              log(noteLine(`attachment failed (${(err as Error).message.split("\n")[0]}) — pasting truncated text instead`));
              const inlineFallback = await readFile(attachFile[0], "utf8").catch(() => "");
              await this.driver.sendPrompt(
                `${message}\n\nCORRECTION: that attachment FAILED to upload — there is no file to open, ` +
                  `so ignore the instruction to read one. The content itself follows inline:\n\n` +
                  inlineFallback.slice(0, MAX_INLINE_RESULT_CHARS) +
                  (inlineFallback.length > MAX_INLINE_RESULT_CHARS ? "\n\n[truncated]" : "")
              );
            }
          } else {
            // Retries re-send as plain text: if the upload already landed it's
            // still in the thread, and re-uploading would just duplicate it.
            await this.driver.sendPrompt(message);
          }
          await this.driver.waitForResponseComplete();
          this.exchanges++;
          return await this.driver.getLastResponse();
        };
        const reply = await (cancelSignal ? Promise.race([send(), cancelled]) : send());
        detach();
        return reply;
      } catch (err) {
        detach();
        if (err instanceof TaskCancelledError) {
          await this.driver.stopGenerating?.().catch(() => false);
          throw err;
        }
        lastError = err as Error;
        const first = lastError.message.split("\n")[0];

        // Is the tab even there any more? Closed tab, crashed renderer,
        // dropped CDP connection, Chrome quit.
        const alive = this.driver.isAlive ? await this.driver.isAlive().catch(() => false) : true;
        if (!alive) {
          log(noteLine(`the browser tab is gone (${first}) — recovering`));
          await this.journal?.log(`browser tab lost: ${first}`);
          const recovered = this.driver.recover ? await this.driver.recover(log) : false;
          if (recovered) throw new ThreadLostError();
          throw new Error(`Lost the browser and couldn't get it back: ${first}. Start Chrome (gemini-code open-chrome) and run the task again; the plan was journalled.`);
        }

        // Offline: wait for the network rather than burning retries.
        if (environmentPauses < 3 && this.driver.isOffline && (await this.driver.isOffline().catch(() => false))) {
          environmentPauses++;
          log(noteLine("the browser is offline — waiting for the network to come back"));
          const back = this.driver.waitForOnline ? await this.driver.waitForOnline(OFFLINE_WAIT_MS, log) : false;
          if (!back) throw new Error(`Still offline after ${Math.round(OFFLINE_WAIT_MS / 60_000)} minutes. The plan was journalled; run the task again when the network is back.`);
          attempt--;
          continue;
        }

        // Signed out mid-task (session expiry): the interactive path brings
        // the window up and waits; unattended it throws a clear message.
        if (environmentPauses < 3 && this.driver.isLoggedIn && !(await this.driver.isLoggedIn().catch(() => true))) {
          environmentPauses++;
          log(noteLine("the Gemini session is signed out — waiting for sign-in"));
          await this.journal?.log("signed out mid-task");
          await this.driver.ensureLoggedIn?.();
          attempt--;
          continue;
        }

        if (attempt < TURN_RETRIES) {
          // A reply that never finished is the common case: stop it so the
          // composer is usable, then resend.
          const stopped = await this.driver.stopGenerating?.().catch(() => false);
          log(noteLine(`no reply (${first})${stopped ? " — stopped the stuck generation" : ""} — resending, attempt ${attempt + 2}/${TURN_RETRIES + 1}`));
          await this.journal?.log(`retrying turn: ${first}`);
          await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
        }
      }
    }

    throw lastError ?? new Error("No response from Gemini after retries.");
  }

  /**
   * Deletes attachments we generated, and ONLY those.
   *
   * Attachments can be the user's own files — a screenshot they pasted, an
   * image they pointed at — and deleting those would be destroying their
   * data as a side effect of sending a message. Only files inside our temp
   * directory are ours to remove.
   */
  private async cleanupAttachments(files: string[]): Promise<void> {
    const tmpDir = path.resolve(process.cwd(), TMP_DIR);
    for (const file of files) {
      if (path.resolve(file).startsWith(tmpDir + path.sep)) {
        await rm(file, { force: true }).catch(() => {});
      }
    }
  }

  /** Writes the project-context document to a temp file for upload. */
  private async writeContextFile(contextDoc: string): Promise<string> {
    const dir = path.resolve(process.cwd(), TMP_DIR);
    await mkdir(dir, { recursive: true });
    // Short, stable name on purpose: the attachment chip ellipsizes long
    // filenames, which broke the "did the upload land?" check. .md so Gemini
    // renders/parses it as the markdown document it is.
    const filePath = path.join(dir, "context.md");
    await writeFile(filePath, contextDoc, "utf8");
    return filePath;
  }

  /** Heads each result in a batched reply, so the model can tell them apart. */
  private label(batch: { name: string; args: Record<string, unknown> }[], i: number): string {
    if (batch.length === 1) return "";
    return `[${i + 1}/${batch.length}] ${batch[i].name}(${truncateArgs(batch[i].args)}):\n`;
  }

  /** Writes an oversized tool result to a temp file for upload, named after what produced it. */
  private async writeAttachment(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    /** Position in a batch, so two long results in one turn don't share a filename. */
    index?: number
  ): Promise<string> {
    const dir = path.resolve(process.cwd(), TMP_DIR);
    await mkdir(dir, { recursive: true });

    // Preserve the original extension where we can, so Gemini renders/parses
    // the attachment sensibly (a .ts file as code, not as opaque text).
    // No timestamp prefix: the attachment chip ellipsizes long filenames,
    // and the upload check matches on the name. Files are deleted right
    // after sending, so reuse is safe.
    const sourcePath = typeof args.path === "string" ? args.path : undefined;
    const base = sourcePath ? path.basename(sourcePath) : `${toolName}-output.txt`;
    const filePath = path.join(dir, index === undefined ? base : `${index}-${base}`);

    await writeFile(filePath, output, "utf8");
    return filePath;
  }
}


function truncateArgs(args: Record<string, unknown>): string {
  const primary = args.path ?? args.command ?? args.url;
  if (typeof primary === "string") return primary.slice(0, 80);
  return JSON.stringify(args).slice(0, 80);
}
