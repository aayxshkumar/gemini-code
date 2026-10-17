// `npm run setup` on any OS: hands off to setup.ps1 on Windows, setup.sh elsewhere.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result =
  process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "setup.ps1")], { stdio: "inherit" })
    : spawnSync("bash", [path.join(root, "setup.sh")], { stdio: "inherit" });
process.exit(result.status ?? 1);
