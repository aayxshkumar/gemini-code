/**
 * A single owner for terminal input.
 *
 * The REPL keeps a readline interface open for the whole session. If a
 * confirmation prompt opens a SECOND one on the same stdin, both echo every
 * keystroke (so "y" appears as "yy") and both receive the line — meaning the
 * answer to "(y/N)" also lands in the REPL's queue and gets sent to Gemini
 * as if it were a task. So confirmations ask through whoever already owns
 * stdin, rather than competing for it.
 */
export type Asker = (question: string) => Promise<string>;

let asker: Asker | undefined;

/** Registered by the CLI so prompts reuse its readline instead of making one. */
export function setAsker(fn: Asker | undefined): void {
  asker = fn;
}

export function getAsker(): Asker | undefined {
  return asker;
}

/** A question with choices, for a front end that can show them as choices. */
export type Questioner = (question: string, options: string[]) => Promise<string>;

let questioner: Questioner | undefined;

export function setQuestioner(fn: Questioner | undefined): void {
  questioner = fn;
}

export function getQuestioner(): Questioner | undefined {
  return questioner;
}
