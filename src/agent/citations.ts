/**
 * Checks the file paths a final answer cites against the workspace.
 *
 * A hallucinated path is the most common way a coding agent's answer is
 * wrong in a big repository: the model names a file that *should* exist
 * ("src/node/config.ts") and no tool ever showed it. The answer reads as
 * confident and is unverifiable to the person reading it in a terminal.
 * This is a cheap, mechanical check: every path-looking token with a
 * source-code extension must exist under some workspace root.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { primaryRoot, workspaceRoots } from "../workspace.js";

const EXT =
  "(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|scala|sh|bash|zsh|ps1|sql|vue|svelte|astro|json|ya?ml|toml|ini|cfg|md|mdx|txt|html?|css|scss|less|xml|gradle|lock)";
// A path = at least one directory segment, a filename, a known extension;
// optionally ":line". Not preceded by a word char, "@" or "/" (so the tail
// of a URL or a scoped package name isn't taken as a path on its own).
const PATH_RE = new RegExp(`(?<![\\w@/.-])((?:\\.{1,2}/)?(?:[\\w.@-]+/)+[\\w.@-]+\\.${EXT})(?::\\d+)?(?![\\w/])`, "g");

/** Paths cited in `text` that exist nowhere in the workspace. */
export function missingCitedPaths(text: string): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  const roots = workspaceRoots().map((r) => r.dir);
  for (const m of text.matchAll(PATH_RE)) {
    const cited = m[1];
    if (seen.has(cited)) continue;
    seen.add(cited);
    // URLs, package specifiers and obvious placeholders are not citations.
    if (/^(https?:|www\.|node_modules\/|@)/.test(cited) || /[<>{}*]/.test(cited)) continue;
    if (/^(path|to|your|some|example|foo|bar|a|the)\//i.test(cited)) continue;
    const bare = cited.replace(/^(\.\.?\/)+/, "");
    const exists =
      existsSync(path.resolve(primaryRoot(), cited)) ||
      roots.some((r) => existsSync(path.resolve(r, cited)) || existsSync(path.resolve(r, bare)));
    if (!exists) missing.push(cited);
  }
  return missing;
}
