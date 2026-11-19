import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot } from "./paths.js";
import { searchCode } from "./searchCode.js";

/**
 * A rough stand-in for a language server, which this has no way to run. These
 * match how definitions usually look across common languages, so they can
 * miss things or find too much, and the descriptions say so.
 */
const MODIFIERS = `(?:(?:export|default|declare|public|private|protected|internal|static|abstract|final|sealed|async|override|virtual|pub(?:\\(\\w+\\))?)\\s+)*`;
const KEYWORDS = `class|interface|type|enum|struct|trait|impl|fn|func|function|def|module|namespace`;

const DEFINITION = new RegExp(`^\\s*${MODIFIERS}(${KEYWORDS})\\s+([\\w$.]+)`);
const GO_METHOD = /^func\s*\([^)]*\)\s*(\w+)/;
const ARROW = /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/;
const METHOD = new RegExp(`^\\s+${MODIFIERS}(?:get\\s+|set\\s+)?([\\w$]+)\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$`);
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with"]);

export function outline(content: string): { line: number; kind: string; name: string }[] {
  const found: { line: number; kind: string; name: string }[] = [];
  for (const [i, text] of content.split("\n").entries()) {
    const line = i + 1;
    const go = GO_METHOD.exec(text);
    const definition = DEFINITION.exec(text);
    const arrow = ARROW.exec(text);
    const method = METHOD.exec(text);
    if (go) found.push({ line, kind: "method", name: go[1] });
    else if (definition) found.push({ line, kind: definition[1], name: definition[2] });
    else if (arrow) found.push({ line, kind: "function", name: arrow[1] });
    else if (method && !NOT_METHODS.has(method[1])) found.push({ line, kind: "method", name: method[1] });
  }
  return found;
}

export const codeOutlineTool: ToolDefinition = {
  name: "code_outline",
  description:
    `code_outline(args: {path: string}) -> the classes, functions and types a source file defines, with line numbers, ` +
    `so you can read just the part you need with read_file's offset. Pattern-based, not a real parser: it covers ` +
    `common languages and can miss things.`,
  async run(args) {
    const rel = String(args.path ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    const resolved = resolveInRoot(rel);
    if (!resolved.ok) return { ok: false, output: "Error: path escapes the project root." };
    try {
      const items = outline(await readFile(resolved.abs, "utf8"));
      if (!items.length) return { ok: true, output: `No definitions recognised in ${rel}.` };
      return { ok: true, output: items.map((d) => `${d.line}: ${d.kind} ${d.name}`).join("\n") };
    } catch (err) {
      return { ok: false, output: `Error reading ${rel}: ${(err as Error).message}` };
    }
  },
};

export const findSymbolTool: ToolDefinition = {
  name: "find_symbol",
  description:
    `find_symbol(args: {name: string, references?: boolean, glob?: string}) -> where a function, class or type is ` +
    `defined, as file:line, and with references: true everywhere that name is used. Pattern-based, not a real ` +
    `language server, so same-named things in different scopes aren't told apart.`,
  async run(args) {
    const name = String(args.name ?? "").trim();
    if (!/^[\w$.]+$/.test(name)) return { ok: false, output: "Error: 'name' must be a plain identifier." };
    const escaped = name.replace(/[.$]/g, "\\$&");
    const glob = typeof args.glob === "string" ? args.glob : undefined;

    const definition =
      `(?:\\b(?:${KEYWORDS}|const|let|var)\\s+${escaped}\\b)|(?:^\\s+${MODIFIERS}${escaped}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$)`;
    const { hits } = await searchCode({ pattern: definition, glob, caseSensitive: true });
    const sections = [
      hits.length
        ? `Defined at:\n${hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n")}`
        : `No definition of ${name} recognised.`,
    ];

    if (args.references) {
      const used = await searchCode({ pattern: `\\b${escaped}\\b`, glob, caseSensitive: true });
      const rest = used.hits.filter((u) => !hits.some((h) => h.file === u.file && h.line === u.line));
      sections.push(
        rest.length
          ? `Used at:\n${rest.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n")}` +
              (used.truncated ? "\n[stopped at the result limit]" : "")
          : "No other uses found."
      );
    }
    return { ok: true, output: sections.join("\n\n") };
  },
};
