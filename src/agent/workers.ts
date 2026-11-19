import type { GeminiDriver } from "../driver/GeminiDriver.js";
import type { ToolDefinition } from "../types.js";
import type { PrimerContext } from "./promptTemplate.js";
import { c } from "../ui/format.js";

export interface SubTask {
  /** Short label used in logs and in the result Gemini gets back. */
  name: string;
  /** The self-contained instruction for this worker. */
  prompt: string;
}

export interface SubTaskResult {
  name: string;
  ok: boolean;
  result: string;
}

/**
 * How many worker tabs run at once. Kept low on purpose: every worker is a
 * real browser tab driving a real Gemini session on one account, so this is
 * the knob that decides how hard we lean on it. Raise with
 * GEMINI_CODE_MAX_WORKERS if your usage allows.
 */
export const MAX_PARALLEL_WORKERS = Math.max(
  1,
  Number(process.env.GEMINI_CODE_MAX_WORKERS ?? 3)
);

/**
 * Worker reports are truncated to this before reaching the orchestrator.
 * The whole point of the master/worker split is that the main thread's
 * context does not grow with implementation detail — a worker that ignores
 * its instructions and pastes a whole file must not be able to undo that.
 */
export const MAX_WORKER_REPORT_CHARS = Math.max(
  200,
  Number(process.env.GEMINI_CODE_MAX_REPORT_CHARS ?? 2_000)
);

// Read at call time, not module load, so tests and scripts can change
// these per-run instead of only via the process's startup environment.
/** How many times a failed worker is retried in a fresh tab. */
export const workerRetries = (): number =>
  Math.max(0, Number(process.env.GEMINI_CODE_WORKER_RETRIES ?? 1));

/**
 * Gap between opening worker tabs. Opening several at the exact same
 * instant makes Gemini's app shell race itself, and it's also the least
 * human-looking access pattern available.
 */
const staggerMs = (): number => Number(process.env.GEMINI_CODE_WORKER_STAGGER_MS ?? 750);

export interface WorkerDeps {
  /** The main tab's driver — used only to open sibling tabs. */
  parent: GeminiDriver;
  /** Context handed to each worker, same as the main session gets. */
  context: PrimerContext;
  /** Model alias to apply in each worker tab (matches the main session). */
  modelAlias?: string;
  log: (msg: string) => void;
  /**
   * Builds the agent session for a worker. Injected to avoid a circular
   * import between loop.ts and this module.
   */
  createSession: (driver: GeminiDriver, context: PrimerContext) => {
    runTask: (task: string, onEvent?: (msg: string) => void) => Promise<string>;
  };
}

/**
 * Runs subtasks in parallel, each in its own Gemini tab.
 *
 * Each worker gets a fresh tab, a fresh thread, the same project context,
 * and the same tools as the main session — minus the ability to delegate
 * further, so a worker can't recursively spawn its own workers.
 */
export async function runParallelTasks(
  tasks: SubTask[],
  deps: WorkerDeps
): Promise<SubTaskResult[]> {
  const { parent, context, modelAlias, log, createSession } = deps;
  const results: SubTaskResult[] = new Array(tasks.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      const tag = c.cyan(`[${task.name}]`);

      // Stagger tab creation so several workers don't open at the same
      // instant (races Gemini's app shell, and hammers the account).
      const gap = staggerMs();
      if (index > 0 && gap > 0) await new Promise((r) => setTimeout(r, gap * Math.min(index, 3)));

      let lastError = "";
      const retries = workerRetries();
      for (let attempt = 0; attempt <= retries; attempt++) {
        let tab: GeminiDriver | undefined;
        try {
          const retryNote = attempt > 0 ? c.yellow(` (retry ${attempt}/${retries})`) : "";
          log(`${tag} ${c.dim("opening tab…")}${retryNote}`);
          tab = await parent.spawnTab(task.name);
          if (modelAlias) await tab.setModelWithFallback(modelAlias).catch(() => undefined);

          const session = createSession(tab, context);
          const answer = await session.runTask(task.prompt, (msg) => log(`${tag} ${msg}`));
          const report =
            answer.length > MAX_WORKER_REPORT_CHARS
              ? answer.slice(0, MAX_WORKER_REPORT_CHARS) +
                `\n\n[report truncated at ${MAX_WORKER_REPORT_CHARS} chars — workers report summaries, not code]`
              : answer;
          results[index] = { name: task.name, ok: true, result: report };
          log(`${tag} ${c.green("done")}`);
          lastError = "";
          break;
        } catch (err) {
          // A worker failing must not sink the others: retry it in a fresh
          // tab, and if it still fails, record that as its result so the
          // orchestrator sees a partial answer instead of nothing.
          lastError = (err as Error).message;
          log(`${tag} ${c.red("failed")} ${c.dim(lastError.split("\n")[0])}`);
          if (attempt < retries) await new Promise((r) => setTimeout(r, 2_000));
        } finally {
          await tab?.close().catch(() => undefined);
        }
      }

      if (lastError) {
        results[index] = {
          name: task.name,
          ok: false,
          result: `Failed after ${retries + 1} attempt(s): ${lastError}`,
        };
      }
    }
  };

  const lanes = Math.min(MAX_PARALLEL_WORKERS, tasks.length);
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

/** Formats worker results into one block for the orchestrator to read. */
export function formatResults(results: SubTaskResult[]): string {
  return results
    .map((r) => `### ${r.name} — ${r.ok ? "OK" : "FAILED"}\n${r.result}`)
    .join("\n\n");
}

/**
 * Builds the delegation tool. It's created per-session rather than living in
 * the static tool list because it needs the live driver to open tabs — and
 * because worker sessions deliberately do NOT get it.
 */
export function createDelegateTool(deps: WorkerDeps): ToolDefinition {
  return {
    name: "delegate_tasks",
    description:
      `delegate_tasks(args: {tasks: [{name: string, prompt: string}]}) -> runs each task in its OWN parallel Gemini tab ` +
      `(up to ${MAX_PARALLEL_WORKERS} at once) and returns all their results together. Use it when a job splits into ` +
      `independent pieces that don't need each other's output — e.g. reviewing several files, or researching several ` +
      `questions. Each worker starts fresh with the same project context and the same tools, but cannot delegate ` +
      `further, so give each one a complete, self-contained prompt. For anything sequential, just use the tools directly.`,
    async run(args) {
      const raw = args.tasks;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, output: "Error: 'tasks' must be a non-empty array of {name, prompt}." };
      }

      const tasks: SubTask[] = [];
      for (const [i, entry] of raw.entries()) {
        const item = entry as Record<string, unknown>;
        const name = String(item?.name ?? `task-${i + 1}`).slice(0, 40);
        const prompt = String(item?.prompt ?? "").trim();
        if (!prompt) return { ok: false, output: `Error: task "${name}" has no prompt.` };
        tasks.push({ name, prompt });
      }

      deps.log(
        c.dim(`  ⎿ delegating ${tasks.length} task${tasks.length > 1 ? "s" : ""} across ` +
          `${Math.min(MAX_PARALLEL_WORKERS, tasks.length)} parallel tab${tasks.length > 1 ? "s" : ""}`)
      );

      const results = await runParallelTasks(tasks, deps);
      const failed = results.filter((r) => !r.ok).length;
      return {
        ok: failed < results.length,
        output: formatResults(results),
      };
    },
  };
}
