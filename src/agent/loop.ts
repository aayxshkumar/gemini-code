import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { IGeminiDriver } from "../driver/IGeminiDriver.js";
import { tools } from "../tools/index.js";
import type { ToolDefinition } from "../types.js";
import {
  buildSystemPrimer,
  buildContextDocument,
  buildProtocolReminder,
  formatToolResult,
  type PrimerContext,
  type AgentRole,
} from "./promptTemplate.js";
import { parseGeminiReply, looksLikeAbandonedWork, looksUnfinished } from "./toolCallParser.js";
import { toolCallLine, toolResultLine, noteLine } from "../ui/format.js";
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
/**
 * Inside a Gem the contract is restated more often. The Gem's own
 * instructions are re-applied on every turn at system level while our primer
 * only gets older, so a conversational Gem drifts back to prose much sooner
 * than a plain thread does.
 */
const GEM_REMINDER_EVERY_TURNS = Math.max(0, Number(process.env.GEMINI_CODE_GEM_REMINDER_TURNS ?? 3));
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

/** Transient driver failures (send/response) are retried this many times. */
const TURN_RETRIES = Math.max(0, Number(process.env.GEMINI_CODE_TURN_RETRIES ?? 2));

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
}

export class AgentSession {
  private primed = false;
  /** Static tools plus any session-scoped ones (e.g. delegate_tasks). */
  private readonly tools: ToolDefinition[];
  private readonly toolsByName: Record<string, ToolDefinition>;
  private readonly toolNames: ReadonlySet<string>;

  constructor(
    private readonly driver: IGeminiDriver,
    private readonly context: PrimerContext = {},
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

  /**
   * The Gem this session's tab is inside, read live from the driver rather
   * than captured once: workers inherit their parent's Gem, and /gem can
   * switch it between tasks.
   */
  private gemName(): string | undefined {
    return this.driver.currentGem?.name;
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
    let toolCallsMade = 0;
    // Progress tracking, so a task that is stuck can be told so instead of
    // quietly repeating itself until the turn limit.
    let turnsSinceProgress = 0;
    let lastFailure = "";
    let sameFailureCount = 0;

    if (!this.primed) {
      this.primed = true;
      const primer = buildSystemPrimer(this.tools, this.role, { insideGem: this.gemName() });
      const contextDoc = buildContextDocument(this.context);

      if (!contextDoc) {
        message = `${primer}\n\n---\n\nTASK:\n${userTask}`;
      } else if (contextDoc.length <= MAX_INLINE_CONTEXT_CHARS) {
        message = `${primer}\n\n---\n\n${contextDoc}\n\n---\n\nTASK:\n${userTask}`;
      } else {
        // Too big for the composer — send the rules inline (they must not
        // depend on Gemini opening a file) and attach the knowledge.
        attachFile.push(await this.writeContextFile(contextDoc));
        log(noteLine(`context is ${contextDoc.length} chars — attaching context.md`));
        message =
          `${primer}\n\n---\n\nProject context (structure, memory, and the project's own docs) ` +
          `is ATTACHED to this message as "context.md". Read it first.\n\n` +
          `---\n\nTASK:\n${userTask}`;
      }
    }

    for (let turn = 0; turn < MAX_TOOL_TURNS_PER_TASK; turn++) {
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
      // Skipped when this turn's message already IS a reminder (a drift or
      // idle nudge), or the model would get the same block twice in a row.
      const every = this.gemName() ? GEM_REMINDER_EVERY_TURNS : REMINDER_EVERY_TURNS;
      if (every > 0 && turn > 0 && turn % every === 0 && !message.startsWith("REMINDER")) {
        message = `${buildProtocolReminder(this.gemName())}\n\n${message}`;
      }

      const reply = await this.exchange(message, attachFile, log);
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
          message = buildProtocolReminder(this.gemName());
          continue;
        }

        // Backstop: the task is ending and nothing was ever done. No
        // wording to match on — just the fact that no tool ran.
        if (toolCallsMade === 0 && idleNudges < maxIdleNudges()) {
          idleNudges++;
          log(noteLine("answered without using any tool — asking it to act instead"));
          await this.journal?.log("idle nudge: reply used no tools");
          message =
            `${buildProtocolReminder(this.gemName())}\n\n` +
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

      // kind === "tool_call"
      toolCallsMade++;
      const { name, args } = parsed.call;
      log(toolCallLine(name, args));
      const tool = this.toolsByName[name];
      const result = tool
        ? await tool.run(args)
        : { ok: false, output: `Error: unknown tool "${name}". Available: ${Object.keys(this.toolsByName).join(", ")}` };

      log(toolResultLine(result.ok, result.output));

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
      // this approach is not working and name the ways out, once — the model
      // otherwise tends to re-send a near-identical call.
      if (!result.ok && (sameFailureCount >= REPEAT_FAILURE_LIMIT || turnsSinceProgress >= STALL_TURNS)) {
        const why =
          sameFailureCount >= REPEAT_FAILURE_LIMIT
            ? `That is ${sameFailureCount} attempts at ${name} failing the same way.`
            : `Nothing has succeeded for ${turnsSinceProgress} turns.`;
        log(noteLine(`stuck — telling it to change approach (${why})`));
        await this.journal?.log(`stall: ${why}`);
        message = formatToolResult(
          `${result.output}\n\n` +
            `STOP AND CHANGE APPROACH. ${why} Repeating it will not start working.\n` +
            `- If an edit will not match, read the file again and copy the target text from what you just read, ` +
            `or replace the whole file with write_file.\n` +
            `- If a command keeps failing, read its error with check_output before running it again.\n` +
            `- If this step cannot be done, move on to the next one and report what you skipped at the end.`
        );
        turnsSinceProgress = 0;
        sameFailureCount = 0;
        lastFailure = "";
        continue;
      }

      if (result.attachment) {
        // A tool handed back a file (e.g. a screenshot) for Gemini to see.
        attachFile.push(result.attachment);
        log(noteLine(`attaching ${path.basename(result.attachment)}`));
        message = formatToolResult(result.output);
      } else if (result.output.length > MAX_INLINE_RESULT_CHARS) {
        attachFile.push(await this.writeAttachment(name, args, result.output));
        const attached = attachFile[attachFile.length - 1];
        log(noteLine(`too long to paste — attaching ${path.basename(attached)}`));
        message = formatToolResult(
          `Output was too long to paste (${result.output.length} characters), so it is ATTACHED to this message as "${path.basename(attached)}". Read the attached file for the full result.`
        );
      } else {
        message = formatToolResult(result.output);
      }
    }

    await this.journal?.markInterrupted("hit the max tool-call turns");
    return (
      `(Stopped: hit the ${MAX_TOOL_TURNS_PER_TASK}-turn limit for one task without a final answer. ` +
      `The plan was journalled, so asking me to continue picks up where it left off. ` +
      `If this keeps happening on the same step, that step is looping rather than progressing.)`
    );
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
    log: (msg: string) => void
  ) {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= TURN_RETRIES; attempt++) {
      try {
        if (attachFile.length && attempt === 0) {
          try {
            await this.driver.sendPrompt(message, { attachFile });
          } catch (err) {
            // Uploading is best-effort: fall back to pasting a truncated
            // version rather than killing the task. Losing some context
            // beats losing the run.
            log(noteLine(`attachment failed (${(err as Error).message.split("\n")[0]}) — pasting truncated text instead`));
            const inlineFallback = await readFile(attachFile[0], "utf8").catch(() => "");
            // The message above already told Gemini to read an attachment
            // that isn't there. Say plainly that it doesn't exist, or the
            // reply is "I can't see any attachment" and the task stalls
            // re-asking for it.
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
        return await this.driver.getLastResponse();
      } catch (err) {
        lastError = err as Error;
        if (attempt < TURN_RETRIES) {
          log(noteLine(`no reply (${lastError.message.split("\n")[0]}) — resending, attempt ${attempt + 2}/${TURN_RETRIES + 1}`));
          await this.journal?.log(`retrying turn: ${lastError.message.split("\n")[0]}`);
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

  /** Writes an oversized tool result to a temp file for upload, named after what produced it. */
  private async writeAttachment(
    toolName: string,
    args: Record<string, unknown>,
    output: string
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
    const filePath = path.join(dir, base);

    await writeFile(filePath, output, "utf8");
    return filePath;
  }
}


function truncateArgs(args: Record<string, unknown>): string {
  const primary = args.path ?? args.command ?? args.url;
  if (typeof primary === "string") return primary.slice(0, 80);
  return JSON.stringify(args).slice(0, 80);
}
