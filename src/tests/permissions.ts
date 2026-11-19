/**
 * Permission rules: the bypass table per shell, write paths, hosts, trust,
 * and the rules working through the real tools. Called from smoke.ts.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decideCommand, decideHost, decideWrite, normalizeForRules } from "../permissions/decide.js";
import { readRules, type RuleSet } from "../permissions/rules.js";
import { parseBash, parseCmd, parsePowerShell, type ShellFlavour } from "../permissions/shellSyntax.js";
import { loadPermissions, setRulesForTests, currentPermissions } from "../permissions/session.js";
import { permissionsCheck, permissionsReport } from "../permissions/report.js";
import { emptyRules } from "../permissions/rules.js";
import { heldBackSettings } from "../config.js";
import { bashTool } from "../tools/bash.js";
import { writeFileTool } from "../tools/writeFile.js";
import { fetchUrlTool } from "../tools/fetchUrl.js";
import { setAsker } from "../ui/prompt.js";
import { markRead } from "../tools/fileState.js";

type Test = (name: string, fn: () => Promise<void> | void) => Promise<void>;

const ROOT = path.resolve(".tmp-test", "perm-root");
const rules = (permissions: unknown): RuleSet => readRules(permissions, "test.json");
const cmd = (line: string, set: RuleSet, flavour: ShellFlavour = "bash") => decideCommand(line, set, { flavour, cwd: ROOT, root: ROOT }).verdict;

/** Runs fn with real prompts on, counting questions and answering `answer`. */
async function withPrompts<T>(answer: string, fn: (asked: string[]) => Promise<T>): Promise<T> {
  const prev = { a: process.env.GEMINI_CODE_AUTO_APPROVE, u: process.env.GEMINI_CODE_PROMPT_UNATTENDED };
  delete process.env.GEMINI_CODE_AUTO_APPROVE;
  process.env.GEMINI_CODE_PROMPT_UNATTENDED = "1";
  const asked: string[] = [];
  setAsker(async (q) => {
    asked.push(q);
    return answer;
  });
  try {
    return await fn(asked);
  } finally {
    setAsker(undefined);
    if (prev.a === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
    else process.env.GEMINI_CODE_AUTO_APPROVE = prev.a;
    if (prev.u === undefined) delete process.env.GEMINI_CODE_PROMPT_UNATTENDED;
    else process.env.GEMINI_CODE_PROMPT_UNATTENDED = prev.u;
  }
}

export async function permissionTests(test: Test): Promise<void> {
  const gitStatus = rules({ allow: { commands: ["git status"] } });

  await test("permissions: 'git status' allowed runs alone, and nothing chained onto it is approved", () => {
    assert.equal(cmd("git status", gitStatus), "allow");
    for (const line of ["git status && rm -rf x", "git status; rm x", "git status | sh", "git status || rm x", "git status & rm x",
      "echo $(rm x)", "echo `rm x`", "git status\nrm x", "(rm x)", "git status > /etc/passwd", "cat <(rm x)", "git status $(rm x)",
      "FOO=1 git status && rm x", "{ rm x; }", "if true; then rm x; fi"]) {
      assert.notEqual(cmd(line, gitStatus), "allow", line);
    }
  });

  await test("permissions: a quoted separator isn't a split", () => {
    const set = rules({ allow: { commands: ["git commit -m *"] } });
    assert.equal(cmd(`git commit -m "a && b"`, set), "allow");
    assert.equal(cmd(`git commit -m 'a; rm -rf /'`, set), "allow");
    assert.deepEqual(parseBash(`git commit -m "a && b"`).commands.map((c) => c.words), [["git", "commit", "-m", "a && b"]]);
    // …but a substitution inside double quotes still runs.
    assert.notEqual(cmd(`git commit -m "$(rm x)"`, set), "allow");
  });

  await test("permissions: deny beats allow, and sees through wrappers, paths, shells and assignments", () => {
    const set = rules({ allow: { commands: ["git *", "sudo *", "env *", "xargs *", "bash *", "find *", "timeout *"] }, deny: { commands: ["git push *", "rm *"] } });
    assert.equal(cmd("git push origin main", set), "deny");
    assert.equal(cmd("git status", set), "allow");
    for (const line of ["sudo git push", "env FOO=1 git push", "FOO=1 git push", "/usr/bin/git push", "timeout 5 git push",
      "xargs rm", "find . -exec rm {} ;", `bash -c "git push"`, `sh -c 'rm -rf /'`, "eval rm x", "nohup rm x",
      "git status && git push", "echo $(git push)"]) {
      assert.equal(cmd(line, set), "deny", line);
    }
  });

  await test("permissions: PowerShell splits on ; | && || and subexpressions, with aliases", () => {
    const set = rules({ allow: { commands: ["git status", "Get-ChildItem *"] }, deny: { commands: ["Remove-Item *"] } });
    assert.equal(cmd("git status", set, "powershell"), "allow");
    assert.equal(cmd("Get-ChildItem . | Remove-Item", set, "powershell"), "deny");
    assert.equal(cmd("git status; rm x", set, "powershell"), "deny", "rm is Remove-Item's alias");
    assert.equal(cmd("git status; del x", set, "powershell"), "deny");
    assert.equal(cmd('echo "$(Remove-Item x)"', set, "powershell"), "deny");
    assert.equal(cmd("Get-ChildItem | ForEach-Object { ri $_ }", set, "powershell"), "deny", "script blocks run");
    assert.equal(cmd("iex 'Remove-Item x'", set, "powershell"), "deny");
    const encoded = Buffer.from("Remove-Item x", "utf16le").toString("base64");
    assert.equal(cmd(`powershell -EncodedCommand ${encoded}`, set, "powershell"), "deny");
    assert.notEqual(cmd("git status && rm x", set, "powershell"), "allow");
    assert.deepEqual(parsePowerShell("git commit -m 'a; b'").commands.map((c) => c.words), [["git", "commit", "-m", "a; b"]]);
  });

  await test("permissions: cmd splits on & && || | with ^ escapes and quotes, and its synonyms", () => {
    const set = rules({ allow: { commands: ["git status", "dir"] }, deny: { commands: ["del *", "rd *"] } });
    assert.equal(cmd("git status", set, "cmd"), "allow");
    assert.equal(cmd("git status & del x", set, "cmd"), "deny");
    assert.equal(cmd("dir && erase x", set, "cmd"), "deny", "erase is del");
    assert.equal(cmd("git status || rmdir /s x", set, "cmd"), "deny");
    assert.equal(cmd(`cmd /c "del x"`, set, "cmd"), "deny");
    assert.deepEqual(parseCmd('echo "a & b" ^& c').commands.map((c) => c.words), [["echo", "a & b", "&", "c"]]);
    assert.notEqual(cmd("%COMSPEC% /c del x", rules({ allow: { commands: ["*"] } }), "cmd"), "allow", "an expanded command name is never approved");
  });

  await test("permissions: what can't be read with certainty is never approved", () => {
    const all = rules({ allow: { commands: ["*", "* *", "cat *", "bash *"] } });
    for (const line of ["cat <<EOF\nrm x\nEOF", `echo "unterminated`, "$CMD arg", "for f in *; do rm $f; done", "bash script.sh", "LD_PRELOAD=x.so ls"]) {
      assert.equal(cmd(line, all), "ask", line);
    }
  });

  await test("permissions: write rules — allow src/**, deny .env; tricky spellings of .env stay denied", () => {
    const set = rules({ allow: { writes: ["src/**", "*.md"] }, deny: { writes: [".env", "secrets/"] } });
    const w = (rel: string) => decideWrite(path.join(ROOT, rel), set, ROOT).verdict;
    assert.equal(w("src/app.ts"), "allow");
    assert.equal(w("src/deep/x.ts"), "allow");
    assert.equal(w("README.md"), "allow");
    assert.equal(w("lib/x.ts"), "ask");
    assert.equal(w(".env"), "deny");
    assert.equal(w("src/.env"), "deny", "an unanchored name matches at any depth, even under an allowed folder");
    assert.equal(w("secrets/key.pem"), "deny");
    assert.equal(normalizeForRules(".env."), ".env");
    assert.equal(normalizeForRules(".env::$DATA"), ".env");
    assert.equal(w(".env."), "deny", "Windows drops trailing dots");
    assert.equal(w(".gemini-code.json"), "ask", "the rules file always asks");
    assert.equal(w(".git/config"), "ask");
    assert.equal(decideWrite(path.resolve(ROOT, "../outside.ts"), set, ROOT).verdict, "ask", "outside the project is never allowed by a rule");
  });

  await test("permissions: shell redirects are checked against the write rules", () => {
    const set = rules({ allow: { commands: ["echo *"], writes: ["out/**"] }, deny: { writes: [".env"] } });
    assert.equal(cmd("echo hi > out/log.txt", set), "allow");
    assert.equal(cmd("echo hi > .env", set), "deny");
    assert.equal(cmd("echo hi >> other.txt", set), "ask");
    assert.equal(cmd("echo hi 2>&1", set), "allow", "a descriptor isn't a file");
  });

  await test("permissions: host rules match the host, not a substring", () => {
    const set = rules({ allow: { hosts: ["github.com", "*.githubusercontent.com"] }, deny: { hosts: ["evil.example"] } });
    const h = (url: string) => decideHost(url, set).verdict;
    assert.equal(h("https://github.com/x"), "allow");
    assert.equal(h("https://github.com.evil.example/x"), "ask");
    assert.equal(h("https://notgithub.com/"), "ask");
    assert.equal(h("https://raw.githubusercontent.com/a"), "allow");
    assert.equal(h("https://githubusercontent.com/a"), "ask", "*.x is subdomains only");
    assert.equal(h("https://evil.example/"), "deny");
    assert.equal(h("https://GitHub.COM./x"), "allow", "case and a trailing dot don't matter");
  });

  await test("permissions: no rules means exactly today's behaviour, and autoApprove still works", async () => {
    setRulesForTests(emptyRules(), ROOT);
    await withPrompts("n", async (asked) => {
      const r = await bashTool.run({ command: "echo hello" });
      assert.equal(asked.length, 1);
      assert.ok(!asked[0].includes("why it asks"), "no rules: the prompt is unchanged");
      assert.equal(r.ok, false);
    });
    const prev = process.env.GEMINI_CODE_AUTO_APPROVE;
    process.env.GEMINI_CODE_AUTO_APPROVE = "all";
    try {
      assert.ok((await bashTool.run({ command: "echo hello" })).ok);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
      else process.env.GEMINI_CODE_AUTO_APPROVE = prev;
    }
  });

  await test("permissions: through the real tools — allow runs without asking, deny refuses even with autoApprove", async () => {
    await mkdir(ROOT, { recursive: true });
    setRulesForTests(rules({ allow: { commands: ["echo *"] }, deny: { commands: ["echo forbidden"], writes: [".env"] } }), process.cwd());
    try {
      await withPrompts("n", async (asked) => {
        const ok = await bashTool.run({ command: "echo allowed" });
        assert.ok(ok.ok, ok.output);
        assert.equal(asked.length, 0, "an allowed command doesn't ask");
        const other = await bashTool.run({ command: "ls" });
        assert.equal(asked.length, 1);
        assert.match(asked[0], /why it asks: "ls" isn't covered/);
        assert.equal(other.ok, false);
      });
      const prev = process.env.GEMINI_CODE_AUTO_APPROVE;
      process.env.GEMINI_CODE_AUTO_APPROVE = "all";
      try {
        const denied = await bashTool.run({ command: "echo forbidden" });
        assert.equal(denied.ok, false);
        assert.match(denied.output, /Refused: .*denied by "echo forbidden"/);
        const env = await writeFileTool.run({ path: ".tmp-test/perm-root/.env", content: "X=1" });
        assert.match(env.output, /Refused/);
        await assert.rejects(readFile(path.join(ROOT, ".env")), "nothing was written");
      } finally {
        if (prev === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
        else process.env.GEMINI_CODE_AUTO_APPROVE = prev;
      }
    } finally {
      setRulesForTests(emptyRules(), process.cwd());
    }
  });

  await test("permissions: a write through a symlink to a denied file is denied", async () => {
    if (process.platform === "win32") return; // symlinks need Developer Mode there
    await mkdir(ROOT, { recursive: true });
    await writeFile(path.join(ROOT, ".env"), "SECRET=1");
    await rm(path.join(ROOT, "notes.txt"), { force: true });
    await symlink(path.join(ROOT, ".env"), path.join(ROOT, "notes.txt"));
    await markRead(path.resolve(ROOT, "notes.txt"), true);
    setRulesForTests(rules({ allow: { writes: ["*.txt"] }, deny: { writes: [".env"] } }), process.cwd());
    try {
      const prev = process.env.GEMINI_CODE_AUTO_APPROVE;
      process.env.GEMINI_CODE_AUTO_APPROVE = "all";
      try {
        const r = await writeFileTool.run({ path: ".tmp-test/perm-root/notes.txt", content: "overwritten" });
        assert.match(r.output, /Refused/);
      } finally {
        if (prev === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
        else process.env.GEMINI_CODE_AUTO_APPROVE = prev;
      }
      assert.equal(await readFile(path.join(ROOT, ".env"), "utf8"), "SECRET=1");
    } finally {
      setRulesForTests(emptyRules(), process.cwd());
      await rm(ROOT, { recursive: true, force: true });
    }
  });

  await test("permissions: fetch_url refuses a denied host, and a redirect to one", async () => {
    setRulesForTests(rules({ deny: { hosts: ["127.0.0.1"] } }), process.cwd());
    try {
      const prev = process.env.GEMINI_CODE_AUTO_APPROVE;
      process.env.GEMINI_CODE_AUTO_APPROVE = "all";
      try {
        const r = await fetchUrlTool.run({ url: "http://127.0.0.1:9/x" });
        assert.match(r.output, /Refused/);
      } finally {
        if (prev === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
        else process.env.GEMINI_CODE_AUTO_APPROVE = prev;
      }
    } finally {
      setRulesForTests(emptyRules(), process.cwd());
    }
  });

  await test("permissions: a project's allow rules and autoApprove wait for trust; its deny rules don't", async () => {
    const home = path.resolve(".tmp-test", "perm-home");
    const project = path.resolve(".tmp-test", "perm-project");
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, ".gemini-code.json"),
      JSON.stringify({ permissions: { allow: { commands: ["rm *"] }, deny: { commands: ["git push *"] } } })
    );
    const prevHome = process.env.GEMINI_CODE_HOME;
    process.env.GEMINI_CODE_HOME = home;
    heldBackSettings.GEMINI_CODE_AUTO_APPROVE = "all"; // as if the project file set autoApprove
    const prevApprove = process.env.GEMINI_CODE_AUTO_APPROVE;
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    try {
      const unattended = await loadPermissions({ root: project });
      assert.equal(unattended.trust, "unanswered");
      assert.ok(unattended.rules.rules.some((r) => r.effect === "deny" && r.pattern === "git push *"), "deny applies untrusted");
      assert.ok(!unattended.rules.rules.some((r) => r.effect === "allow"), "allow is held back");
      assert.equal(process.env.GEMINI_CODE_AUTO_APPROVE, undefined, "autoApprove is held back");
      assert.match(permissionsReport(), /Held back until you trust this project/);

      let asked = 0;
      const no = await loadPermissions({ root: project, ask: async () => (asked++, false) });
      assert.equal(no.trust, "untrusted");
      const again = await loadPermissions({ root: project, ask: async () => (asked++, true) });
      assert.equal(again.trust, "untrusted", "the stored answer is reused");
      assert.equal(asked, 1);

      // Changing the held-back settings asks again.
      await writeFile(path.join(project, ".gemini-code.json"), JSON.stringify({ permissions: { allow: { commands: ["ls"] } } }));
      const yes = await loadPermissions({ root: project, ask: async () => (asked++, true) });
      assert.equal(asked, 2);
      assert.equal(yes.trust, "trusted");
      assert.ok(yes.rules.rules.some((r) => r.effect === "allow" && r.pattern === "ls"));
      assert.equal(process.env.GEMINI_CODE_AUTO_APPROVE, "all", "trusted: its settings apply");
    } finally {
      delete heldBackSettings.GEMINI_CODE_AUTO_APPROVE;
      if (prevApprove === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
      else process.env.GEMINI_CODE_AUTO_APPROVE = prevApprove;
      if (prevHome === undefined) delete process.env.GEMINI_CODE_HOME;
      else process.env.GEMINI_CODE_HOME = prevHome;
      setRulesForTests(emptyRules(), process.cwd());
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  await test("permissions: rule-file errors are reported; /permissions check explains a decision", () => {
    const bad = readRules({ allow: { commands: "git status", files: [] }, maybe: {} }, "x.json");
    assert.equal(bad.errors.length, 3, bad.errors.join("\n"));
    setRulesForTests(rules({ deny: { commands: ["git push *"] } }), process.cwd());
    try {
      assert.match(permissionsCheck("git push origin", "bash"), /DENY — denied by "git push \*"/);
      assert.equal(currentPermissions().rules.rules.length, 1);
    } finally {
      setRulesForTests(emptyRules(), process.cwd());
    }
  });
}
