import {
  CONFIG_KEYS,
  envNameFor,
  projectConfigPath,
  readConfigFile,
  userConfigPath,
  writeUserConfig,
  configSources,
} from "../config.js";
import { c } from "../ui/format.js";

/**
 * `gemini-code config` — show, set and unset persistent defaults, so the
 * same setup travels with one command instead of a shell profile full of
 * exports.
 *
 *   gemini-code config                 show everything in effect
 *   gemini-code config set model pro   save a default
 *   gemini-code config unset model
 *   gemini-code config path
 */
export async function configCommand(argv: string[]): Promise<void> {
  const [sub, key, ...rest] = argv;
  const value = rest.join(" ");

  if (!sub || sub === "show" || sub === "list") {
    const user = readConfigFile(userConfigPath());
    const project = readConfigFile(projectConfigPath());
    const source = configSources;
    console.log(`\n${c.bold("gemini-code config")}\n`);
    console.log(`  ${c.dim("user file   ")} ${userConfigPath()}${Object.keys(user).length ? "" : c.dim("  (not created yet)")}`);
    console.log(`  ${c.dim("project file")} ${projectConfigPath()}${Object.keys(project).length ? "" : c.dim("  (none)")}\n`);
    for (const [k, { env, hint }] of Object.entries(CONFIG_KEYS)) {
      const current = process.env[env];
      const where = source[env] ? c.dim(`from ${source[env] === userConfigPath() ? "user config" : "project config"}`) : current !== undefined ? c.dim("from environment") : c.dim("default");
      console.log(`  ${c.cyan(k.padEnd(18))} ${(current ?? "-").padEnd(14)} ${where}\n  ${"".padEnd(18)} ${c.dim(hint)}`);
    }
    console.log(`\n  ${c.dim("set one:")} gemini-code config set model pro\n`);
    return;
  }

  if (sub === "path") {
    console.log(userConfigPath());
    return;
  }

  if (sub === "set") {
    if (!key || !value) {
      console.error("usage: gemini-code config set <key> <value>");
      process.exitCode = 2;
      return;
    }
    if (!envNameFor(key)) {
      console.error(`unknown key "${key}". Known keys: ${Object.keys(CONFIG_KEYS).join(", ")} (or any GEMINI_CODE_* variable)`);
      process.exitCode = 2;
      return;
    }
    const current = readConfigFile(userConfigPath());
    const parsed: string | number | boolean = /^(true|false)$/i.test(value)
      ? value.toLowerCase() === "true"
      : /^-?\d+$/.test(value)
        ? Number(value)
        : value;
    writeUserConfig({ ...current, [key]: parsed });
    console.log(`  ${c.green("✓")} ${key} = ${String(parsed)}  ${c.dim(`(${userConfigPath()})`)}`);
    return;
  }

  if (sub === "unset" || sub === "rm") {
    if (!key) {
      console.error("usage: gemini-code config unset <key>");
      process.exitCode = 2;
      return;
    }
    const current = readConfigFile(userConfigPath());
    if (!(key in current)) {
      console.log(`  ${c.dim(`${key} wasn't set`)}`);
      return;
    }
    delete current[key];
    writeUserConfig(current);
    console.log(`  ${c.green("✓")} removed ${key}`);
    return;
  }

  console.error(`unknown config command "${sub}". Try: show | set <key> <value> | unset <key> | path`);
  process.exitCode = 2;
}
