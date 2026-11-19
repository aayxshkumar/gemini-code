import type { ToolDefinition } from "../types.js";
import { gateWrite } from "../permissions/gate.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";
import { hasSeen, markWritten } from "./fileState.js";
import { existsSync } from "node:fs";
import { confirmAction, declinedMessage } from "./confirm.js";
import { checkpoints } from "../context/checkpoint.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    `write_file(args: {path: string, content: string}) -> writes a file in full, creating parent dirs. Use this for ` +
    `NEW files. To change an existing file use edit_file instead — rewriting a whole file to alter part of it is ` +
    `slow and silently loses anything you don't reproduce exactly. Path is relative to the project root. ` +
    `An EXISTING file must have been read in this session before it can be overwritten. ` +
    `You will be asked to confirm before each write.`,
  async run(args) {
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    const resolved = resolveInRoot(rel);
    if (!resolved.ok) {
      return { ok: false, output: outsideWorkspace("write") };
    }
    // Overwriting a file the model never looked at is how content gets
    // silently dropped. Existing files must be read first; then prefer edit_file.
    if (existsSync(resolved.abs) && !hasSeen(resolved.abs)) {
      return {
        ok: false,
        output:
          `Error: ${rel} already exists and you haven't read it in this session, so I won't overwrite it blind. ` +
          `read_file it first; then use edit_file for the parts that change, or write_file again if it really ` +
          `must be replaced wholesale.`,
      };
    }
    const abs = resolved.abs;

    const gate = await gateWrite(abs, "Write file?", `${rel} (${content.length} bytes)`);
    if (!gate.run) {
      return { ok: false, output: gate.message || declinedMessage("write this file", "edit") };
    }

    try {
      // Backs up the old bytes first (refusing to write if it can't, since
      // /undo couldn't put them back), writes, and fingerprints the result.
      await checkpoints.writeFile(abs, content);
      await markWritten(abs);
      return { ok: true, output: `Wrote ${content.length} bytes to ${rel}` };
    } catch (err) {
      return { ok: false, output: `Error writing ${rel}: ${(err as Error).message}` };
    }
  },
};
