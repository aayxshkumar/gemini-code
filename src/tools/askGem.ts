import type { ToolDefinition } from "../types.js";
import type { GeminiDriver, Gem } from "../driver/GeminiDriver.js";

/** A Gem's answer is reference material, not a deliverable — keep it short. */
const MAX_ANSWER_CHARS = 6_000;

/**
 * Consults that fail back to back before ask_gem stops trying for the rest of
 * the session. Each failed consult can block for a full response timeout, and
 * twice over with the retry, so a Gem that is down would otherwise cost the
 * task minutes per call while the model keeps asking anyway.
 */
const MAX_CONSECUTIVE_FAILURES = 2;

export interface AskGemDeps {
  /** The Gem being consulted, for the tool's description and its messages. */
  gem: Gem;
  /**
   * Opens (once) the tab that lives inside the Gem. Lazy on purpose: a session
   * may never ask it anything, and a tab nobody uses is still a tab the user
   * has to look at.
   */
  openTab: () => Promise<GeminiDriver>;
  log?: (msg: string) => void;
}

/**
 * Lets the agent ask a Gem a question, WITHOUT running the session inside it.
 *
 * Running the whole loop inside a Gem works, but it makes the Gem responsible
 * for everything: its own instructions sit alongside the tool protocol, and a
 * conversational Gem answers with prose where a tool call was asked for. Used
 * this way the Gem is what it is good at — a reference on the project — while
 * the coding conversation stays a plain Gemini thread that follows the protocol.
 *
 * The Gem tab is a plain Q&A thread: no tools, no primer. It keeps its history
 * across questions, so follow-ups work.
 */
export function createAskGemTool(deps: AskGemDeps): {
  tool: ToolDefinition;
  close: () => Promise<void>;
} {
  let tab: GeminiDriver | undefined;
  // One Gem tab, one question at a time: the orchestrator and its parallel
  // workers share this tool, and two prompts typed into the same thread at once
  // would interleave and both come back wrong.
  let queue: Promise<unknown> = Promise.resolve();
  let consecutiveFailures = 0;

  /**
   * Throws the tab away. A tab that failed mid-question may be wedged — still
   * generating, navigated off the Gem, or holding a half-typed prompt — and
   * keeping it would make every later consult fail the same way. The cost is
   * the thread's history, so a follow-up question loses its earlier context.
   */
  async function resetTab(): Promise<void> {
    const old = tab;
    tab = undefined;
    await old?.close().catch(() => undefined);
  }

  async function consult(question: string): Promise<string> {
    if (!tab) {
      deps.log?.(`  ⎿ opening a tab in the Gem "${deps.gem.name}"`);
      tab = await deps.openTab();
    }
    await tab.sendPrompt(question);
    await tab.waitForResponseComplete();
    const answer = (await tab.getLastResponse()).text.trim();
    // Empty is treated as a failure, not an answer: it's what a reply that
    // hadn't rendered yet, or a refused one, reads as.
    if (!answer) throw new Error(`the Gem "${deps.gem.name}" returned an empty answer`);
    return answer;
  }

  async function ask(question: string): Promise<{ ok: boolean; output: string }> {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return {
        ok: false,
        output:
          `ask_gem is unavailable for the rest of this session — the Gem "${deps.gem.name}" failed ` +
          `${consecutiveFailures} times in a row. Do not call it again; carry on from the files and tools.`,
      };
    }

    // One retry, in a FRESH tab. Re-asking in the tab that just failed would
    // usually fail the same way; the common transient failures (a send that
    // didn't land, a reply that never started) clear on a new thread.
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const answer = await consult(question);
        consecutiveFailures = 0;
        const clipped =
          answer.length > MAX_ANSWER_CHARS
            ? `${answer.slice(0, MAX_ANSWER_CHARS)}\n\n[truncated — ask something narrower for the rest]`
            : answer;
        return { ok: true, output: `The Gem "${deps.gem.name}" says:\n\n${clipped}` };
      } catch (err) {
        lastError = err as Error;
        await resetTab();
        if (attempt === 0) deps.log?.(`  ⎿ Gem consult failed (${lastError.message.split("\n")[0]}) — retrying in a fresh tab`);
      }
    }

    // A failed consult must not kill the task: the agent can carry on from
    // the files, it just loses the background.
    consecutiveFailures++;
    return {
      ok: false,
      output:
        `Couldn't ask the Gem "${deps.gem.name}": ${lastError?.message.split("\n")[0]}\n` +
        `Carry on using the files and tools instead of retrying this.`,
    };
  }

  const tool: ToolDefinition = {
    name: "ask_gem",
    description:
      `ask_gem(args: {question: string}) -> asks the project's Gem ("${deps.gem.name}") a question and returns its ` +
      `answer as text. The Gem holds durable knowledge about this project — conventions, architecture, domain rules, ` +
      `decisions already made — that isn't in the files you can read. Use it when you need that background: how ` +
      `something is normally done here, why a thing is the way it is, or which approach fits the project. It is a ` +
      `REFERENCE only: it cannot see the working tree, run commands or edit files, so never ask it to do work, and ` +
      `never trust it over what you read in the files. Read the code for facts about the code; ask the Gem for the ` +
      `reasoning around it.`,
    async run(args) {
      const question = String(args.question ?? "").trim();
      if (!question) return { ok: false, output: "Error: 'question' is required." };

      const turn = queue.then(() => ask(question));
      // Keep the chain alive even if one question throws.
      queue = turn.catch(() => undefined);
      return turn;
    },
  };

  return {
    tool,
    /** Closes the Gem tab, if one was ever opened. */
    async close() {
      await resetTab();
    },
  };
}
