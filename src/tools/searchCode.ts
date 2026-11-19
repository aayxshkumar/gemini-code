import { readFile, stat } from "node:fs/promises";
import { walkProject } from "../walk.js";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot, outsideWorkspace } from "./paths.js";
import { grep } from "./fileIndex.js";
import { displayPath } from "../workspace.js";

/** Skip anything that isn't text — a match inside a binary is noise. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|mp4|mov|mp3|wav|woff2?|ttf|eot|so|dylib|exe|bin|lock)$/i;

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 2_000_000;

export interface SearchHit {
  file: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one segment, `{a,b}` alternates. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, "");
  let re = "";
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // "**/" matches zero or more directories.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      braces++;
      re += "(?:";
    } else if (ch === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (ch === "," && braces > 0) re += "|";
    else re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}

/** The shared walk (gitignore-aware); re-exported for files.ts. */
export { walkProject };

export async function searchCode(opts: {
  pattern: string;
  root?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
  /** Lines to show either side of a match. */
  context?: number;
}): Promise<{ hits: SearchHit[]; filesScanned: number; truncated: boolean }> {
  const root = opts.root ?? process.cwd();
  const max = Math.min(opts.maxResults ?? 100, MAX_RESULTS);
  const re = new RegExp(opts.pattern, opts.caseSensitive ? "" : "i");
  const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;
  // "*.ts" filters by filename; "src/components/*.vue" or "src/**/*.ts"
  // by path relative to the root — models write both.
  const globOnPath = !!opts.glob && opts.glob.includes("/");

  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let truncated = false;

  const context = Math.min(Math.max(opts.context ?? 0, 0), 10);

  for await (const { full, name } of walkProject(root)) {
    if (truncated) break;
    if (BINARY_EXT.test(name)) continue;
    if (globRe) {
      const subject = globOnPath ? path.relative(root, full).split(path.sep).join("/") : name;
      if (!globRe.test(subject)) continue;
    }

    try {
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      const content = await readFile(full, "utf8");
      filesScanned++;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const around = (from: number, to: number) =>
            lines.slice(Math.max(0, from), to).map((l) => l.trimEnd().slice(0, 200));
          hits.push({
            file: path.relative(root, full).split(path.sep).join("/"),
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
            ...(context ? { before: around(i - context, i), after: around(i + 1, i + 1 + context) } : {}),
          });
          if (hits.length >= max) {
            truncated = true;
            break;
          }
        }
      }
    } catch {
      // Unreadable or not valid UTF-8 — skip rather than fail the search.
    }
  }

  return { hits, filesScanned, truncated };
}

export const searchCodeTool: ToolDefinition = {
  name: "search_code",
  description:
    `search_code(args: {pattern: string, path?: string, glob?: string, caseSensitive?: boolean, maxResults?: number, context?: number, filesOnly?: boolean}) -> ` +
    `searches for a regular expression and returns file:line matches. Use this to FIND things before reading ` +
    `them — it's far cheaper than reading whole files to look around. 'path' limits the search to a directory, ` +
    `including another workspace root ("../shared-lib"); default is the project root. 'glob' filters by filename ` +
    `("*.ts") or by path ("src/**/*.ts"). 'context' shows lines either side of each match, 'filesOnly' just lists ` +
    `the files. Uses ripgrep/git grep when available, so .gitignore'd and generated files are skipped.`,
  async run(args) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return { ok: false, output: "Error: 'pattern' is required." };

    try {
      new RegExp(pattern);
    } catch (err) {
      return { ok: false, output: `Error: invalid regular expression — ${(err as Error).message}` };
    }

    const scope = String(args.path ?? ".").trim() || ".";
    const resolved = resolveInRoot(scope);
    if (!resolved.ok) return { ok: false, output: outsideWorkspace("search") };
    const root = resolved.abs;
    const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
    const max = Math.min(Math.max(Number(args.maxResults) || 100, 1), MAX_RESULTS);
    const caseSensitive = Boolean(args.caseSensitive);
    const context = Math.min(Math.max(Number(args.context) || 0, 0), 10);

    // Prefer the real tools (fast, honour .gitignore); the JS walk is the
    // fallback for machines with neither rg nor git, and does context lines.
    const fast = context ? undefined : await grep(root, pattern, { glob, caseSensitive, max });
    const prefix = displayPath(root) === "." ? "" : `${displayPath(root)}/`;
    const result = fast ?? {
      ...(await searchCode({ pattern, root, glob, caseSensitive, maxResults: max, context })),
      engine: "walk",
    };
    const hits: SearchHit[] = result.hits.map((h: SearchHit) => ({ ...h, file: `${prefix}${h.file}` }));
    const where = displayPath(root) === "." ? "the project" : displayPath(root);

    if (hits.length === 0) {
      return {
        ok: true,
        output:
          `No matches for /${pattern}/ in ${where}${glob ? ` (glob ${glob})` : ""}. ` +
          `Try a looser pattern, drop the glob, or search another root with 'path'.`,
      };
    }
    if (args.filesOnly) {
      const files = [...new Set(hits.map((h) => h.file))];
      return { ok: true, output: `${files.join("\n")}\n\n[${files.length} file${files.length === 1 ? "" : "s"}${result.truncated ? ", more not shown" : ""}]` };
    }
    const lines = hits.map((h) =>
      h.before || h.after
        ? [...(h.before ?? []).map((l) => `  ${l}`), `${h.file}:${h.line}: ${h.text}`, ...(h.after ?? []).map((l) => `  ${l}`), "--"].join("\n")
        : `${h.file}:${h.line}: ${h.text}`
    );
    const footer = result.truncated
      ? `\n\n[showing the first ${hits.length} matches — narrow the pattern, add a glob or a path]`
      : `\n\n[${hits.length} match${hits.length === 1 ? "" : "es"}]`;
    return { ok: true, output: lines.join("\n") + footer };
  },
};
