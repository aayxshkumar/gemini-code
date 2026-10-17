import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";
import { listFiles } from "./fileIndex.js";
import { displayPath } from "../workspace.js";

/**
 * Glob over the workspace — Claude Code's Glob, OpenCode's glob. In a big
 * repository the model's first problem is finding the right file at all,
 * and list_files (a tree) is capped long before it gets there.
 */
export const findFilesTool: ToolDefinition = {
  name: "find_files",
  description:
    `find_files(args: {glob: string, path?: string, maxResults?: number}) -> paths matching a glob, e.g. ` +
    `"**/*.test.ts", "src/**/user*.py", "*.csproj". 'path' limits it to a directory or another workspace root ` +
    `("../shared-lib"). Use this to LOCATE files in a large codebase instead of guessing paths or walking the ` +
    `tree with list_files; ignored/generated files are skipped.`,
  async run(args) {
    let glob = String(args.glob ?? args.pattern ?? "").trim().replace(/^\.?\//, "");
    let scope = String(args.path ?? args.dir ?? ".").trim() || ".";
    // A directory handed in as the glob means "everything under it".
    if (glob && !/[*?{]/.test(glob)) {
      const asDir = resolveInRoot(path.posix.join(scope, glob));
      if (asDir.ok && existsSync(asDir.abs) && statSync(asDir.abs).isDirectory()) {
        scope = path.posix.join(scope, glob);
        glob = "**/*";
      }
    }
    if (!glob) glob = "**/*";
    const resolved = resolveInRoot(scope);
    if (!resolved.ok) return { ok: false, output: outsideWorkspace("search") };
    const max = Math.min(Math.max(Number(args.maxResults) || 200, 1), 1000);
    const { files, truncated } = await listFiles(resolved.abs, { glob, max });
    const prefix = displayPath(resolved.abs) === "." ? "" : `${displayPath(resolved.abs)}/`;
    if (files.length === 0) {
      return { ok: true, output: `No files match ${glob} under ${prefix || "the project"}. Try "**/${glob.replace(/^\*\*\//, "")}" or a different root with 'path'.` };
    }
    return {
      ok: true,
      output: files.map((f) => prefix + f).join("\n") + (truncated ? `\n\n[more than ${max} matches — narrow the glob]` : `\n\n[${files.length} file${files.length === 1 ? "" : "s"}]`),
    };
  },
};
