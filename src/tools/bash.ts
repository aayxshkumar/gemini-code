import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { confirmAction } from "./confirm.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";
import { displayPath } from "../workspace.js";

const TMP_DIR = ".gemini-code-tmp";
const IS_WINDOWS = process.platform === "win32";

/**
 * Which shell commands run in.
 *
 * `shell: true` means cmd.exe on Windows, but the model writes bash — the
 * tool is called run_bash, and `ls`, `rm -rf`, `grep` or `export X=1` all
 * fail under cmd. Git for Windows ships a real bash, and most developers on
 * Windows who'd use this have it, so prefer that. GEMINI_CODE_SHELL
 * overrides (e.g. "powershell.exe" or "cmd.exe").
 */
export function resolveShell(): string | true {
  if (process.env.GEMINI_CODE_SHELL) return process.env.GEMINI_CODE_SHELL;
  if (!IS_WINDOWS) return true; // /bin/sh — fine everywhere else

  const candidates = [
    `${process.env["ProgramFiles"] ?? "C:\\Program Files"}\\Git\\bin\\bash.exe`,
    `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Git\\bin\\bash.exe`,
    `${process.env["LOCALAPPDATA"] ?? ""}\\Programs\\Git\\bin\\bash.exe`,
  ];
  const found = candidates.find((p) => p && existsSync(p));
  return found ?? true; // no Git Bash: fall back to cmd.exe
}

const SHELL = resolveShell();
const SHELL_NAME =
  SHELL === true ? (IS_WINDOWS ? "cmd.exe" : "sh") : (SHELL.split(/[\\/]/).pop() ?? SHELL);

/**
 * spawn options that behave the same on every platform.
 *
 * `detached` is what lets us kill a whole process group on Unix — but on
 * Windows it gives the child ITS OWN CONSOLE WINDOW, so the command runs in
 * a separate cmd window and its output never reaches us. Windows kills the
 * tree with taskkill instead (see killGroup), so it doesn't need it.
 */
function spawnOptions(extra: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(),
    shell: SHELL,
    detached: !IS_WINDOWS,
    windowsHide: true,
    ...extra,
  };
}
const FOREGROUND_TIMEOUT_MS = Number(process.env.GEMINI_CODE_BASH_TIMEOUT_MS ?? 60_000);
const MAX_OUTPUT_CHARS = 20_000;

export interface BackgroundProcess {
  id: string;
  command: string;
  pid: number;
  logPath: string;
  startedAt: number;
  exitCode: number | null;
  background: boolean;
}

/**
 * Every command we've run, background or not, keyed by id.
 *
 * Foreground commands are logged too. A failing build can emit thousands of
 * lines with the actual error in the middle, so returning a tail throws away
 * the part that mattered — keeping the full log on disk means it can be
 * searched afterwards instead of re-run.
 */
export const backgroundProcesses = new Map<string, BackgroundProcess>();

/**
 * Splits output into lines, ignoring the single trailing newline almost every
 * command ends with — otherwise `seq 1 40` gets reported as 40 lines of output
 * plus a phantom 41st empty one.
 */
function toLines(content: string): string[] {
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}

/** Lines worth surfacing from a failed command, wherever they appear in it. */
const ERROR_LINE = /\b(error|ERR!|failed|failure|exception|cannot find|not found|undefined reference|panic|traceback|fatal|refused)\b|^\s*✗|^\s*×/i;

function summarizeLog(
  content: string,
  exitCode: number | null,
  tailLines = 25
): { text: string; omitted: number; clippedChars: number } {
  const lines = toLines(content);
  let tail = lines.slice(-tailLines).join("\n").trim();
  const omitted = Math.max(0, lines.length - tailLines);

  // Counting lines alone misses the other way output gets big: one enormous
  // line (minified bundles, JSON dumps, progress bars redrawn with \r). A
  // 300 KB single line went to the model whole, with no note that anything
  // was off. Keep the END of it, like the tail, and report the clip.
  let clippedChars = 0;
  if (tail.length > MAX_OUTPUT_CHARS) {
    clippedChars = tail.length - MAX_OUTPUT_CHARS;
    tail = tail.slice(-MAX_OUTPUT_CHARS);
  }

  // On failure, hunt out the error lines wherever they are — a 3000-line
  // build usually fails somewhere in the middle, and the tail is just the
  // summary footer.
  if (exitCode !== 0 && lines.length > tailLines) {
    const errors = lines
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => ERROR_LINE.test(l))
      .slice(0, 30)
      .map(([n, l]) => `  line ${n}: ${l.trim().slice(0, 200)}`);
    if (errors.length) {
      return {
        text: `Error lines found in the output:\n${errors.join("\n")}\n\nLast ${tailLines} lines:\n${tail}`,
        omitted,
        clippedChars,
      };
    }
  }
  return { text: tail, omitted, clippedChars };
}

/**
 * Commands that never return on their own.
 *
 * Running one in the foreground is the single worst thing this tool can do:
 * it blocks the agent until the timeout, produces endlessly-growing output,
 * then kills the server anyway — so the model waits a minute to learn
 * nothing. These get moved to the background automatically.
 */
const LONG_RUNNING = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/,
  /\bnext\s+dev\b/,
  /\bvite\b(?!.*\bbuild\b)/,
  /\bnodemon\b/,
  /\bwebpack\s+(serve|--watch)\b/,
  /\buvicorn\b/,
  /\bgunicorn\b/,
  /\bflask\s+run\b/,
  /\bpython3?\s+-m\s+http\.server\b/,
  /\brails\s+s(erver)?\b/,
  /\bdocker\s+compose\s+up\b(?!.*-d)/,
  /\btail\s+-f\b/,
  /--watch\b/,
];

export function looksLongRunning(command: string): boolean {
  return LONG_RUNNING.some((re) => re.test(command));
}

function tmpDir(): string {
  const dir = path.resolve(process.cwd(), TMP_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function tail(text: string, chars = MAX_OUTPUT_CHARS): string {
  return text.length > chars ? `[...truncated...]\n${text.slice(-chars)}` : text;
}

/**
 * Kills a whole process GROUP, not just the process.
 *
 * `npm run dev` is a shell that spawns npm that spawns node; killing the
 * shell alone orphans the server, which then holds its port forever and
 * leaks across runs. Spawning detached gives each command its own group so
 * a negative PID takes the entire tree down.
 */
function killGroup(pid: number): void {
  if (IS_WINDOWS) {
    // No process groups: taskkill /T walks the tree (npm -> node), /F forces.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 3_000).unref();
}

function runForeground(command: string, cwd = process.cwd()): Promise<{ ok: boolean; output: string }> {
  const id = `fg_${Date.now().toString(36)}`;
  const logPath = path.join(tmpDir(), `${id}.log`);

  return new Promise((resolve) => {
    // Intentionally shell-based: the point of this tool is running real
    // command lines, pipes and redirects included, exactly like Claude
    // Code's Bash tool. The control is the confirm() gate, not arg escaping.
    const child = spawn(command, spawnOptions({ cwd }));
    let out = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      if (child.pid) killGroup(child.pid);
    }, FOREGROUND_TIMEOUT_MS);

    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Failed to start: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      // Always keep the full output, however long — the model can search it
      // with check_output instead of losing the middle of a big build.
      try {
        writeFileSync(logPath, out, "utf8");
        backgroundProcesses.set(id, {
          id,
          command,
          pid: child.pid ?? -1,
          logPath,
          startedAt: Date.now(),
          exitCode: code,
          background: false,
        });
      } catch {
        /* logging must never fail the command it's logging */
      }

      const lineCount = toLines(out).length;
      const summary = summarizeLog(out, killed ? 1 : code);

      // The id is always reported, not just for huge output: any command's
      // log may be worth grepping later, and re-running it to look again is
      // slower and can have side effects.
      //
      // Whenever lines were dropped, SAY SO. Showing a bare tail as if it
      // were the whole result is the same failure this logging exists to
      // fix, just smaller: `seq 1 40` came back starting at "17" with
      // nothing marking the 16 missing lines, so the model read a partial
      // result as a complete one.
      const dropped = [
        summary.omitted ? `${summary.omitted} earlier line(s)` : "",
        summary.clippedChars ? `${summary.clippedChars} characters of an over-long line` : "",
      ].filter(Boolean);
      const pointer = dropped.length
        ? `\n\n[${dropped.join(" and ")} not shown — ${lineCount} lines total, saved as "${id}". ` +
          `Read them with check_output {"id": "${id}", "grep": "error"} rather than re-running]`
        : `\n[saved as "${id}"]`;

      if (killed) {
        resolve({
          ok: false,
          output:
            `Command timed out after ${FOREGROUND_TIMEOUT_MS / 1000}s and was killed.\n` +
            `If this is a server or watcher that doesn't exit on its own, re-run it with ` +
            `"background": true — then use check_output to read its logs.\n\n` +
            `Partial output:\n${summary.text}${pointer}`,
        });
      } else {
        resolve({
          ok: code === 0,
          output:
            (code === 0 ? "" : `Exit code ${code}\n`) +
            (summary.text || "(no output)") +
            pointer,
        });
      }
    });
  });
}

function runBackground(command: string, cwd = process.cwd()): { ok: boolean; output: string } {
  const id = `bg_${Date.now().toString(36)}`;
  const logPath = path.join(tmpDir(), `${id}.log`);
  const fd = openSync(logPath, "a");

  const child = spawn(command, spawnOptions({ stdio: ["ignore", fd, fd], cwd }));
  child.unref();
  closeSync(fd);

  if (!child.pid) return { ok: false, output: "Failed to start the background process." };

  const record: BackgroundProcess = {
    id,
    command,
    pid: child.pid,
    logPath,
    startedAt: Date.now(),
    exitCode: null,
    background: true,
  };
  backgroundProcesses.set(id, record);
  child.on("exit", (code) => {
    record.exitCode = code;
  });

  return {
    ok: true,
    output:
      `Started in the background as "${id}" (pid ${child.pid}).\n` +
      `It keeps running while you continue. Use check_output with id "${id}" to read its output ` +
      `(give it a second or two to produce any), and kill_process to stop it.`,
  };
}

export const bashTool: ToolDefinition = {
  name: "run_bash",
  description:
    `run_bash(args: {command: string, cwd?: string, background?: boolean}) -> runs a shell command in the project root ` +
    `('cwd' runs it in a subdirectory or another workspace root instead, e.g. "../shared-lib") ` +
    `(shell: ${SHELL_NAME} on ${process.platform}). ` +
    `Returns its output, or times out after ${FOREGROUND_TIMEOUT_MS / 1000}s. ` +
    `Set background: true for anything that does NOT exit on its own — dev servers, watchers, tails — ` +
    `and it returns an id immediately instead of blocking; read its logs with check_output. ` +
    `Commands that obviously never exit (npm run dev, vite, uvicorn, …) are backgrounded automatically. ` +
    `The user confirms before each command runs.`,
  async run(args) {
    const command = String(args.command ?? "").trim();
    if (!command) return { ok: false, output: "Error: 'command' is required." };

    const wantsBackground = Boolean(args.background) || looksLongRunning(command);
    const cwdArg = String(args.cwd ?? "").trim();
    const cwdResolved = resolveInRoot(cwdArg || ".");
    if (!cwdResolved.ok) return { ok: false, output: outsideWorkspace("run a command in") };
    const cwd = cwdResolved.abs;
    if (!existsSync(cwd)) return { ok: false, output: `Error: cwd ${cwdArg} does not exist.` };
    const inDir = displayPath(cwd) === "." ? "" : `  (in ${displayPath(cwd)})`;

    const approved = await confirmAction(
      wantsBackground ? "Run shell command (in background)?" : "Run shell command?",
      command + inDir,
      "command"
    );
    if (!approved) return { ok: false, output: "User declined to run this command." };

    if (wantsBackground) {
      const result = runBackground(command, cwd);
      if (result.ok && !args.background) {
        result.output =
          `This looks like a long-running process, so it was started in the background ` +
          `rather than blocking.\n${result.output}`;
      }
      return result;
    }

    return runForeground(command, cwd);
  },
};

export const checkOutputTool: ToolDefinition = {
  name: "check_output",
  description:
    `check_output(args: {id?: string, grep?: string, context?: number, lines?: number, head?: boolean}) -> reads the ` +
    `saved output of a command run by run_bash — background OR finished foreground ones. Omit 'id' to list what's ` +
    `available. 'grep' is a regular expression: use it to find the actual error in a long build instead of paging ` +
    `through it ("error", "FAIL", "cannot find"), with 'context' lines either side. 'lines' limits how much comes ` +
    `back (tail by default, or the start with head: true). Prefer grep over dumping a whole log.`,
  async run(args) {
    const id = args.id ? String(args.id) : undefined;

    if (!id) {
      if (backgroundProcesses.size === 0) return { ok: true, output: "No command output saved yet." };
      const list = [...backgroundProcesses.values()]
        .map((p) => {
          const state =
            p.exitCode === null
              ? `running ${Math.round((Date.now() - p.startedAt) / 1000)}s`
              : `exited ${p.exitCode}`;
          return `- ${p.id} (${p.background ? "background" : "foreground"}, ${state}): ${p.command}`;
        })
        .join("\n");
      return { ok: true, output: list };
    }

    const proc = backgroundProcesses.get(id);
    if (!proc) {
      return {
        ok: false,
        output: `No saved output for "${id}". Known: ${[...backgroundProcesses.keys()].join(", ") || "(none)"}`,
      };
    }

    let content = "";
    try {
      content = readFileSync(proc.logPath, "utf8");
    } catch {
      content = "";
    }

    const status = proc.exitCode === null ? "running" : `exited with code ${proc.exitCode}`;
    const header = `${proc.id} (${status}): ${proc.command}`;
    const allLines = toLines(content);

    // Searching beats paging: a failing build is thousands of lines and the
    // model only needs the handful that explain why.
    if (args.grep) {
      let re: RegExp;
      try {
        re = new RegExp(String(args.grep), "i");
      } catch (err) {
        return { ok: false, output: `Invalid 'grep' regular expression: ${(err as Error).message}` };
      }
      const ctx = Math.min(Math.max(Number(args.context) || 0, 0), 10);
      const hits: string[] = [];
      let shown = 0;
      for (let i = 0; i < allLines.length && shown < 100; i++) {
        if (!re.test(allLines[i])) continue;
        shown++;
        const from = Math.max(0, i - ctx);
        const to = Math.min(allLines.length - 1, i + ctx);
        const block = allLines
          .slice(from, to + 1)
          .map((l, j) => `${String(from + j + 1).padStart(6)}${from + j === i ? " >" : "  "} ${l}`)
          .join("\n");
        hits.push(block);
      }
      if (hits.length === 0) {
        return {
          ok: true,
          output: `${header}\n\nNo lines matching /${args.grep}/ in ${allLines.length} lines of output.`,
        };
      }
      return {
        ok: true,
        output:
          `${header}\n\n${shown} matching line(s) for /${args.grep}/ ` +
          `(of ${allLines.length} total):\n\n${hits.join("\n  --\n")}`,
      };
    }

    const limit = Number(args.lines);
    let slice = content;
    if (Number.isFinite(limit) && limit > 0) {
      slice = args.head
        ? allLines.slice(0, limit).join("\n")
        : allLines.slice(-limit).join("\n");
    }

    const truncated = slice.length > MAX_OUTPUT_CHARS;
    const body = truncated ? tail(slice) : slice;
    const hint =
      allLines.length > 200
        ? `\n\n[${allLines.length} lines total — narrow it with grep, e.g. {"id": "${id}", "grep": "error", "context": 2}]`
        : "";

    return { ok: true, output: `${header}\n\n${body || "(no output yet)"}${hint}` };
  },
};

export const killProcessTool: ToolDefinition = {
  name: "kill_process",
  description:
    `kill_process(args: {id: string}) -> stops a background process started by run_bash, including any ` +
    `child processes it spawned. Do this when you're finished with a dev server you started.`,
  async run(args) {
    const id = String(args.id ?? "");
    const proc = backgroundProcesses.get(id);
    if (!proc) return { ok: false, output: `No background process "${id}".` };
    if (proc.exitCode !== null) return { ok: true, output: `"${id}" had already exited.` };

    killGroup(proc.pid);
    proc.exitCode = proc.exitCode ?? -1;
    return { ok: true, output: `Stopped "${id}" (pid ${proc.pid}) and its children.` };
  },
};

/** Stops everything we launched — called when the CLI exits so nothing is orphaned. */
export function killAllBackgroundProcesses(): void {
  for (const proc of backgroundProcesses.values()) {
    if (proc.exitCode === null) killGroup(proc.pid);
  }
}
