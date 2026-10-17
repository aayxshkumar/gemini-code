/**
 * npm's `prepare` hook. Builds dist/ when installing straight from git
 * (`npm install -g github:aayxshkumar/gemini-code`), where npm runs it after
 * fetching the sources, and in a fresh checkout after `npm install`.
 *
 * It is a no-op wherever there is nothing to build: the published tarball
 * and the installer's app directory ship dist/ with no src/ or TypeScript,
 * and an unconditional `tsc` there would fail the install.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasSources = existsSync(path.join(root, "src", "cli.ts"));
const hasTsc = existsSync(path.join(root, "node_modules", "typescript", "bin", "tsc"));

if (!hasSources || !hasTsc) process.exit(0);

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
