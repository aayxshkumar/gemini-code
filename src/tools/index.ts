import type { ToolDefinition } from "../types.js";
import { readFileTool } from "./readFile.js";
import { editFileTool } from "./editFile.js";
import { searchCodeTool } from "./searchCode.js";
import { findFilesTool } from "./findFiles.js";
import { gitStatusTool, gitDiffTool } from "./git.js";
import { writeFileTool } from "./writeFile.js";
import { bashTool, checkOutputTool, killProcessTool } from "./bash.js";
import { listFilesTool } from "./listFiles.js";
import { rememberTool } from "./remember.js";
import { fetchUrlTool } from "./fetchUrl.js";
import { webSearchTool } from "./webSearch.js";

export const tools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  searchCodeTool,
  findFilesTool,
  gitStatusTool,
  gitDiffTool,
  bashTool,
  checkOutputTool,
  killProcessTool,
  listFilesTool,
  rememberTool,
  fetchUrlTool,
  webSearchTool,
];

export const toolsByName: Record<string, ToolDefinition> = Object.fromEntries(
  tools.map((t) => [t.name, t])
);
