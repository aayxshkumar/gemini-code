import type { GeminiDriver } from "../driver/GeminiDriver.js";
import type { PlanJournal } from "../context/plan.js";
import type { ToolDefinition } from "../types.js";
import type { PrimerContext } from "./promptTemplate.js";
import { AgentSession } from "./loop.js";
import { createDelegateTool } from "./workers.js";
import { createUpdatePlanTool } from "../tools/updatePlan.js";
import { createScreenshotTool } from "../tools/screenshot.js";
import { createBrowsePageTool } from "../tools/browsePage.js";
import { createBrowserTools } from "../tools/browser.js";
import { deferTool } from "../tools/toolSearch.js";

export interface MainSessionOptions {
  driver: GeminiDriver;
  context: PrimerContext;
  journal: PlanJournal;
  /** Read each time workers start, so they follow a model change mid-session. */
  modelAlias: () => string;
  /** ask_gem, when a Gem is in use as reference. */
  gemTool?: ToolDefinition;
  /** Read per session, since servers connect after the first one is made. */
  mcpTools?: () => ToolDefinition[];
  orchestrator: boolean;
  log: (msg: string) => void;
}

/** Each of these describes itself at length, and most tasks never browse. */
function browsingTools(driver: GeminiDriver): ToolDefinition[] {
  return [createScreenshotTool(driver), createBrowsePageTool(driver), ...createBrowserTools(driver)].map(deferTool);
}

/**
 * The main tab's session, shared by the terminal REPL and the desktop bridge.
 *
 * The main tab can delegate subtasks to parallel worker tabs. Workers get the
 * same context and tools but NOT the delegate tool, so delegation can't nest.
 */
export function createMainSession(opts: MainSessionOptions): AgentSession {
  const { driver, context, journal, gemTool } = opts;
  const { resumePlan: _resumePlan, ...workerContext } = context;

  const delegate = createDelegateTool({
    parent: driver,
    context: workerContext,
    get modelAlias() {
      return opts.modelAlias();
    },
    log: opts.log,
    createSession: (workerDriver, workerContext) =>
      // Workers: no delegate tool (no nesting), no journal (the main
      // thread owns the plan), and the "worker" role so they report back
      // a short summary instead of pasting code into the orchestrator.
      new AgentSession(
        workerDriver,
        workerContext,
        [
          ...browsingTools(workerDriver),
          // Workers share the ONE Gem tab (questions are queued inside the
          // tool): they need the project's conventions more than the
          // planning tab does.
          ...(gemTool ? [gemTool] : []),
          ...(opts.mcpTools?.() ?? []),
        ],
        undefined,
        "worker"
      ),
  });

  return new AgentSession(
    driver,
    context,
    [
      delegate,
      createUpdatePlanTool(journal),
      ...browsingTools(driver),
      ...(gemTool ? [gemTool] : []),
      ...(opts.mcpTools?.() ?? []),
    ],
    journal,
    opts.orchestrator ? "orchestrator" : "solo"
  );
}
