import { describeRoots, resolveInWorkspace, type WorkspaceRoot } from "../workspace.js";

/**
 * Resolves a tool's `path` argument and confirms it stays inside the
 * workspace: the project root plus any roots added with --add-dir.
 *
 * Comparison is by path SEGMENTS (see workspace.isInside), never by string
 * prefix: with the project at `/home/me/app`, `../app-secrets/creds.txt`
 * must not pass because its absolute path happens to start with
 * `/home/me/app`. `..` is resolved lexically and symlinks are not followed —
 * the same trust boundary the shell tool has.
 */
export function resolveInRoot(rel: string): { ok: true; abs: string; root: WorkspaceRoot } | { ok: false; abs?: undefined } {
  return resolveInWorkspace(rel);
}

/** The standard refusal, naming where the model may go. */
export function outsideWorkspace(verb: string): string {
  return `Error: that path is outside the workspace, refusing to ${verb} it. Allowed roots: ${describeRoots()}. ` +
    `Ask the user to start with --add-dir <path> (or /add-dir <path>) to include another repository.`;
}
