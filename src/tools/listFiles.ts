import type { ToolDefinition } from "../types.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";
import { buildProjectTree } from "../context/projectTree.js";

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description: `list_files(args: {path?: string}) -> an ASCII tree of the project (or of a subdirectory). Use this instead of running \`ls\` via run_bash. Noise dirs (node_modules, .git, dist, venv, …) are excluded automatically.`,
  async run(args) {
    const rel = String(args.path ?? ".");
    const resolved = resolveInRoot(rel);
    if (!resolved.ok) {
      return { ok: false, output: outsideWorkspace("list") };
    }
    const abs = resolved.abs;
    try {
      const tree = await buildProjectTree({ root: abs });
      return { ok: true, output: tree };
    } catch (err) {
      return { ok: false, output: `Error listing ${rel}: ${(err as Error).message}` };
    }
  },
};
