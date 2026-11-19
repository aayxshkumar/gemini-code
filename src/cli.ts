#!/usr/bin/env node
// Config first: it fills process.env from ~/.gemini-code/config.json before
// the modules below read their GEMINI_CODE_* settings at load time.
import "./config.js";
import readline from "node:readline/promises";
import { createRequire } from "node:module";
import { emitKeypressEvents } from "node:readline";
import path from "node:path";
import { GeminiDriver, applySiteSelectors, type Gem } from "./driver/GeminiDriver.js";
import { gemFlag, gemModeFlag, modelFlag, chooseModelFlag, enterpriseFlag, serveArgs } from "./args.js";
import { enterpriseLink, isEnterprise, siteName } from "./driver/site.js";
import { askForEnterpriseLink, enterpriseConfigured, setEnterprise } from "./enterprise.js";
import { loadPermissions } from "./permissions/session.js";
import { permissionsCheck, permissionsReport, permissionsReset } from "./permissions/report.js";
import { SHELL_FLAVOUR } from "./tools/bash.js";
import { startServer } from "./server/openai.js";
import { installDialogRaceGuard } from "./driver/processGuards.js";
import { createMainSession } from "./agent/mainSession.js";
import { runBridge } from "./bridge/run.js";
import { buildProjectTree } from "./context/projectTree.js";
import { collectProjectDocs, collectRootSummaryDocs, type ProjectDoc } from "./context/projectDocs.js";
import { addRoot, extraRoots, rootsFromArgs, displayPath } from "./workspace.js";
import { forgetAll } from "./tools/fileState.js";
import { acquireInstanceLock, releaseInstanceLock } from "./context/lock.js";
import { autoApproved } from "./tools/confirm.js";
import { ensureMemoryFile, readMemory, appendMemory, MEMORY_FILENAME } from "./context/memory.js";
import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_EXTENDED_THINKING,
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  modelHelp,
  resolveModel,
  resolveThinkingLevel,
} from "./driver/models.js";
import { readConfigFile, userConfigPath, writeUserConfig } from "./config.js";
import type { PickerEntry } from "./driver/GeminiDriver.js";
import { tools } from "./tools/index.js";
import { killAllBackgroundProcesses } from "./tools/bash.js";
import { McpManager, MCP_CONFIG_FILENAME } from "./tools/mcp.js";
import { discoverSkills, installSkills, listInstalled, removeSkill } from "./tools/skillInstall.js";
import { findSkills, skillSummaries } from "./tools/skills.js";
import { MAX_PARALLEL_WORKERS } from "./agent/workers.js";
import { createAskGemTool } from "./tools/askGem.js";
import type { ToolDefinition } from "./types.js";
import { PlanJournal, findResumablePlan, readPlan, clearPlan, resumeTaskText, PLAN_FILENAME } from "./context/plan.js";
import { checkpoints, STATE_TEXT } from "./context/checkpoint.js";
import { readClipboardImageDetailed, isImagePath, normalizeDroppedPath } from "./context/clipboard.js";
import { existsSync } from "node:fs";

/**
 * Master/worker by default: the main tab plans, delegates and validates,
 * while implementation happens in parallel worker tabs. Set
 * GEMINI_CODE_ORCHESTRATOR=0 to go back to one tab doing everything.
 */
const ORCHESTRATOR_MODE = process.env.GEMINI_CODE_ORCHESTRATOR !== "0";

/** Read from package.json so `npm version` can't leave it stale. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
import { openChrome, ensureChromeRunning } from "./scripts/openChrome.js";
import { checkLogin } from "./scripts/login.js";
import { doctor } from "./scripts/doctor.js";
import { probe } from "./scripts/probe.js";
import { configCommand } from "./scripts/configCmd.js";
import { API_MODELS } from "./server/protocol.js";
import { c, glyph, ASCII } from "./ui/format.js";
const ASCII_SELECTED = ASCII ? "  <- selected" : "  ← selected";
import { setAsker } from "./ui/prompt.js";

function helpText(): string {
  return `${c.bold("Commands")}
  ${c.cyan("/permissions")}      the allow/deny rules in force; ${c.cyan("/permissions check <command|path|url>")}; ${c.cyan("/permissions reset")}
  ${c.cyan("/enterprise")}       where you sign in: show it, or ${c.cyan("/enterprise <link>")} to use Gemini Enterprise
  ${c.cyan("/enterprise off")}   go back to gemini.google.com
  ${c.cyan("/model")}            show the current model
  ${c.cyan("/model <name>")}     switch model:
${modelHelp()
    .split("\n")
    .map((l) => "  " + l)
    .join("\n")}
  ${c.cyan("/models")}           list the models in this account's picker (live)
  ${c.cyan("/model <label>")}    pick one by its picker label, e.g. /model 3.8 Thinking
  ${c.cyan("/level low|medium|high")}  thinking level (default high)
  ${c.cyan("/thinking on|off")}  the Extended thinking toggle, where the picker has one
  ${c.cyan("/gems")}             list the Gems on your account
  ${c.cyan("/gem <name>")}       consult a Gem for project knowledge (ask_gem)
  ${c.cyan("/gem off")}          stop using a Gem
  ${c.cyan("/roots")}            the workspace roots (project + --add-dir repos)
  ${c.cyan("/add-dir <path>")}   add another repository to the workspace (fresh thread)
  ${c.cyan("/compact")}          close the thread and continue in a fresh one with a handoff note
  ${c.cyan("/clear")}            start a fresh conversation thread
  ${c.cyan("/paste")} or ${c.cyan("Ctrl+V")}  attach an image from the clipboard
  ${c.cyan("/image <path>")}     attach an image file (or just drag one in)
  ${c.cyan("/undo")}             revert the last task's file changes (refuses if you edited them since)
  ${c.cyan("/undo --force")}     undo anyway, keeping your versions as <file>.conflict
  ${c.cyan("/undo list")}        the tasks that can be undone, and what undoing each would do
  ${c.cyan("/plan")}             show the current plan / progress journal
  ${c.cyan("/plan clear")}       delete ${PLAN_FILENAME}
  ${c.cyan("/resume")}           continue the interrupted task in ${PLAN_FILENAME} (or just type "continue")
  ${c.cyan("/memory")}           show ${MEMORY_FILENAME}
  ${c.cyan("/remember <note>")}  append a note to ${MEMORY_FILENAME}
  ${c.cyan("/tools")}            list tools available to Gemini
  ${c.cyan("/mcp")}              show MCP servers
  ${c.cyan("/help")}             this message
  ${c.cyan("/exit")}             quit (or Ctrl+C)

Anything else is sent to Gemini as a task.`;
}

/** Renders the live picker for the chooser and /models. */
function pickerLines(entries: PickerEntry[]): string[] {
  return entries
    .filter((e) => !e.submenu)
    .map((e, i) => {
      const alias = resolveModelAliasFor(e.label);
      return `  ${c.bold(String(i + 1).padStart(2))}) ${e.label.padEnd(16)} ${c.dim(e.description)}${
        e.selected ? c.green(ASCII_SELECTED) : ""
      }${e.locked ? c.yellow("  (locked: needs a paid plan)") : ""}${alias.length ? c.dim(`  alias: ${alias[0]}`) : ""}`;
    });
}

/** Which of our aliases, if any, would select this picker label. */
function resolveModelAliasFor(label: string): string[] {
  const { MODELS } = modelsModule;
  const m = MODELS.find((m) => m.matches(label));
  return m ? [m.aliases[0]] : [];
}
import * as modelsModule from "./driver/models.js";

/**
 * First start on a machine with no model configured (or --choose-model):
 * show what THIS account's picker offers and let the user choose. Saved to
 * the user config so it isn't asked again; /model and `config set model`
 * change it later. Returns what to pass to setModel.
 */
async function chooseModelInteractively(driver: GeminiDriver, current: string | undefined): Promise<string | undefined> {
  let entries: PickerEntry[];
  try {
    entries = await driver.listPickerEntries();
  } catch (err) {
    console.log(c.yellow(`Couldn't read the model picker: ${(err as Error).message.split("\n")[0]}`));
    return current;
  }
  const selectable = entries.filter((e) => !e.submenu);
  console.log(`\n${c.bold("Which model should gemini-code use?")} ${c.dim("(this account's picker, live)")}\n`);
  for (const line of pickerLines(entries)) console.log(line);
  console.log(
    `\n  ${c.dim("Type a number or a name — e.g. 2, or thinking. Enter keeps")} ${c.bold(current ?? DEFAULT_MODEL_ALIAS)}${c.dim(".")}\n` +
      `  ${c.dim(`Saved to ${userConfigPath()}; change later with /model or: gemini-code config set model <name>`)}\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = (await rl.question(c.magenta("model › "))).trim();
  } catch {
    // EOF / Ctrl+D: keep the default rather than dying before the banner.
    answer = "";
  } finally {
    rl.close();
  }
  if (!answer) return current;
  const byNumber = /^\d+$/.test(answer) ? selectable[Number(answer) - 1] : undefined;
  if (/^\d+$/.test(answer) && !byNumber) {
    console.log(c.yellow(`  no entry ${answer} — keeping ${current ?? DEFAULT_MODEL_ALIAS}`));
    return current;
  }
  if (byNumber?.locked) {
    console.log(c.yellow(`  "${byNumber.label}" is locked on this account — keeping ${current ?? DEFAULT_MODEL_ALIAS}`));
    return current;
  }
  // Only a real model is saved: one of our aliases, or text that matches
  // exactly one unlocked picker entry. Anything else (a task typed at the
  // wrong prompt, a typo) is refused rather than written to the config.
  let chosen: string | undefined = byNumber?.label;
  if (!chosen) {
    if (resolveModel(answer)) chosen = answer;
    else {
      const needle = answer.toLowerCase();
      const hits = selectable.filter((e) => !e.locked && e.label.toLowerCase().includes(needle));
      if (hits.length === 1) chosen = hits[0].label;
      else {
        console.log(
          c.yellow(
            `  "${answer.slice(0, 40)}${answer.length > 40 ? "…" : ""}" isn't a model here (${hits.length ? "ambiguous" : "no match"}) — keeping ${current ?? DEFAULT_MODEL_ALIAS}`
          )
        );
        return current;
      }
    }
  }
  // Remember an alias when one covers the label, else the label itself, so
  // the saved value keeps working across Google's version bumps.
  const alias = resolveModel(chosen) ? chosen : (resolveModelAliasFor(chosen)[0] ?? chosen);
  writeUserConfig({ ...readConfigFile(userConfigPath()), model: alias });
  console.log(`  ${c.green(glyph.ok)} model saved: ${c.bold(alias)}\n`);
  return alias;
}

/**
 * Settles where to sign in before the driver exists, because its selectors
 * and every URL it opens depend on it: --enterprise wins, then the config,
 * and with neither, a terminal is asked once.
 */
async function chooseSite(argv: string[]): Promise<void> {
  const flag = enterpriseFlag(argv);
  if (flag) {
    try {
      const link = setEnterprise(flag);
      console.log(c.dim(link ? `Gemini Enterprise: ${link.url} (saved)` : "Using gemini.google.com (saved)"));
      if (link && !link.knownHost) console.log(c.yellow(`  ${link.host} isn't a host Google is known to serve Gemini Enterprise from — continuing anyway.`));
      if (link && !link.cid) console.log(c.yellow("  That link has no /cid/<id> part; if sign-in lands somewhere else, paste the full link from the address bar."));
    } catch (err) {
      throw new Error(`--enterprise: ${(err as Error).message}`);
    }
  } else if (!enterpriseConfigured() && process.stdin.isTTY) {
    await askForEnterpriseLink();
  }
  applySiteSelectors();
}

/**
 * Loads the permission rules and asks, once per change, whether to trust a
 * project's own trust-required settings. Before anything else reads them.
 */
async function settlePermissions(): Promise<void> {
  const ask = process.stdin.isTTY
    ? async (question: string) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          return /^y(es)?$/i.test((await rl.question(`\n${question} (y/N) `)).trim());
        } finally {
          rl.close();
        }
      }
    : undefined;
  const state = await loadPermissions({ ask, log: (m) => console.error(c.yellow(m)) });
  for (const e of state.rules.errors) console.error(c.yellow(`gemini-code: permissions: ${e}`));
}

async function main() {
  await settlePermissions();
  await chooseSite(process.argv.slice(2));
  const driver = new GeminiDriver();
  // Start Chrome ourselves if it isn't already up, so the usual case is a
  // single command. Signing in stays manual, but the profile keeps the
  // session, so that's a one-time thing rather than a per-run step.
  const launched = await ensureChromeRunning((m) => console.log(c.dim(m)));
  if (launched) console.log(c.dim("Chrome is up, attaching..."));
  await driver.attach();
  await driver.ensureLoggedIn();

  const lock = acquireInstanceLock();
  if (lock.other) {
    console.log(
      c.yellow(
        `Another gemini-code (pid ${lock.other.pid}, since ${lock.other.since.slice(11, 19)}) is already running in this ` +
          `project. Both will write GEMINI-PLAN.md and take checkpoints here — fine if that's intended.`
      )
    );
  }

  // Extra workspace roots: the sibling repositories a big codebase depends on.
  for (const dir of rootsFromArgs(process.argv.slice(2))) {
    const added = addRoot(dir);
    if (!added.ok) console.log(c.yellow(`--add-dir ${dir}: ${added.error}`));
  }

  // Gather durable context BEFORE starting the thread, so the primer can
  // carry it in one shot instead of costing tool calls later.
  const tree = await buildProjectTree();
  const created = await ensureMemoryFile(tree);
  const memory = await readMemory();
  const gatherRoots = async () => {
    const roots: { name: string; display: string; dir: string; tree: string }[] = [];
    const rootDocs: ProjectDoc[] = [];
    for (const r of extraRoots()) {
      // Shallow: the model finds its way with find_files / search_code.
      const display = displayPath(r.dir);
      roots.push({ name: r.name, display, dir: r.dir, tree: await buildProjectTree({ root: r.dir, maxEntries: 120, maxDepth: 3 }) });
      rootDocs.push(...(await collectRootSummaryDocs(r.dir, display)));
    }
    return { roots, rootDocs };
  };
  let { roots, rootDocs } = await gatherRoots();
  const docs = [...(await collectProjectDocs()), ...rootDocs];
  // An unfinished plan means the last run was cut short — carry it into
  // context so this session continues rather than starting over.
  const resumable = await findResumablePlan();

  // Brand the main tab too (no close guard — it's the user's own tab and
  // it navigates, which a beforeunload prompt would interfere with).
  await driver.markTab("🤖 gemini-code · main");

  // A Gem is REFERENCE by default: the coding thread stays a plain Gemini chat
  // and the agent consults the Gem through ask_gem when it needs project
  // background. Running the whole session inside the Gem (--gem-mode inside)
  // hands every turn to the Gem's own instructions too, which is rarely what
  // you want from a Gem that exists to answer questions.
  //
  // Either way, failing to find the Gem is a warning, not a dead session.
  const wantedGem = gemFlag(process.argv.slice(2)) ?? process.env.GEMINI_CODE_GEM;
  const gemMode = gemModeFlag(process.argv.slice(2));
  let gemConsultant: { tool: ToolDefinition; close: () => Promise<void> } | undefined;
  let referenceGem: Gem | undefined;
  if (wantedGem) {
    try {
      if (gemMode === "inside") {
        await driver.useGem(wantedGem);
      } else {
        // Resolved up front so a wrong name fails now, not mid-task, and so
        // the banner can name it. The tab itself opens on first use.
        referenceGem = await driver.findGem(wantedGem);
        gemConsultant = createAskGemTool({
          gem: referenceGem,
          openTab: () => driver.spawnGemTab(referenceGem!),
          log: (msg) => console.log(c.dim(msg)),
        });
      }
    } catch (err) {
      console.log(c.yellow(`Couldn't use Gem "${wantedGem}": ${(err as Error).message.split("\n")[0]}`));
    }
  }

  // Temporary chats by default: the agent's threads are tool-call noise that
  // would otherwise bury the user's own conversations in Gemini's sidebar and
  // feed its personalisation. GEMINI_CODE_TEMPORARY_CHAT=0 keeps them.
  // Gemini Enterprise has no Temporary chat: its history is the organisation's.
  driver.temporaryChats = !isEnterprise() && process.env.GEMINI_CODE_TEMPORARY_CHAT !== "0";
  await driver.newConversation();
  const temporary = driver.temporaryChats ? await driver.isTemporaryChat() : false;

  // Default the model (env override: GEMINI_CODE_MODEL=pro npm run dev).
  const argv = process.argv.slice(2);
  let startModel = modelFlag(argv) ?? process.env.GEMINI_CODE_MODEL;
  // No model anywhere (fresh machine), or asked to: show the live picker.
  if (process.stdin.isTTY && !isEnterprise() && (chooseModelFlag(argv) || !startModel)) {
    startModel = await chooseModelInteractively(driver, startModel);
  }
  startModel ??= DEFAULT_MODEL_ALIAS;
  const wantLevel = resolveThinkingLevel(process.env.GEMINI_CODE_THINKING_LEVEL) ?? DEFAULT_THINKING_LEVEL;
  let levelNote = "";
  const wantThinking = process.env.GEMINI_CODE_THINKING
    ? /^(on|true|yes|1)$/i.test(process.env.GEMINI_CODE_THINKING)
    : DEFAULT_EXTENDED_THINKING;
  let modelName = "unknown";
  // Gemini Enterprise picks its own model per organisation and has no
  // consumer-style picker to drive, so leave it alone rather than spend a
  // minute timing out on menus that aren't there.
  if (isEnterprise()) modelName = `Gemini Enterprise's own ${c.dim("(its model isn't switched from here)")}`;
  else try {
    modelName = await driver.setModelWithFallback(startModel, {
      onFallback: (wanted, got) =>
        console.log(c.yellow(`${wanted} isn't in this account's model picker — using ${got} instead.`)),
    });
    // Extended thinking stacks on top of the base model and slows it down,
    // so it's off unless asked for (GEMINI_CODE_THINKING=on or /thinking on).
    await driver.setExtendedThinking(wantThinking).catch(() => undefined);
    // The Thinking level submenu (where the picker has one) is what decides
    // how hard Auto thinks; the account default is Low.
    try {
      await driver.setThinkingLevel(wantLevel);
      const level = wantLevel;
      levelNote = `\n  ${c.dim("thinking")} level ${level}`;
    } catch {
      // No such submenu on this picker — nothing to set.
    }
    const label = await driver.getCurrentModel().catch(() => "");
    if (label && label !== "unknown") modelName = `${modelName} ${c.dim(`(picker: ${label})`)}`;
  } catch (err) {
    modelName = await driver.getCurrentModel();
    console.log(c.yellow(`Couldn't set model to "${startModel}": ${(err as Error).message.split("\n")[0]}`));
  }

  // An interrupted task: reopen its Gemini thread when it still exists, so
  // "continue" picks up with the whole conversation intact. A temporary chat
  // or a deleted thread falls back to a fresh thread primed from the journal.
  let resumedInThread = false;
  if (resumable?.thread && (await driver.openThread(resumable.thread).catch(() => false))) {
    resumedInThread = true;
  }

  // Banner, Claude Code style.
  console.log(`
${c.magenta(glyph.star)} ${c.bold("gemini-code")} ${c.dim(`v${VERSION} — Claude-Code-style agent on the Gemini web UI`)}

  ${c.dim("cwd")}     ${path.basename(process.cwd())}
  ${c.dim("site")}    ${isEnterprise() ? `Gemini Enterprise ${c.dim(enterpriseLink()!.url)}` : `gemini.google.com ${c.dim("(/enterprise <link> for Gemini Enterprise)")}`}
  ${c.dim("model")}   ${modelName}${levelNote}${
    driver.currentGem
      ? `\n  ${c.dim("gem")}     ${driver.currentGem.name} ${c.dim("(the whole session runs inside it)")}`
      : referenceGem
        ? `\n  ${c.dim("gem")}     ${referenceGem.name} ${c.dim("(reference — ask_gem consults it)")}`
        : ""
  }
  ${c.dim("context")} project tree (${tree.split("\n").length} lines)${memory ? `, ${MEMORY_FILENAME}` : ""}${docs.length ? `, ${docs.length} doc${docs.length > 1 ? "s" : ""} (${docs.map((d) => d.path).join(", ")})` : ""}
  ${c.dim("tools")}   ${tools.filter((t) => !t.deferred).map((t) => t.name).join(", ")}, ${c.dim("and more loaded on demand")}
  ${c.dim("workers")} up to ${MAX_PARALLEL_WORKERS} parallel Gemini tabs${
    roots.length ? `\n  ${c.dim("roots")}   + ${roots.map((r) => r.display).join(", ")} ${c.dim("(--add-dir)")}` : ""
  }
  ${c.dim("threads")} ${temporary ? "temporary chats — not saved to your Gemini history" : driver.temporaryChats ? c.yellow("couldn't switch to Temporary chat — threads will be saved to your history") : "saved to your Gemini history (temporaryChat=false)"}
  ${c.dim("approve")} ${
    autoApproved("edit") && autoApproved("command") && autoApproved("network")
      ? c.yellow("everything runs without asking (autoApprove=all)")
      : autoApproved("edit")
        ? `edits run; ${autoApproved("command") ? "commands run; " : "commands ask; "}network ${autoApproved("network") ? "runs" : "asks"}`
        : "y/N before every edit, command and request"
  }
  ${c.dim("mode")}    ${ORCHESTRATOR_MODE ? "orchestrator — main tab plans & validates, workers implement" : "solo — one tab does everything"}
${created ? `\n  ${c.green(glyph.ok)} created ${MEMORY_FILENAME} for durable project memory` : ""}${
    resumable
      ? `\n  ${c.yellow(glyph.resume)} unfinished task in ${PLAN_FILENAME} (${resumable.status}): "${resumable.task.slice(0, 70)}${resumable.task.length > 70 ? "…" : ""}"` +
        `\n    ${resumedInThread ? "its Gemini thread is reopened" : "its thread is gone — a fresh one will be primed from the journal"}; type ${c.bold("continue")} (or /resume) to pick it up, or /plan clear to drop it`
      : ""
  }
${c.dim("Type a task, or /help for commands. Ctrl+V pastes an image; typing while a task runs steers it.")}
`);

  const journal = new PlanJournal();
  const mcp = new McpManager();
  let skills = await skillSummaries();
  const makeMainSession = (mem: string | undefined, resumePlan?: string) =>
    createMainSession({
      driver,
      context: { tree, memory: mem, docs: [...docs.filter((d) => !rootDocs.includes(d)), ...rootDocs], resumePlan, roots, skills },
      journal,
      modelAlias: () => startModel,
      gemTool: gemConsultant?.tool,
      mcpTools: () => mcp.tools,
      orchestrator: ORCHESTRATOR_MODE,
      log: (msg) => console.log(msg),
    });

  // The resume plan is injected once, into the first session only — after
  // that it's either finished or superseded by the new run's own journal.
  let session = makeMainSession(memory, resumedInThread ? undefined : resumable?.raw);
  if (resumable) journal.resume(resumable);
  if (resumedInThread) session.continueInThread();
  /** Until the first task runs, a bare "continue" means the interrupted one. */
  let resumePending = !!resumable;

  /** Images staged by Ctrl+V, /paste or /image, sent with the next task. */
  let stagedImages: string[] = [];
  const stageImage = (file: string) => {
    stagedImages.push(file);
    console.log(`  ${c.green(glyph.ok)} attached ${path.basename(file)} — send a task to include it\n`);
  };

  // Leave the journal marked interrupted if we're killed mid-task, so the
  // next run knows there's work to pick up.
  /**
   * Ctrl+C: once cancels the running task (Gemini is told to stop, the
   * journal is marked interrupted, the prompt comes back); twice — or with
   * no task running — quits. Same shape as Claude Code, and the only way
   * out of a task that is stuck without losing the session.
   */
  let taskAbort: AbortController | undefined;
  const onSignal = async () => {
    if (taskAbort && !taskAbort.signal.aborted) {
      taskAbort.abort();
      console.log(c.yellow("\n  cancelling the task… (Ctrl+C again to quit)"));
      await driver.stopGenerating().catch(() => false);
      return;
    }
    await journal.markInterrupted("session terminated");
    await gemConsultant?.close();
    await mcp.close();
    // Don't leave a dev server holding its port after we're gone.
    killAllBackgroundProcesses();
    releaseInstanceLock();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  /**
   * Line queue rather than rl.question().
   *
   * With piped stdin (`printf 'a\nb\n' | npm run dev`) readline delivers all
   * lines up front and then closes at EOF. Awaiting question() per line
   * either hangs forever after close, or drops every line after the first.
   * Buffering 'line' events and draining them keeps interactive typing and
   * scripted input both working.
   */
  const queued: string[] = [];
  let pending: ((line: string | null) => void) | null = null;
  let inputDone = false;
  /** Set while a confirmation prompt is waiting for an answer. */
  let awaitingAnswer: ((line: string) => void) | null = null;

  // GEMINI_CODE_DEBUG_INPUT=1 traces what readline receives — for diagnosing
  // a terminal whose keystrokes don't seem to arrive.
  const traceInput = process.env.GEMINI_CODE_DEBUG_INPUT === "1";
  if (traceInput) process.stdin.on("data", (d: Buffer) => process.stderr.write(`[input data ${JSON.stringify(d.toString())}]\n`));

  rl.on("line", (line) => {
    if (traceInput) process.stderr.write(`[input line ${JSON.stringify(line)} awaiting=${!!awaitingAnswer} pending=${!!pending}]\n`);
    // A confirmation has first claim on the line. Without this the answer
    // would ALSO be queued and later sent to Gemini as a task — typing "y"
    // to approve a write would become a message saying "y".
    if (awaitingAnswer) {
      const answer = awaitingAnswer;
      awaitingAnswer = null;
      answer(line);
      return;
    }
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });

  // Confirmation prompts borrow this readline rather than opening their own,
  // which would double-echo every keystroke and race for the same input.
  setAsker((question) => {
    process.stdout.write(question);
    return new Promise<string>((resolve) => {
      awaitingAnswer = resolve;
    });
  });
  rl.on("close", () => {
    inputDone = true;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(null);
    }
  });

  /**
   * Ctrl+V pastes an image, NOT Cmd+V.
   *
   * macOS terminals handle Cmd+V themselves and only ever deliver clipboard
   * *text* to the process — an image paste arrives as nothing at all, so
   * there is no keystroke to hook. Ctrl+V does reach us (as \x16), so that's
   * the binding, same as Claude Code.
   */
  let pasteBusy = false;
  const onPasteKey = async () => {
    if (pasteBusy) return;
    pasteBusy = true;
    try {
      const { path: img, reason } = await readClipboardImageDetailed();
      process.stdout.write("\n");
      if (img) {
        stageImage(img);
      } else {
        console.log(`  ${c.yellow(reason ?? "no image on the clipboard")}\n`);
      }
    } finally {
      pasteBusy = false;
      process.stdout.write(c.magenta(glyph.prompt));
    }
  };

  if (process.stdin.isTTY) {
    // Raw mode is what makes Ctrl+V reach us at all. Without it the terminal
    // keeps its own line discipline, where Ctrl+V is the "literal next"
    // key (VLNEXT): the terminal swallows it to escape the FOLLOWING
    // keystroke, and the process never sees it. Verified in a real pty —
    // ordinary letters arrived, Ctrl+V never did, so paste looked dead while
    // /paste worked fine.
    emitKeypressEvents(process.stdin, rl);
    process.stdin.setRawMode(true);
    // Raw mode also stops the kernel turning Ctrl+C into SIGINT, so readline
    // reports it instead — without this, Ctrl+C would no longer quit.
    rl.on("SIGINT", () => void onSignal());
    // Leave the terminal usable if we exit while it's in raw mode.
    process.on("exit", () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    });

    process.stdin.on("keypress", (_str, key) => {
      if (key?.ctrl && key.name === "v") void onPasteKey();
    });
  }

  const nextLine = (): Promise<string | null> => {
    if (queued.length) return Promise.resolve(queued.shift()!);
    if (inputDone) return Promise.resolve(null);
    process.stdout.write(c.magenta(glyph.prompt));
    return new Promise<string | null>((resolve) => {
      pending = resolve;
    });
  };

  // Here rather than with the rest of startup, because a project's servers
  // need approving, and that needs the prompt wired up. Nothing has been sent
  // yet, so the session can be remade with their tools.
  await mcp.connectAll((msg) => console.log(c.dim(msg)));
  if (mcp.tools.length) session = makeMainSession(memory, resumable?.raw);

  try {
    while (true) {
      const input = await nextLine();
      if (input === null) break;
      const task = input.trim();
      if (!task) continue;
      if (["exit", "quit", "/exit", "/quit"].includes(task.toLowerCase())) break;

      // Dragging a file into most terminals inserts its (quoted) path —
      // treat a bare image path as "attach this" rather than as a task.
      const dropped = normalizeDroppedPath(task);
      if (isImagePath(dropped) && existsSync(dropped)) {
        stageImage(dropped);
        continue;
      }

      if (task.startsWith("/")) {
        const [cmd, ...rest] = task.slice(1).split(/\s+/);
        const arg = rest.join(" ");
        try {
          if (isEnterprise() && ["model", "models", "level", "thinking"].includes(cmd.toLowerCase())) {
            console.log(`  ${c.dim(`Gemini Enterprise chooses its own model; /${cmd.toLowerCase()} only drives gemini.google.com's picker.`)}\n`);
            continue;
          }
          switch (cmd.toLowerCase()) {
            case "help":
              console.log(`\n${helpText()}\n`);
              break;

            case "permissions": {
              const [sub, ...more] = arg.split(/\s+/);
              if (sub === "check") console.log(`\n${permissionsCheck(more.join(" "), SHELL_FLAVOUR)}\n`);
              else if (sub === "reset") console.log(`  ${permissionsReset()}\n`);
              else console.log(`\n${permissionsReport()}\n`);
              break;
            }

            case "enterprise": {
              if (!arg) {
                const link = enterpriseLink();
                console.log(
                  link
                    ? `\n  signing in at ${c.bold("Gemini Enterprise")}: ${link.url}${link.cid ? c.dim(` (cid ${link.cid})`) : ""}\n  ${c.dim("/enterprise <link> changes it, /enterprise off goes back to gemini.google.com")}\n`
                    : `\n  signing in at ${c.bold("gemini.google.com")}\n  ${c.dim("/enterprise <link> switches to Gemini Enterprise, e.g. /enterprise https://vertexaisearch.cloud.google.com/home/cid/<id>")}\n`
                );
                break;
              }
              const link = setEnterprise(arg);
              for (const note of applySiteSelectors()) console.log(c.yellow(`  selectors: ${note}`));
              driver.temporaryChats = !link && process.env.GEMINI_CODE_TEMPORARY_CHAT !== "0";
              // A different app: open it in this tab, wait out the sign-in,
              // and start a thread there with the primer re-sent.
              await driver.newConversation().catch(() => undefined);
              await driver.ensureLoggedIn();
              await driver.newConversation();
              forgetAll();
              skills = await skillSummaries();
              session = makeMainSession(await readMemory());
              console.log(
                `  ${c.green(glyph.ok)} now on ${siteName()}${link ? ` (${link.url})` : ""} — saved for next time; fresh thread\n` +
                  (link && !link.knownHost ? c.yellow(`  ${link.host} isn't a host Google is known to use for Gemini Enterprise.\n`) : "")
              );
              break;
            }

            case "model":
              if (!arg) {
                console.log(`\n  current: ${c.bold(await driver.getCurrentModel())}\n\n${modelHelp()}\n`);
              } else {
                let wanted = arg;
                if (/^\d+$/.test(arg)) {
                  const entry = (await driver.listPickerEntries()).filter((e) => !e.submenu)[Number(arg) - 1];
                  if (!entry) throw new Error(`no model number ${arg} — /models lists them`);
                  wanted = entry.label;
                }
                const name = await driver.setModelWithFallback(wanted, {
                  onFallback: (w, g) => console.log(c.yellow(`  ${w} isn't in this picker — using ${g}`)),
                });
                console.log(`  ${c.green(glyph.ok)} model: ${c.bold(name)} ${c.dim(`(picker: ${await driver.getCurrentModel()})`)}\n`);
              }
              break;

            case "models": {
              process.stdout.write(c.dim("  reading the picker...\r"));
              const entries = await driver.listPickerEntries();
              console.log(`  ${c.bold("Models in this account's picker")} ${c.dim("(/model <number or label>)")}`);
              for (const line of pickerLines(entries)) console.log(line);
              console.log("");
              break;
            }

            case "level": {
              const want = resolveThinkingLevel(arg);
              if (arg && !want) {
                console.log(`  usage: /level ${THINKING_LEVELS.join("|")}\n`);
                break;
              }
              if (want) await driver.setThinkingLevel(want);
              const level = want ?? (await driver.getThinkingLevel()) ?? "not offered by this picker";
              console.log(`  ${c.green(glyph.ok)} thinking level: ${c.bold(level)}\n`);
              break;
            }

            case "thinking": {
              const want = /^(on|true|yes|1)$/i.test(arg);
              if (!arg) {
                console.log(`\n  current: ${c.bold(await driver.getCurrentModel())}\n  usage: /thinking on|off\n`);
                break;
              }
              await driver.setExtendedThinking(want);
              console.log(`  ${c.green(glyph.ok)} ${await driver.getCurrentModel()}\n`);
              break;
            }

            case "gems": {
              process.stdout.write(c.dim("  reading your Gems...\r"));
              try {
                const gems = await driver.listGems();
                if (!gems.length) {
                  console.log(`  ${c.yellow("no Gems found on this account")}\n`);
                  break;
                }
                console.log(`  ${c.bold("Gems")} ${c.dim("(use with /gem <name>)")}`);
                for (const g of gems) {
                  const active = driver.currentGem?.id === g.id || referenceGem?.id === g.id;
                  const mark = active ? c.green(" ← in use") : "";
                  console.log(`    ${c.cyan(g.name)} ${c.dim(g.id)}${mark}`);
                }
                console.log("");
              } catch (err) {
                console.log(`  ${c.red("couldn't list Gems")}: ${(err as Error).message.split("\n")[0]}\n`);
              }
              break;
            }

            case "gem": {
              if (!arg) {
                const active = driver.currentGem ?? referenceGem;
                console.log(
                  active
                    ? `  ${c.green(glyph.ok)} Gem ${c.bold(active.name)} ${c.dim(
                        driver.currentGem ? "(the whole session runs inside it)" : "(reference — ask_gem consults it)"
                      )}\n`
                    : `  ${c.dim("no Gem in use — /gems lists them, /gem <name> picks one")}\n`
                );
                break;
              }
              if (/^(off|none|clear)$/i.test(arg)) {
                await gemConsultant?.close();
                gemConsultant = undefined;
                referenceGem = undefined;
                await driver.clearGem();
                await driver.newConversation();
                session = makeMainSession(await readMemory());
                console.log(`  ${c.green(glyph.ok)} no Gem in use ${c.dim("(fresh thread)")}\n`);
                break;
              }
              try {
                if (gemMode === "inside") {
                  const gem = await driver.useGem(arg);
                  console.log(`  ${c.green(glyph.ok)} session now runs inside Gem ${c.bold(gem.name)}\n`);
                } else {
                  const gem = await driver.findGem(arg);
                  // Drop the previous Gem's tab before pointing at another,
                  // or its thread lingers with nothing using it.
                  await gemConsultant?.close();
                  referenceGem = gem;
                  gemConsultant = createAskGemTool({
                    gem,
                    openTab: () => driver.spawnGemTab(gem),
                    log: (msg) => console.log(c.dim(msg)),
                  });
                  console.log(
                    `  ${c.green(glyph.ok)} ask_gem now consults ${c.bold(gem.name)} ${c.dim("(reference only)")}\n`
                  );
                }
                // The tool list changed and a Gem applies per thread, so the
                // next task needs a fresh thread and a re-sent primer.
                await driver.newConversation();
                session = makeMainSession(await readMemory());
              } catch (err) {
                console.log(`  ${c.red("couldn't use that Gem")}: ${(err as Error).message.split("\n")[0]}\n`);
              }
              break;
            }

            case "roots": {
              console.log(`  ${c.bold("project")} ${process.cwd()}`);
              for (const r of extraRoots()) console.log(`  ${c.cyan(displayPath(r.dir).padEnd(20))} ${r.dir}`);
              console.log(`  ${c.dim("add one with /add-dir <path>, or start with --add-dir")}\n`);
              break;
            }

            case "add-dir":
            case "adddir": {
              if (!arg) {
                console.log("  usage: /add-dir <path-to-another-repo>\n");
                break;
              }
              const added = addRoot(arg);
              if (!added.ok) {
                console.log(`  ${c.red("can't add")}: ${added.error}\n`);
                break;
              }
              if (!added.added) {
                console.log(`  ${c.dim(`${displayPath(added.root.dir)} is already in the workspace`)}\n`);
                break;
              }
              ({ roots, rootDocs } = await gatherRoots());
              // The primer describes the roots, so the next task needs a fresh thread.
              await driver.newConversation();
              forgetAll();
              session = makeMainSession(await readMemory());
              console.log(`  ${c.green(glyph.ok)} added ${c.bold(displayPath(added.root.dir))} ${c.dim(`(${added.root.dir}; fresh thread)`)}\n`);
              break;
            }

            case "resume": {
              const plan = await findResumablePlan();
              if (!plan) {
                console.log(`  ${c.dim(`nothing to resume — ${PLAN_FILENAME} has no unfinished task`)}\n`);
                break;
              }
              // Run it as a task right away.
              queued.unshift(resumeTaskText(plan));
              journal.resume(plan);
              resumePending = false;
              break;
            }

            case "compact": {
              const note = await session.compactNow((m) => console.log(m));
              if (note === undefined) {
                console.log(`  ${c.dim("nothing to compact yet — the thread hasn't started")}\n`);
              } else {
                console.log(`  ${c.green(glyph.ok)} fresh thread; handoff note kept (${note.length} chars). Next task continues from it.\n`);
              }
              break;
            }

            case "clear":
            case "new":
              await driver.newConversation();
              forgetAll();
              // A fresh thread has no memory of the primer, so the next task
              // must re-send it — that's what a new AgentSession does.
              skills = await skillSummaries();
              session = makeMainSession(await readMemory());
              console.log(`  ${c.green(glyph.ok)} fresh conversation thread\n`);
              break;

            case "paste": {
              const { path: img, reason } = await readClipboardImageDetailed();
              if (!img) {
                console.log(
                  `  ${c.yellow(reason ?? "no image on the clipboard")}\n` +
                    `  ${c.dim("copy a screenshot (Cmd+Ctrl+Shift+4), then Ctrl+V or /paste — or /image <path>")}\n`
                );
                break;
              }
              stageImage(img);
              break;
            }

            case "image": {
              if (!arg) {
                console.log("  usage: /image <path-to-image>\n");
                break;
              }
              const file = normalizeDroppedPath(arg);
              if (!existsSync(file)) {
                console.log(`  ${c.red("no such file")}: ${file}\n`);
                break;
              }
              if (!isImagePath(file)) {
                console.log(`  ${c.yellow("that doesn't look like an image")}: ${file}\n`);
                break;
              }
              stageImage(file);
              break;
            }

            case "undo": {
              if (arg === "list") {
                const saved = await checkpoints.list().catch((err: Error) => {
                  console.log(`  ${c.yellow("!")} ${err.message}\n`);
                  return undefined;
                });
                if (!saved) break;
                if (!saved.length) {
                  console.log(`  ${c.dim("nothing to undo")}\n`);
                  break;
                }
                console.log(`  ${c.bold("Tasks /undo can revert, newest first")} ${c.dim("(each /undo goes back one)")}`);
                for (const [i, ck] of [...saved].reverse().entries()) {
                  console.log(`  ${c.bold(String(i + 1))}. ${ck.task.slice(0, 70)} ${c.dim(new Date(ck.at).toLocaleString())}`);
                  for (const s of ck.states) {
                    const bad = !["restore", "already-original", "unknown"].includes(s.state);
                    console.log(`     ${s.file} ${bad ? c.yellow(`— ${STATE_TEXT[s.state]}`) : c.dim(`— ${STATE_TEXT[s.state]}`)}`);
                  }
                }
                console.log("");
                break;
              }
              const force = /(^|\s)--force\b/.test(arg);
              const result = await checkpoints.undoLast({ force });
              console.log(`  ${result.ok ? c.green(glyph.ok) : c.yellow("!")} ${result.message}\n`);
              break;
            }

            case "plan": {
              const current = await readPlan();
              if (!current) {
                console.log(`  ${c.dim(`no ${PLAN_FILENAME} yet — it's written as tasks run`)}\n`);
                break;
              }
              if (arg === "clear") {
                await clearPlan();
                console.log(`  ${c.green(glyph.ok)} cleared ${PLAN_FILENAME}\n`);
                break;
              }
              console.log(`\n${current.raw}\n`);
              break;
            }

            case "memory": {
              const current = await readMemory();
              console.log(`\n${c.dim(`--- ${MEMORY_FILENAME} ---`)}\n${current ?? c.dim("(empty)")}\n`);
              break;
            }

            case "remember":
              if (!arg) {
                console.log("  usage: /remember <note>\n");
                break;
              }
              await appendMemory(arg);
              console.log(`  ${c.green(glyph.ok)} saved to ${MEMORY_FILENAME}\n`);
              break;

            case "mcp":
              if (!mcp.status.length) console.log(`  ${c.dim(`no MCP servers — add them to ${MCP_CONFIG_FILENAME}`)}\n`);
              for (const s of mcp.status) {
                console.log(`  ${c.cyan(s.name)} ${s.state}, ${s.tools.length} tool(s)${s.error ? ` — ${s.error}` : ""}`);
              }
              break;

            case "tools":
              console.log("");
              for (const t of tools) console.log(`  ${c.cyan(t.name)}\n    ${c.dim(t.description)}`);
              console.log("");
              break;

            default:
              console.log(`  ${c.yellow(`unknown command /${cmd}`)} — try /help\n`);
          }
        } catch (err) {
          console.error(`  ${c.red((err as Error).message)}\n`);
        }
        continue;
      }

      // After a crash, "continue" on its own means the interrupted task.
      let taskText = task;
      if (resumePending && /^(continue|resume|go on|carry on|keep going|pick up( where you left off)?|finish it)[.! ]*$/i.test(task)) {
        const plan = await findResumablePlan();
        if (plan) {
          taskText = resumeTaskText(plan);
          console.log(`  ${c.dim(`continuing: ${plan.task.slice(0, 90)}`)}`);
        }
      }
      resumePending = false;

      try {
        const attachments = stagedImages;
        stagedImages = [];
        checkpoints.begin(task);
        taskAbort = new AbortController();
        const answer = await session.runTask(taskText, {
          attachments,
          cancelSignal: taskAbort.signal,
          onEvent: (msg) => console.log(msg),
          // Anything typed while the task runs steers it on the next turn,
          // rather than sitting in the queue until the task is over.
          // Slash commands are left queued so they still run as commands.
          getSteering: () => {
            // With piped stdin every line is already here, so "typed while
            // the task ran" means nothing — they are the NEXT tasks, in
            // order. Folding them in as steering hijacked the task in a
            // real run.
            if (!process.stdin.isTTY) return [];
            const steer: string[] = [];
            for (let i = queued.length - 1; i >= 0; i--) {
              const line = queued[i].trim();
              if (line && !line.startsWith("/")) {
                steer.unshift(line);
                queued.splice(i, 1);
              }
            }
            return steer;
          },
        });
        taskAbort = undefined;
        await checkpoints.commit();
        console.log(`\n${answer}\n`);
      } catch (err) {
        taskAbort = undefined;
        await checkpoints.commit(); // keep snapshots from a failed run too
        // One failed task shouldn't kill the whole REPL session — report it
        // and keep the prompt alive so the browser/thread stays usable.
        console.error(`\n  ${c.red(glyph.bad)} ${(err as Error).message}\n`);
      }
    }
  } finally {
    setAsker(undefined);
    // Close the Gem's tab with the session that opened it.
    await gemConsultant?.close();
    await mcp.close();
    rl.close();
    killAllBackgroundProcesses();
    releaseInstanceLock();
    await driver.close();
  }
}

const USAGE = `gemini-code — a Claude-Code-style agent on the Gemini web UI

Usage:
  gemini-code                 start the agent in the current directory
  gemini-code --model <name>  start on a model: an alias (thinking, fast, pro, auto…) or a
                              label from your picker, e.g. --model "3.8 Thinking"
  gemini-code --choose-model  list this account's live picker and choose (also asked on a
                              machine with no model configured yet)
  gemini-code --add-dir <p>   include another repository in the workspace (repeatable):
                              the agent can read, search, edit and run commands there too
  gemini-code --gem <name>    consult one of your Gems for project knowledge (ask_gem)
  gemini-code --gem <name> --gem-mode inside
                              run the whole session inside the Gem instead
  gemini-code serve           run an OpenAI-compatible API on http://127.0.0.1:8787/v1
      --port <n>              port (default 8787)
      --host <addr>           address to bind (default 127.0.0.1; others need --api-key)
      --tabs <n>              parallel Gemini tabs = concurrent requests (default 2)
      --api-key <key>         require "Authorization: Bearer <key>"
      --cors-origin <url>     let a browser app at <url> call it (repeatable)
      --queue <n>             requests that may wait for a busy tab (default 8); more get 429
      --queue-timeout <s>     longest wait for a tab before a 503 (default 120)
      --remote-images on|off  fetch http(s) image_url parts (default on; data: URLs always work)
      --private-images on|off allow image hosts on private/local addresses (default off)
  gemini-code skills list     show the skills Gemini can use
  gemini-code skills add <owner/repo or GitHub URL> [--all] [--only=a,b]
                              install Claude-compatible skills from GitHub
  gemini-code skills remove <name>
                              remove an installed skill
  gemini-code bridge          run the agent over JSON lines on stdin/stdout (the desktop UI uses this)
  gemini-code --enterprise <link>
                              sign in at your Gemini Enterprise link, e.g.
                              https://vertexaisearch.cloud.google.com/home/cid/<id> (saved; "off" undoes it)
  gemini-code open-chrome [<link>]
                              open a normal Chrome window to sign into (do this first); with a
                              Gemini Enterprise link, saves it and opens it
  gemini-code probe           on the signed-in tab, report which selectors match (for calibrating
                              Gemini Enterprise) and save a page outline to ~/.gemini-code/probe.txt
  gemini-code login           check that the signed-in Chrome is reachable
  gemini-code doctor          check Node, Chrome, the profile, PATH and the sign-in state
  gemini-code config          show saved defaults; "config set model pro" saves one
  gemini-code --help          this message

Settings (environment, or "gemini-code config set <key> <value>", or <project>/.gemini-code.json):
  GEMINI_CODE_ENTERPRISE_URL  your Gemini Enterprise link, or off for gemini.google.com (config key: enterprise)
  GEMINI_CODE_MODEL           thinking (default) | fast | fastest | pro
  GEMINI_CODE_THINKING_LEVEL  low | medium | high (default) — the picker's Thinking level
  GEMINI_CODE_THINKING        on | off — the Extended thinking toggle, where the picker has one
  GEMINI_CODE_GEM             Gem to start in, by name or id (same as --gem)
  GEMINI_CODE_MAX_WORKERS     parallel worker tabs (default 3)
  GEMINI_CODE_ADD_DIRS        extra workspace roots, PATH-style separated (same as --add-dir)
  GEMINI_CODE_AUTO_APPROVE    edits | edits,commands | all — what runs without a y/N (default: ask for all)
  GEMINI_CODE_COMPACT_TURNS   exchanges per thread before a context reset with handoff (default 40)
  GEMINI_CODE_TEMPORARY_CHAT  0 keeps the agent's threads in your Gemini history (default: Temporary chats)
  GEMINI_CODE_PROFILE         Chrome profile dir (default ~/.gemini-code/profile)
  GEMINI_CODE_API_KEY         same as serve --api-key
  GEMINI_CODE_API_PORT, GEMINI_CODE_API_HOST, GEMINI_CODE_API_TABS, GEMINI_CODE_API_CORS
  GEMINI_CODE_API_QUEUE, GEMINI_CODE_API_QUEUE_TIMEOUT, GEMINI_CODE_API_REMOTE_IMAGES, GEMINI_CODE_API_PRIVATE_IMAGES
                              same as serve --queue, --queue-timeout, --remote-images, --private-images
`;

/** `gemini-code skills`: installing is the user's to do, so it's a command, not a tool. */
async function skillsCommand(): Promise<void> {
  const [action, ...rest] = process.argv.slice(3);
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const [target] = rest.filter((arg) => !arg.startsWith("--"));

  if (action === "list" || !action) {
    const installed = await listInstalled();
    const others = [...(await findSkills()).values()].filter((s) => !installed.some((i) => i.name === s.name));
    if (!installed.length && !others.length) console.log(`No skills yet. Add one with: gemini-code skills add <github repo>`);
    for (const s of installed) console.log(`${c.cyan(s.name)} ${c.dim(s.source ?? "")}\n  ${s.description}`);
    for (const s of others) console.log(`${c.cyan(s.name)} ${c.dim(`(${s.source})`)}\n  ${s.description}`);
    return;
  }

  if (action === "remove" && target) {
    await removeSkill(target);
    console.log(`  ${c.green("✓")} removed ${target}`);
    return;
  }

  if (action === "add" && target) {
    const only = flags.find((flag) => flag.startsWith("--only="))?.slice("--only=".length).split(",");
    const found = await discoverSkills(target);
    if (!found.length) throw new Error(`No skills found in ${target}. A skill is a folder with a SKILL.md.`);
    if (found.length > 1 && !only && !flags.includes("--all")) {
      console.log(`${target} has ${found.length} skills:\n`);
      for (const s of found) console.log(`  ${c.cyan(s.name)}\n    ${s.description.slice(0, 100)}`);
      console.log(`\nChoose with --only=<name>,<name> or install them all with --all.`);
      process.exitCode = 1;
      return;
    }
    const installed = await installSkills(target, only ?? found.map((s) => s.name));
    for (const s of installed) {
      const scripts = s.scripts.length ? ` ${c.yellow(`(${s.scripts.length} script${s.scripts.length > 1 ? "s" : ""} it may ask to run)`)}` : "";
      console.log(`  ${c.green("✓")} ${s.name}${scripts}`);
    }
    return;
  }

  console.error(`Usage:\n  gemini-code skills list\n  gemini-code skills add <owner/repo or GitHub URL> [--all] [--only=a,b]\n  gemini-code skills remove <name>`);
  process.exitCode = 1;
}

/** `gemini-code serve`: the OpenAI-compatible API. */
async function serve(): Promise<void> {
  await settlePermissions();
  const args = serveArgs(process.argv.slice(3));

  const driver = new GeminiDriver();
  const launched = await ensureChromeRunning((m) => console.log(c.dim(m)));
  if (launched) console.log(c.dim("Chrome is up, attaching..."));
  await driver.attach();
  await driver.ensureLoggedIn();
  await driver.markTab("🔌 gemini-code · api 1");

  const { url, close } = await startServer({
    driver,
    ...args,
    log: (msg) => console.log(`${c.dim(new Date().toLocaleTimeString())} ${msg}`),
  });

  const key = args.apiKey ? "<your key>" : "anything";
  console.log(`
${c.magenta(glyph.star)} ${c.bold("gemini-code")} ${c.dim(`v${VERSION} — OpenAI-compatible API on your Gemini web session`)}

  ${c.dim("base url")}  ${c.bold(url)}
  ${c.dim("models")}    ${API_MODELS.map((m) => (m.alias === DEFAULT_MODEL_ALIAS ? `${m.id} (default)` : m.id)).join(", ")}
  ${c.dim("tabs")}      up to ${args.tabs} parallel (one request per tab); ${args.maxQueue} may wait up to ${args.queueTimeoutMs / 1000}s, then 429/503
  ${c.dim("images")}    ${args.remoteImages ? `http(s) URLs fetched${args.privateImages ? " — private hosts ALLOWED" : ", private/local addresses refused"}` : "data: URLs only (--remote-images off)"}
  ${c.dim("auth")}      ${args.apiKey ? "Bearer key required" : "none — localhost only"}${
    args.allowedOrigins.length ? `
  ${c.dim("cors")}      ${args.allowedOrigins.join(", ")}` : ""
  }

${c.dim("Try it:")}
  curl ${url}/chat/completions -H "Content-Type: application/json" \\
    ${args.apiKey ? `-H "Authorization: Bearer ${key}" ` : ""}-d '{"model":"gemini-web-flash","messages":[{"role":"user","content":"Hello"}]}'

${c.dim("Or from code, with any OpenAI SDK:")}
  OpenAI(base_url="${url}", api_key="${key}")

${c.dim("Ctrl+C to stop.")}
`);

  const shutdown = async () => {
    console.log(c.dim("\nstopping..."));
    await close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // Keep running until a signal: the HTTP server holds the event loop open.
  await new Promise(() => undefined);
}

/** Subcommands, so the installed binary is self-sufficient. */
async function cli(): Promise<void> {
  installDialogRaceGuard();
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
      return main();
    // Flags belong to the default (agent) mode, not to a subcommand.
    case "--gem":
    case "--gem-mode":
    case "--model":
    case "--add-dir":
    case "--choose-model":
    case "--enterprise":
    case "--pick":
    case "--pick-model":
      return main();
    case "serve":
      return serve();
    case "bridge":
      return runBridge();
    case "skills":
      return skillsCommand();
    case "open-chrome": {
      await settlePermissions();
      // `open-chrome <link>` or `open-chrome --enterprise <link>`: save it and open it to sign in.
      const raw = enterpriseFlag(process.argv.slice(3)) ?? process.argv.slice(3).find((a) => !a.startsWith("-"));
      if (raw) {
        const link = setEnterprise(raw);
        console.log(link ? `[gemini-code] Gemini Enterprise link saved: ${link.url}` : "[gemini-code] Using gemini.google.com (saved)");
      }
      return void openChrome();
    }
    case "probe":
      return probe();
    case "login":
      await settlePermissions();
      return checkLogin();
    case "doctor":
      return doctor();
    case "config":
      return configCommand(process.argv.slice(3));
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    case "-v":
    case "--version": {
      console.log(`gemini-code ${VERSION}`);
      return;
    }
    default:
      if (cmd.startsWith("--gem=") || cmd.startsWith("--gem-mode=") || cmd.startsWith("--model=") || cmd.startsWith("--add-dir=") || cmd.startsWith("--enterprise=")) return main();
      console.error(`Unknown command "${cmd}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

cli().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
