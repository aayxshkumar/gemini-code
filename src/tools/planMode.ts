import type { ToolDefinition } from "../types.js";
import { confirmAction } from "./confirm.js";

/**
 * What may run in plan mode. An allow-list on purpose: a tool added later is
 * blocked until someone decides it's safe, rather than quietly writing files
 * during what was promised to be a read-only look around.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read_files",
  "file_info",
  "list_files",
  "find_files",
  "search_code",
  "code_outline",
  "find_symbol",
  "notebook_read",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame",
  "check_output",
  "wait_for_output",
  "web_search",
  "fetch_url",
  "read_page",
  "ask_gem",
  "ask_user",
  "use_skill",
  "tool_search",
  "update_plan",
  "enter_plan_mode",
  "exit_plan_mode",
]);

export interface PlanModeState {
  active: boolean;
}

/** Why a tool was held back, in terms the model can act on. */
export function planModeRefusal(tool: string): string {
  return (
    `Plan mode is on, so ${tool} did not run: only read-only tools work until your plan is approved. ` +
    `Finish looking around, then call exit_plan_mode with the plan.`
  );
}

export function createPlanModeTools(state: PlanModeState): ToolDefinition[] {
  return [
    {
      name: "enter_plan_mode",
      deferred: true,
      description:
        `enter_plan_mode() -> switches to read-only mode for a task big or risky enough to agree an approach first. ` +
        `Tools that change anything are refused until the user approves a plan through exit_plan_mode.`,
      async run() {
        state.active = true;
        return { ok: true, output: "Plan mode is on. Investigate with read-only tools, then call exit_plan_mode." };
      },
    },
    {
      name: "exit_plan_mode",
      deferred: true,
      description:
        `exit_plan_mode(args: {plan: string}) -> shows the user your plan, in markdown, for approval. If they approve, ` +
        `plan mode ends and you carry on with it. If they don't, stay in plan mode and rethink.`,
      async run(args) {
        const plan = String(args.plan ?? "").trim();
        if (!plan) return { ok: false, output: "Error: 'plan' is required." };
        if (!(await confirmAction("Approve this plan?", plan))) {
          return { ok: true, output: "The user did not approve the plan. You are still in plan mode." };
        }
        state.active = false;
        return { ok: true, output: "Plan approved. Plan mode is off, so carry it out now." };
      },
    },
  ];
}
