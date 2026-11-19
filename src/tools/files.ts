import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot } from "./paths.js";
import { confirmAction } from "./confirm.js";
import { markRead } from "./fileState.js";
import { checkpoints } from "../context/checkpoint.js";
import { globToRegExp, walkProject } from "./searchCode.js";

const MAX_READ_FILES = 20;
const MAX_CHARS_PER_FILE = 12_000;
const MAX_FOUND_FILES = 200;

function exists(abs: string): Promise<boolean> {
  return stat(abs).then(
    () => true,
    () => false
  );
}

export const findFilesTool: ToolDefinition = {
  name: "find_files",
  description:
    `find_files(args: {pattern: string, maxResults?: number}) -> finds files by name, most recently changed first. ` +
    `'pattern' is a glob: "*.ts" matches filenames anywhere, "src/**/*.test.ts" matches paths. Use this to locate ` +
    `files, and search_code to look inside them. Build/noise directories are skipped.`,
  async run(args) {
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return { ok: false, output: "Error: 'pattern' is required." };

    const root = process.cwd();
    const glob = globToRegExp(pattern);
    const onPath = pattern.includes("/");
    const found: { file: string; changed: number }[] = [];
    for await (const { full, name } of walkProject(root)) {
      const file = path.relative(root, full).split(path.sep).join("/");
      if (!glob.test(onPath ? file : name)) continue;
      found.push({ file, changed: await stat(full).then((s) => s.mtimeMs, () => 0) });
    }

    if (!found.length) return { ok: true, output: `No files match "${pattern}".` };
    const limit = Math.min(Number(args.maxResults) || MAX_FOUND_FILES, MAX_FOUND_FILES);
    const shown = found.sort((a, b) => b.changed - a.changed).slice(0, limit);
    const more = found.length - shown.length;
    return {
      ok: true,
      output: `${shown.map((f) => f.file).join("\n")}${more ? `\n\n[${more} more not shown — narrow the pattern]` : ""}`,
    };
  },
};

export const readFilesTool: ToolDefinition = {
  name: "read_files",
  description:
    `read_files(args: {paths: string[]}) -> reads up to ${MAX_READ_FILES} whole files in one call, each headed by ` +
    `its path. Use it instead of several read_file calls, since each call is a full turn. Long files are cut at ` +
    `${MAX_CHARS_PER_FILE} characters, and read_file gets the rest.`,
  async run(args) {
    if (!Array.isArray(args.paths) || args.paths.length === 0) {
      return { ok: false, output: "Error: 'paths' must be a non-empty array." };
    }
    if (args.paths.length > MAX_READ_FILES) {
      return { ok: false, output: `Error: at most ${MAX_READ_FILES} files in one call.` };
    }
    const parts: string[] = [];
    for (const raw of args.paths) {
      const rel = String(raw);
      const resolved = resolveInRoot(rel);
      if (!resolved.ok) {
        parts.push(`=== ${rel} ===\nError: path escapes the project root, refusing to read it.`);
        continue;
      }
      try {
        const content = await readFile(resolved.abs, "utf8");
        const cut = content.length > MAX_CHARS_PER_FILE;
        // Counts as a read for edit_file's read-before-edit gate.
        await markRead(resolved.abs, !cut);
        parts.push(
          `=== ${rel} ===\n${content.slice(0, MAX_CHARS_PER_FILE)}` +
            (cut ? `\n[cut at ${MAX_CHARS_PER_FILE} of ${content.length} characters — read_file for the rest]` : "")
        );
      } catch (err) {
        parts.push(`=== ${rel} ===\nError reading it: ${(err as Error).message}`);
      }
    }
    return { ok: true, output: parts.join("\n\n") };
  },
};

export const fileInfoTool: ToolDefinition = {
  name: "file_info",
  description:
    `file_info(args: {path: string}) -> whether a path exists, and its type, size, line count and last change. ` +
    `Cheaper than reading a file to find out how big it is.`,
  async run(args) {
    const rel = String(args.path ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    const resolved = resolveInRoot(rel);
    if (!resolved.ok) return { ok: false, output: "Error: path escapes the project root." };

    const info = await stat(resolved.abs).catch(() => undefined);
    if (!info) return { ok: true, output: `${rel} does not exist.` };
    const changed = info.mtime.toISOString();
    if (info.isDirectory()) return { ok: true, output: `${rel}: directory, last changed ${changed}` };
    const text = await readFile(resolved.abs, "utf8").catch(() => undefined);
    const lines = text === undefined ? "" : `, ${text.split("\n").length} lines`;
    return { ok: true, output: `${rel}: file, ${info.size} bytes${lines}, last changed ${changed}` };
  },
};

/** Shared by move and copy, which differ only in what happens to the source. */
async function transfer(args: Record<string, unknown>, verb: "Move" | "Copy") {
  const from = String(args.from ?? "");
  const to = String(args.to ?? "");
  if (!from || !to) return { ok: false, output: "Error: 'from' and 'to' are required." };

  const source = resolveInRoot(from);
  const target = resolveInRoot(to);
  if (!source.ok || !target.ok) return { ok: false, output: "Error: path escapes the project root, refusing." };

  const info = await stat(source.abs).catch(() => undefined);
  if (!info) return { ok: false, output: `Error: ${from} does not exist.` };
  // /undo works file by file, so a directory couldn't be put back.
  if (!info.isFile()) return { ok: false, output: `Error: ${from} isn't a file. Use run_bash for directories.` };
  if ((await exists(target.abs)) && !args.overwrite) {
    return { ok: false, output: `Error: ${to} already exists. Set overwrite: true to replace it.` };
  }

  if (!(await confirmAction(`${verb} file?`, `${from} -> ${to}`, "edit"))) {
    return { ok: false, output: `User declined to ${verb.toLowerCase()} this file.` };
  }
  try {
    for (const abs of verb === "Move" ? [target.abs, source.abs] : [target.abs]) {
      const backup = await checkpoints.recordBeforeWrite(abs);
      if (!backup.ok) return { ok: false, output: `Not done: ${backup.error} (so /undo couldn't have put it back).` };
    }
    await mkdir(path.dirname(target.abs), { recursive: true });
    if (verb === "Move") await rename(source.abs, target.abs);
    else await copyFile(source.abs, target.abs);
    await checkpoints.recordAfterWrite(target.abs);
    if (verb === "Move") await checkpoints.recordAfterWrite(source.abs);
    return { ok: true, output: `${verb === "Move" ? "Moved" : "Copied"} ${from} to ${to}.` };
  } catch (err) {
    return { ok: false, output: `Error: ${(err as Error).message}` };
  }
}

export const moveFileTool: ToolDefinition = {
  name: "move_file",
  description:
    `move_file(args: {from: string, to: string, overwrite?: boolean}) -> moves or renames a file, creating parent ` +
    `directories. Refuses to replace an existing file unless overwrite is set. The user confirms it, and /undo restores it.`,
  run: (args) => transfer(args, "Move"),
};

export const copyFileTool: ToolDefinition = {
  name: "copy_file",
  description:
    `copy_file(args: {from: string, to: string, overwrite?: boolean}) -> copies a file, creating parent directories. ` +
    `Refuses to replace an existing file unless overwrite is set. The user confirms it, and /undo removes the copy.`,
  run: (args) => transfer(args, "Copy"),
};

export const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description:
    `delete_file(args: {path: string}) -> deletes one file. Not directories. The user confirms it, and /undo restores it.`,
  async run(args) {
    const rel = String(args.path ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    const resolved = resolveInRoot(rel);
    if (!resolved.ok) return { ok: false, output: "Error: path escapes the project root, refusing to delete it." };

    const info = await stat(resolved.abs).catch(() => undefined);
    if (!info) return { ok: false, output: `Error: ${rel} does not exist.` };
    if (!info.isFile()) return { ok: false, output: `Error: ${rel} isn't a file. Use run_bash for directories.` };

    if (!(await confirmAction("Delete file?", rel, "edit"))) {
      return { ok: false, output: "User declined to delete this file." };
    }
    try {
      const backup = await checkpoints.recordBeforeWrite(resolved.abs);
      if (!backup.ok) return { ok: false, output: `Not deleted: ${backup.error} (so /undo couldn't have put it back).` };
      await rm(resolved.abs);
      await checkpoints.recordAfterWrite(resolved.abs);
      return { ok: true, output: `Deleted ${rel}.` };
    } catch (err) {
      return { ok: false, output: `Error deleting ${rel}: ${(err as Error).message}` };
    }
  },
};
