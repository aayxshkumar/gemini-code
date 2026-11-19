import { randomUUID } from "node:crypto";
import { gateWrite } from "../permissions/gate.js";
import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot } from "./paths.js";
import { confirmAction } from "./confirm.js";
import { checkpoints } from "../context/checkpoint.js";

const MAX_OUTPUT_CHARS = 1_000;

interface Cell {
  cell_type: string;
  source: string | string[];
  outputs?: { text?: string | string[]; data?: Record<string, unknown>; ename?: string; evalue?: string }[];
  [key: string]: unknown;
}

interface Notebook {
  cells: Cell[];
  nbformat_minor?: number;
  [key: string]: unknown;
}

const joined = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.join("") : (value ?? "");

/** Notebooks store a cell as lines that keep their newlines, all but the last. */
const asLines = (source: string): string[] => source.split(/(?<=\n)/);

function outputText(cell: Cell): string {
  const text = (cell.outputs ?? [])
    .map((o) => {
      if (o.ename) return `${o.ename}: ${o.evalue ?? ""}`;
      const plain = o.data?.["text/plain"] as string | string[] | undefined;
      const images = Object.keys(o.data ?? {}).filter((k) => k.startsWith("image/"));
      return joined(o.text) || joined(plain) || (images.length ? `[${images.join(", ")}]` : "");
    })
    .filter(Boolean)
    .join("\n");
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output cut]` : text;
}

async function load(rel: string): Promise<{ abs: string; notebook: Notebook } | { error: string }> {
  if (!rel) return { error: "Error: 'path' is required." };
  if (!rel.toLowerCase().endsWith(".ipynb")) return { error: `Error: ${rel} isn't a .ipynb notebook.` };
  const resolved = resolveInRoot(rel);
  if (!resolved.ok) return { error: "Error: path escapes the project root." };
  try {
    const notebook = JSON.parse(await readFile(resolved.abs, "utf8")) as Notebook;
    if (!Array.isArray(notebook.cells)) return { error: `Error: ${rel} has no cells.` };
    return { abs: resolved.abs, notebook };
  } catch (err) {
    return { error: `Error reading ${rel}: ${(err as Error).message}` };
  }
}

export const notebookReadTool: ToolDefinition = {
  name: "notebook_read",
  description:
    `notebook_read(args: {path: string}) -> a Jupyter notebook's cells, numbered from 0, with their code or markdown ` +
    `and any text output. Use this rather than read_file, which would return raw JSON.`,
  async run(args) {
    const opened = await load(String(args.path ?? ""));
    if ("error" in opened) return { ok: false, output: opened.error };
    const cells = opened.notebook.cells.map((cell, i) => {
      const output = outputText(cell);
      return `--- cell ${i} (${cell.cell_type}) ---\n${joined(cell.source)}${output ? `\n--- output ---\n${output}` : ""}`;
    });
    return { ok: true, output: cells.join("\n\n") || "The notebook has no cells." };
  },
};

export const notebookEditTool: ToolDefinition = {
  name: "notebook_edit",
  description:
    `notebook_edit(args: {path: string, cell: number, mode?: "replace"|"insert"|"delete", source?: string, ` +
    `cell_type?: "code"|"markdown"}) -> changes one notebook cell, numbered as notebook_read shows them. 'replace' ` +
    `(the default) swaps its source and clears stale output, 'insert' adds a new cell before that position (use the ` +
    `cell count to append), 'delete' removes it. The user confirms it, and /undo restores it.`,
  async run(args) {
    const rel = String(args.path ?? "");
    const opened = await load(rel);
    if ("error" in opened) return { ok: false, output: opened.error };
    const { abs, notebook } = opened;

    const mode = String(args.mode ?? "replace");
    const index = Number(args.cell);
    const cellType = String(args.cell_type ?? "code");
    const last = mode === "insert" ? notebook.cells.length : notebook.cells.length - 1;
    if (!Number.isInteger(index) || index < 0 || index > last) {
      return { ok: false, output: `Error: 'cell' must be between 0 and ${last}.` };
    }
    if (mode !== "delete" && typeof args.source !== "string") {
      return { ok: false, output: "Error: 'source' is required." };
    }
    const source = asLines(String(args.source ?? ""));

    if (mode === "delete") {
      notebook.cells.splice(index, 1);
    } else if (mode === "insert") {
      const cell: Cell = { cell_type: cellType, metadata: {}, source };
      if (cellType === "code") Object.assign(cell, { execution_count: null, outputs: [] });
      // Required from format 4.5 on, and rejected by Jupyter when missing.
      if ((notebook.nbformat_minor ?? 0) >= 5) cell.id = randomUUID().slice(0, 8);
      notebook.cells.splice(index, 0, cell);
    } else if (mode === "replace") {
      const cell = notebook.cells[index];
      cell.source = source;
      if (cell.cell_type === "code") Object.assign(cell, { execution_count: null, outputs: [] });
    } else {
      return { ok: false, output: `Error: unknown mode "${mode}".` };
    }

    const gate = await gateWrite(abs, "Edit notebook?", `${rel} — ${mode} cell ${index}`);
    if (!gate.run && gate.message) return { ok: false, output: gate.message };
    if (!gate.run) {
      return { ok: false, output: "User declined this edit." };
    }
    try {
      await checkpoints.writeFile(abs, `${JSON.stringify(notebook, null, 1)}\n`);
      return { ok: true, output: `Notebook updated: ${mode} cell ${index}. It has ${notebook.cells.length} cells.` };
    } catch (err) {
      return { ok: false, output: `Error writing ${rel}: ${(err as Error).message}` };
    }
  },
};
