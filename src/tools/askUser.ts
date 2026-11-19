import type { ToolDefinition } from "../types.js";
import { askQuestion, unattended } from "./confirm.js";

const MAX_OPTIONS = 6;

/**
 * Lets the model ask the person a question instead of guessing — OpenCode's
 * `question` tool, Claude Code's AskUserQuestion. In a big codebase the
 * expensive mistake is a confident wrong assumption carried through twenty
 * edits; one question up front is cheaper. Unattended (piped stdin, no
 * terminal, no desktop app) it says so and tells the model to proceed on the
 * safest assumption and state it, so a script never blocks. The desktop app
 * shows the options as buttons through the questioner.
 */
export const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    `ask_user(args: {question: string, options?: string[]}) -> asks the person running this session a question and ` +
    `returns their answer. Use it ONLY for a genuine decision you cannot resolve from the code or the task — which ` +
    `of two designs they want, whether to touch a second repository, a missing credential or URL. Do not use it to ` +
    `ask permission for ordinary work (writes and commands are already confirmed separately), or for things you ` +
    `could find out with the other tools. Offer up to ${MAX_OPTIONS} short options when there are obvious choices; ` +
    `they can still type something else.`,
  async run(args) {
    const question = String(args.question ?? "").trim();
    if (!question) return { ok: false, output: "Error: 'question' is required." };
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, MAX_OPTIONS) : [];

    const nobody =
      "No one is available to answer (non-interactive session). Proceed with the safest reasonable assumption, " +
      "state that assumption explicitly in your final answer, and keep the change easy to adjust.";
    if (unattended()) return { ok: true, output: nobody };

    const answer = await askQuestion(question, options);
    if (answer === undefined) return { ok: true, output: nobody };
    if (!answer.trim()) return { ok: true, output: "The user gave no answer. Proceed with the most reasonable default and say which you chose." };
    return { ok: true, output: `The user answered: ${answer.trim()}` };
  },
};
