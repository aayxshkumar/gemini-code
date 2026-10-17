/**
 * Tiny ANSI helper — no dependency, and honours NO_COLOR / non-TTY output
 * so piped logs stay clean.
 */
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `[${open}m${s}[${close}m` : s;

/**
 * The legacy Windows console (conhost with an OEM code page) mangles the
 * Unicode glyphs this UI uses; Windows Terminal, VS Code's terminal and
 * every Unix terminal render them fine. Pick plain ASCII when it looks
 * like the legacy console. GEMINI_CODE_ASCII=1 forces it anywhere.
 */
const legacyWindowsConsole =
  process.platform === "win32" && !process.env.WT_SESSION && !process.env.TERM_PROGRAM && !process.env.ConEmuANSI;
export const ASCII = process.env.GEMINI_CODE_ASCII === "1" || legacyWindowsConsole;
export const glyph = {
  bullet: ASCII ? "*" : "⏺",
  branch: ASCII ? "  |-" : "  ⎿ ",
  star: ASCII ? "*" : "✻",
  ok: ASCII ? "+" : "✓",
  bad: ASCII ? "x" : "✗",
  warn: ASCII ? "!" : "!",
  prompt: ASCII ? "> " : "› ",
  resume: ASCII ? "~" : "⟳",
};

export const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Claude Code-style tool-call line: ⏺ read_file(package.json) */
export function toolCallLine(name: string, args: Record<string, unknown>): string {
  const summary = summarizeArgs(args);
  return `${c.green(glyph.bullet)} ${c.bold(name)}${c.dim("(")}${summary}${c.dim(")")}`;
}

/** Claude Code-style result line, indented under the call: ⎿ 42 lines */
export function toolResultLine(ok: boolean, output: string): string {
  const marker = c.dim(glyph.branch);
  if (!ok) return `${marker}${c.red(firstLine(output, 120))}`;
  return `${marker}${c.dim(describeOutput(output))}`;
}

export function noteLine(text: string): string {
  return `${c.dim(glyph.branch)}${c.dim(text)}`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";

  // Show the most identifying value bare (path/command/url), like Claude Code does.
  const primary = args.path ?? args.command ?? args.url ?? args.note;
  if (typeof primary === "string") {
    return c.cyan(truncate(primary.replace(/\n/g, " "), 60));
  }

  // Arrays of task objects (delegate_tasks) — name them instead of letting
  // String() render them as "[object Object]".
  if (Array.isArray(args.tasks)) {
    const names = args.tasks.map((t) =>
      typeof t === "object" && t !== null && "name" in t ? String((t as { name: unknown }).name) : "task"
    );
    return c.cyan(truncate(`${names.length} tasks: ${names.join(", ")}`, 70));
  }

  return c.cyan(
    truncate(
      entries
        .map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
        .join(", "),
      60
    )
  );
}

function describeOutput(output: string): string {
  const lines = output.split("\n").length;
  const bytes = Buffer.byteLength(output, "utf8");
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  return lines > 1 ? `${lines} lines (${size})` : truncate(output.trim(), 100) || size;
}

function firstLine(s: string, n: number): string {
  return truncate(s.split("\n")[0], n);
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
