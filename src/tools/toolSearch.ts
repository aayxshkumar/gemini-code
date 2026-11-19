import type { ToolDefinition } from "../types.js";

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 12;

/** Marks a tool as loaded on demand instead of described in the primer. */
export function deferTool(tool: ToolDefinition): ToolDefinition {
  return { ...tool, deferred: true };
}

/** Best match first; a word in the name counts for far more than one in the prose. */
function rank(candidates: ToolDefinition[], query: string): ToolDefinition[] {
  const words = query.toLowerCase().split(/[\s,_-]+/).filter(Boolean);
  const scored = candidates.map((tool) => {
    const name = tool.name.toLowerCase();
    const prose = tool.description.toLowerCase();
    const score = words.reduce(
      (total, word) => total + (name.includes(word) ? 10 : 0) + (prose.includes(word) ? 1 : 0),
      0
    );
    return { tool, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.tool);
}

/**
 * Lets the model load tools as it needs them, the way Claude Code does.
 *
 * The primer goes through a composer with a practical size limit, and the web
 * UI silently truncates long threads, so every tool described up front is
 * context that can't hold anything else. Deferred tools appear there by name
 * only, and their descriptions arrive here when they're wanted.
 *
 * `select:` loads several in one call, because one tool call is one whole
 * Gemini message on a rate-limited account.
 */
export function createToolSearchTool(
  allTools: () => ToolDefinition[],
  loaded: Set<string>
): ToolDefinition {
  return {
    name: "tool_search",
    description:
      `tool_search(args: {query: string, max_results?: number}) -> loads the full definition of tools that are only ` +
      `named above, so you can call them. Query with "select:name1,name2" for exact names (load everything you'll ` +
      `need in one call), or with keywords like "notebook" or "git history" to find one.`,
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, output: "Error: 'query' is required." };

      const deferred = allTools().filter((tool) => tool.deferred);
      let found: ToolDefinition[];
      let missing: string[] = [];

      if (query.toLowerCase().startsWith("select:")) {
        const names = query.slice("select:".length).split(",").map((n) => n.trim()).filter(Boolean);
        found = deferred.filter((tool) => names.includes(tool.name));
        missing = names.filter((name) => !deferred.some((tool) => tool.name === name));
      } else {
        const limit = Math.min(Number(args.max_results) || DEFAULT_RESULTS, MAX_RESULTS);
        found = rank(deferred, query).slice(0, limit);
      }

      for (const tool of found) loaded.add(tool.name);

      const unknown = missing.length ? `\n\nNot found: ${missing.join(", ")}.` : "";
      if (!found.length) {
        return {
          ok: false,
          output: `No tools matched "${query}".${unknown}\nDeferred tools: ${deferred.map((t) => t.name).join(", ")}`,
        };
      }
      const docs = found.map((tool) => `- ${tool.description}`).join("\n");
      return { ok: true, output: `Loaded ${found.length} tool(s). You can call them now:\n${docs}${unknown}` };
    },
  };
}
