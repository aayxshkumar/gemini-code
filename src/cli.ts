#!/usr/bin/env node
// Config first: it fills process.env from ~/.gemini-code/config.json before
// the modules below read their GEMINI_CODE_* settings at load time.
import "./config.js";
import readline from "node:readline/promises";
import { createRequire } from "node:module";
import { emitKeypressEvents } from "node:readline";
import path from "node:path";
import { GeminiDriver, type Gem } from "./driver/GeminiDriver.js";
import { gemFlag, gemModeFlag, modelFlag, chooseModelFlag, serveArgs } from "./args.js";
import { startServer } from "./server/openai.js";
import { installDialogRaceGuard } from "./driver/processGuards.js";
import { AgentSession } from "./agent/loop.js";
import { buildProjectTree } from "./context/projectTree.js";
import { collectProjectDocs } from "./context/projectDocs.js";
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
import { createDelegateTool, MAX_PARALLEL_WORKERS } from "./agent/workers.js";
import { createAskGemTool } from "./tools/askGem.js";
import type { ToolDefinition } from "./types.js";
import { PlanJournal, findResumablePlan, readPlan, clearPlan, PLAN_FILENAME } from "./context/plan.js";
import { createUpdatePlanTool } from "./tools/updatePlan.js";
import { createScreenshotTool } from "./tools/screenshot.js";
import { createBrowsePageTool } from "./tools/browsePage.js";
import { createBrowserTools } from "./tools/browser.js";
import { checkpoints } from "./context/checkpoint.js";
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
import { configCommand } from "./scripts/configCmd.js";
import { API_MODELS } from "./server/protocol.js";
import { c } from "./ui/format.js";
import { setAsker } from "./ui/prompt.js";

function helpText(): string {
  return `${c.bold("Commands")}
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
  ${c.cyan("/clear")}            start a fresh conversation thread
  ${c.cyan("/paste")} or ${c.cyan("Ctrl+V")}  attach an image from the clipboard
  ${c.cyan("/image <path>")}     attach an image file (or just drag one in)
  ${c.cyan("/undo")}             revert the file changes from the last task
  ${c.cyan("/plan")}             show the current plan / progress journal
  ${c.cyan("/plan clear")}       delete ${PLAN_FILENAME}
  ${c.cyan("/memory")}           show ${MEMORY_FILENAME}
  ${c.cyan("/remember <note>")}  append a note to ${MEMORY_FILENAME}
  ${c.cyan("/tools")}            list tools available to Gemini
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
        e.selected ? c.green("  ← selected") : ""
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
    entries = await driver.listModels();
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
  const chosen = byNumber ? byNumber.label : answer;
  if (byNumber?.locked) {
    console.log(c.yellow(`  "${byNumber.label}" is locked on this account — keeping ${current ?? DEFAULT_MODEL_ALIAS}`));
    return current;
  }
  // Remember an alias when one covers the label, else the label itself, so
  // the saved value keeps working across Google's version bumps.
  const alias = resolveModel(chosen) ? chosen : (resolveModelAliasFor(chosen)[0] ?? chosen);
  writeUserConfig({ ...readConfigFile(userConfigPath()), model: alias });
  console.log(`  ${c.green("✓")} model saved: ${c.bold(alias)}\n`);
  return alias;
}

async function main() {
  const driver = new GeminiDriver();
  // Start Chrome ourselves if it isn't already up, so the usual case is a
  // single command. Signing in stays manual, but the profile keeps the
  // session, so that's a one-time thing rather than a per-run step.
  const launched = await ensureChromeRunning((m) => console.log(c.dim(m)));
  if (launched) console.log(c.dim("Chrome is up, attaching..."));
  await driver.attach();
  await driver.ensureLoggedIn();

  // Gather durable context BEFORE starting the thread, so the primer can
  // carry it in one shot instead of costing tool calls later.
  const tree = await buildProjectTree();
  const created = await ensureMemoryFile(tree);
  const memory = await readMemory();
  const docs = await collectProjectDocs();
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

  await driver.newConversation();

  // Default the model (env override: GEMINI_CODE_MODEL=pro npm run dev).
  const argv = process.argv.slice(2);
  let startModel = modelFlag(argv) ?? process.env.GEMINI_CODE_MODEL;
  // No model anywhere (fresh machine), or asked to: show the live picker.
  if (process.stdin.isTTY && (chooseModelFlag(argv) || !startModel)) {
    startModel = await chooseModelInteractively(driver, startModel);
  }
  startModel ??= DEFAULT_MODEL_ALIAS;
  const wantLevel = resolveThinkingLevel(process.env.GEMINI_CODE_THINKING_LEVEL) ?? DEFAULT_THINKING_LEVEL;
  let levelNote = "";
  const wantThinking = process.env.GEMINI_CODE_THINKING
    ? /^(on|true|yes|1)$/i.test(process.env.GEMINI_CODE_THINKING)
    : DEFAULT_EXTENDED_THINKING;
  let modelName = "unknown";
  try {
    modelName = await driver.setModel(startModel, {
      onFallback: (wanted, got) =>
        console.log(c.yellow(`${wanted} isn't in this account's model picker — using ${got} instead.`)),
    });
    // Extended thinking stacks on top of the base model and slows it down,
    // so it's off unless asked for (GEMINI_CODE_THINKING=on or /thinking on).
    await driver.setExtendedThinking(wantThinking).catch(() => undefined);
    // The Thinking level submenu (where the picker has one) is what decides
    // how hard Auto thinks; the account default is Low.
    try {
      const level = await driver.setThinkingLevel(wantLevel);
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

  // Banner, Claude Code style.
  console.log(`
${c.magenta("✻")} ${c.bold("gemini-code")} ${c.dim(`v${VERSION} — Claude-Code-style agent on the Gemini web UI`)}

  ${c.dim("cwd")}     ${path.basename(process.cwd())}
  ${c.dim("model")}   ${modelName}${levelNote}${
    driver.currentGem
      ? `\n  ${c.dim("gem")}     ${driver.currentGem.name} ${c.dim("(the whole session runs inside it)")}`
      : referenceGem
        ? `\n  ${c.dim("gem")}     ${referenceGem.name} ${c.dim("(reference — ask_gem consults it)")}`
        : ""
  }
  ${c.dim("context")} project tree (${tree.split("\n").length} lines)${memory ? `, ${MEMORY_FILENAME}` : ""}${docs.length ? `, ${docs.length} doc${docs.length > 1 ? "s" : ""} (${docs.map((d) => d.path).join(", ")})` : ""}
  ${c.dim("tools")}   ${[...tools.map((t) => t.name), "delegate_tasks", "update_plan", "screenshot_page", "read_page", "browser_open", "browser_do", ...(gemConsultant ? ["ask_gem"] : [])].join(", ")}
  ${c.dim("workers")} up to ${MAX_PARALLEL_WORKERS} parallel Gemini tabs
  ${c.dim("mode")}    ${ORCHESTRATOR_MODE ? "orchestrator — main tab plans & validates, workers implement" : "solo — one tab does everything"}
${created ? `\n  ${c.green("✓")} created ${MEMORY_FILENAME} for durable project memory` : ""}${
    resumable
      ? `\n  ${c.yellow("⟳")} found an unfinished plan in ${PLAN_FILENAME} (${resumable.status}) — your next task will continue it`
      : ""
  }
${c.dim("Type a task, or /help for commands. Ctrl+V pastes an image; typing while a task runs steers it.")}
`);

  /**
   * The main tab can delegate subtasks to parallel worker tabs. Workers get
   * the same context and tools but NOT this one, so delegation can't nest.
   */
  const journal = new PlanJournal();
  const makeMainSession = (mem: string | undefined, resumePlan?: string) => {
    const ctx = { tree, memory: mem, docs, resumePlan };
    const delegate = createDelegateTool({
      parent: driver,
      context: { tree, memory: mem, docs },
      modelAlias: startModel,
      log: (msg) => console.log(msg),
      createSession: (workerDriver, workerContext) =>
        // Workers: no delegate tool (no nesting), no journal (the main
        // thread owns the plan), and the "worker" role so they report back
        // a short summary instead of pasting code into the orchestrator.
        new AgentSession(
          workerDriver,
          workerContext,
          [
            createScreenshotTool(workerDriver),
            createBrowsePageTool(workerDriver),
            ...createBrowserTools(workerDriver),
            // Workers share the ONE Gem tab (questions are queued inside the
            // tool): they need the project's conventions more than the
            // planning tab does.
            ...(gemConsultant ? [gemConsultant.tool] : []),
          ],
          undefined,
          "worker"
        ),
    });
    return new AgentSession(
      driver,
      ctx,
      [
        delegate,
        createUpdatePlanTool(journal),
        createScreenshotTool(driver),
        createBrowsePageTool(driver),
        ...createBrowserTools(driver),
        ...(gemConsultant ? [gemConsultant.tool] : []),
      ],
      journal,
      ORCHESTRATOR_MODE ? "orchestrator" : "solo"
    );
  };

  // The resume plan is injected once, into the first session only — after
  // that it's either finished or superseded by the new run's own journal.
  let session = makeMainSession(memory, resumable?.raw);

  /** Images staged by Ctrl+V, /paste or /image, sent with the next task. */
  let stagedImages: string[] = [];
  const stageImage = (file: string) => {
    stagedImages.push(file);
    console.log(`  ${c.green("✓")} attached ${path.basename(file)} — send a task to include it\n`);
  };

  // Leave the journal marked interrupted if we're killed mid-task, so the
  // next run knows there's work to pick up.
  const onSignal = async () => {
    await journal.markInterrupted("session terminated");
    await gemConsultant?.close();
    // Don't leave a dev server holding its port after we're gone.
    killAllBackgroundProcesses();
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

  rl.on("line", (line) => {
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
      process.stdout.write(c.magenta("› "));
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
    process.stdout.write(c.magenta("› "));
    return new Promise<string | null>((resolve) => {
      pending = resolve;
    });
  };

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
          switch (cmd.toLowerCase()) {
            case "help":
              console.log(`\n${helpText()}\n`);
              break;

            case "model":
              if (!arg) {
                console.log(`\n  current: ${c.bold(await driver.getCurrentModel())}\n\n${modelHelp()}\n`);
              } else {
                let wanted = arg;
                if (/^\d+$/.test(arg)) {
                  const entry = (await driver.listModels()).filter((e) => !e.submenu)[Number(arg) - 1];
                  if (!entry) throw new Error(`no model number ${arg} — /models lists them`);
                  wanted = entry.label;
                }
                const name = await driver.setModel(wanted, {
                  onFallback: (w, g) => console.log(c.yellow(`  ${w} isn't in this picker — using ${g}`)),
                });
                console.log(`  ${c.green("✓")} model: ${c.bold(name)} ${c.dim(`(picker: ${await driver.getCurrentModel()})`)}\n`);
              }
              break;

            case "models": {
              process.stdout.write(c.dim("  reading the picker...\r"));
              const entries = await driver.listModels();
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
              const level = await driver.setThinkingLevel(want);
              console.log(`  ${c.green("✓")} thinking level: ${c.bold(level)}\n`);
              break;
            }

            case "thinking": {
              const want = /^(on|true|yes|1)$/i.test(arg);
              if (!arg) {
                console.log(`\n  current: ${c.bold(await driver.getCurrentModel())}\n  usage: /thinking on|off\n`);
                break;
              }
              await driver.setExtendedThinking(want);
              console.log(`  ${c.green("✓")} ${await driver.getCurrentModel()}\n`);
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
                    ? `  ${c.green("✓")} Gem ${c.bold(active.name)} ${c.dim(
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
                console.log(`  ${c.green("✓")} no Gem in use ${c.dim("(fresh thread)")}\n`);
                break;
              }
              try {
                if (gemMode === "inside") {
                  const gem = await driver.useGem(arg);
                  console.log(`  ${c.green("✓")} session now runs inside Gem ${c.bold(gem.name)}\n`);
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
                    `  ${c.green("✓")} ask_gem now consults ${c.bold(gem.name)} ${c.dim("(reference only)")}\n`
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

            case "clear":
            case "new":
              await driver.newConversation();
              // A fresh thread has no memory of the primer, so the next task
              // must re-send it — that's what a new AgentSession does.
              session = makeMainSession(await readMemory());
              console.log(`  ${c.green("✓")} fresh conversation thread\n`);
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
              const result = await checkpoints.undoLast();
              console.log(`  ${result.ok ? c.green("✓") : c.yellow("!")} ${result.message}\n`);
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
                console.log(`  ${c.green("✓")} cleared ${PLAN_FILENAME}\n`);
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
              console.log(`  ${c.green("✓")} saved to ${MEMORY_FILENAME}\n`);
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

      try {
        const attachments = stagedImages;
        stagedImages = [];
        checkpoints.begin(task);
        const answer = await session.runTask(task, {
          attachments,
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
        await checkpoints.commit();
        console.log(`\n${answer}\n`);
      } catch (err) {
        await checkpoints.commit(); // keep snapshots from a failed run too
        // One failed task shouldn't kill the whole REPL session — report it
        // and keep the prompt alive so the browser/thread stays usable.
        console.error(`\n  ${c.red("✗")} ${(err as Error).message}\n`);
      }
    }
  } finally {
    setAsker(undefined);
    // Close the Gem's tab with the session that opened it.
    await gemConsultant?.close();
    rl.close();
    killAllBackgroundProcesses();
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
  gemini-code --gem <name>    consult one of your Gems for project knowledge (ask_gem)
  gemini-code --gem <name> --gem-mode inside
                              run the whole session inside the Gem instead
  gemini-code serve           run an OpenAI-compatible API on http://127.0.0.1:8787/v1
      --port <n>              port (default 8787)
      --host <addr>           address to bind (default 127.0.0.1; others need --api-key)
      --tabs <n>              parallel Gemini tabs = concurrent requests (default 2)
      --api-key <key>         require "Authorization: Bearer <key>"
      --cors-origin <url>     let a browser app at <url> call it (repeatable)
  gemini-code open-chrome     open a normal Chrome window to sign into (do this first)
  gemini-code login           check that the signed-in Chrome is reachable
  gemini-code doctor          check Node, Chrome, the profile, PATH and the sign-in state
  gemini-code config          show saved defaults; "config set model pro" saves one
  gemini-code --help          this message

Settings (environment, or "gemini-code config set <key> <value>", or <project>/.gemini-code.json):
  GEMINI_CODE_MODEL           thinking (default) | fast | fastest | pro
  GEMINI_CODE_THINKING_LEVEL  low | medium | high (default) — the picker's Thinking level
  GEMINI_CODE_THINKING        on | off — the Extended thinking toggle, where the picker has one
  GEMINI_CODE_GEM             Gem to start in, by name or id (same as --gem)
  GEMINI_CODE_MAX_WORKERS     parallel worker tabs (default 3)
  GEMINI_CODE_AUTO_APPROVE=1  skip y/N confirmations for writes, shell and network
  GEMINI_CODE_PROFILE         Chrome profile dir (default ~/.gemini-code/profile)
  GEMINI_CODE_API_KEY         same as serve --api-key
  GEMINI_CODE_API_PORT, GEMINI_CODE_API_HOST, GEMINI_CODE_API_TABS, GEMINI_CODE_API_CORS
`;

/** `gemini-code serve`: the OpenAI-compatible API. */
async function serve(): Promise<void> {
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
${c.magenta("✻")} ${c.bold("gemini-code")} ${c.dim(`v${VERSION} — OpenAI-compatible API on your Gemini web session`)}

  ${c.dim("base url")}  ${c.bold(url)}
  ${c.dim("models")}    ${API_MODELS.map((m) => (m.alias === DEFAULT_MODEL_ALIAS ? `${m.id} (default)` : m.id)).join(", ")}
  ${c.dim("tabs")}      up to ${args.tabs} parallel (one request per tab)
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
    case "--choose-model":
    case "--pick":
    case "--pick-model":
      return main();
    case "serve":
      return serve();
    case "open-chrome":
      return void openChrome();
    case "login":
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
      if (cmd.startsWith("--gem=") || cmd.startsWith("--gem-mode=") || cmd.startsWith("--model=")) return main();
      console.error(`Unknown command "${cmd}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

cli().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
