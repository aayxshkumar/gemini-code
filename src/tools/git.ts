import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";

const run = promisify(execFile);

const MAX_DIFF_CHARS = 15_000;

/**
 * Read-only git, so no confirmation gate.
 *
 * Deliberately execFile with an argument array rather than a shell string:
 * unlike run_bash (whose whole purpose is arbitrary command lines, gated by
 * confirmation), these take model-supplied paths, and there's no reason to
 * let one of them turn into shell syntax.
 */
async function git(args: string[], cwd = process.cwd()): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    return { ok: true, out: stdout };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: e.stderr || e.stdout || e.message };
  }
}

function truncate(text: string): string {
  return text.length > MAX_DIFF_CHARS
    ? `${text.slice(0, MAX_DIFF_CHARS)}\n\n[truncated at ${MAX_DIFF_CHARS} characters — narrow it with 'path']`
    : text;
}

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description:
    `git_status(args: {cwd?: string}) -> what's changed in the working tree: modified, added, deleted and untracked files, plus the ` +
    `current branch. Use it to see the shape of your own changes before reviewing them in detail. 'cwd' picks another ` +
    `workspace root's repository ("../shared-lib").`,
  async run(args) {
    const scope = resolveInRoot(String(args?.cwd ?? ".").trim() || ".");
    if (!scope.ok) return { ok: false, output: outsideWorkspace("inspect") };
    const cwd = scope.abs;
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (!branch.ok && /not a git repository/i.test(branch.out)) {
      return { ok: false, output: "Not a git repository." };
    }
    const status = await git(["status", "--porcelain=v1"], cwd);
    if (!status.ok) return { ok: false, output: `git status failed: ${status.out.trim()}` };

    const lines = status.out.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      return { ok: true, output: `On branch ${branch.out.trim()} — working tree clean.` };
    }
    return {
      ok: true,
      output: `On branch ${branch.out.trim()}, ${lines.length} changed file(s):\n${lines.join("\n")}`,
    };
  },
};

export const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description:
    `git_diff(args: {path?: string, cwd?: string, staged?: boolean, stat?: boolean}) -> the diff of your changes. Use it to ` +
    `review what you actually changed before declaring a task done — far cheaper and more reliable than re-reading ` +
    `whole files. 'stat' gives just the summary of files and line counts, 'path' limits it to one file or directory, ` +
    `'cwd' picks another workspace root's repository.`,
  async run(args) {
    const scope = resolveInRoot(String(args.cwd ?? ".").trim() || ".");
    if (!scope.ok) return { ok: false, output: outsideWorkspace("inspect") };
    const cwd = scope.abs;
    const argv = ["diff"];
    if (args.staged) argv.push("--staged");
    if (args.stat) argv.push("--stat");
    const p = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    if (p) argv.push("--", p);

    const result = await git(argv, cwd);
    if (!result.ok) {
      if (/not a git repository/i.test(result.out)) return { ok: false, output: "Not a git repository." };
      return { ok: false, output: `git diff failed: ${result.out.trim()}` };
    }

    const out = result.out.trim();
    if (!out) {
      // Untracked files don't show in a diff, and "no changes" would be
      // misleading when the agent has just created files.
      const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
      const list = untracked.out.trim();
      if (list) {
        return {
          ok: true,
          output: `No diff in tracked files, but these are new and untracked:\n${list}`,
        };
      }
      return { ok: true, output: "No changes." };
    }
    return { ok: true, output: truncate(out) };
  },
};
