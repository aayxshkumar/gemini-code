import readline from "node:readline";
import { format } from "node:util";
import path from "node:path";
import { GeminiDriver, type Gem } from "../driver/GeminiDriver.js";
import { gemFlag, gemModeFlag } from "../args.js";
import { createMainSession } from "../agent/mainSession.js";
import type { AgentSession } from "../agent/loop.js";
import { MAX_PARALLEL_WORKERS } from "../agent/workers.js";
import { buildProjectTree } from "../context/projectTree.js";
import { collectProjectDocs } from "../context/projectDocs.js";
import { ensureMemoryFile, readMemory, MEMORY_FILENAME } from "../context/memory.js";
import { PlanJournal, findResumablePlan } from "../context/plan.js";
import type { ModelMenu } from "../driver/models.js";
import { ensureChromeRunning } from "../scripts/openChrome.js";
import { createAskGemTool } from "../tools/askGem.js";
import { killAllBackgroundProcesses } from "../tools/bash.js";
import { McpManager } from "../tools/mcp.js";
import { skillSummaries } from "../tools/skills.js";
import type { ToolDefinition } from "../types.js";
import { setAsker, setQuestioner } from "../ui/prompt.js";
import { Bridge, parseCommand, type BridgeHost, type Emit } from "./bridge.js";

/** Long, because signing in is a person doing something in another window. */
const SIGN_IN_TIMEOUT_MS = 30 * 60_000;

/** `gemini-code bridge`: the agent for the desktop UI. See bridge.ts. */
export async function runBridge(): Promise<void> {
  const emit: Emit = (event) => void process.stdout.write(JSON.stringify(event) + "\n");

  // stdout is the protocol now. Everything that logs (the driver's sign-in
  // notices, tab-branding warnings) becomes an event rather than a line the
  // UI would have to fail to parse.
  const logEvent = (...args: unknown[]) => emit({ type: "log", text: format(...args) });
  console.log = console.info = console.warn = console.error = logEvent;

  let bridge: Bridge | undefined;
  let stopSession: (() => Promise<void>) | undefined;
  let exiting = false;
  const exit = async (code: number) => {
    if (exiting) return;
    exiting = true;
    await stopSession?.().catch(() => undefined);
    process.exit(code);
  };

  // Listening from the start, so the UI can close during a long sign-in wait.
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (bridge) return void bridge.handleLine(line);
    try {
      if (parseCommand(line).cmd === "shutdown") void exit(0);
    } catch {
      // Malformed input before startup: nothing to answer it with yet.
    }
  });
  // The UI going away for any reason, a crash included, ends the agent.
  input.on("close", () => void exit(0));

  try {
    const session = await startSession(emit, () => exit(0));
    stopSession = session.stop;
    bridge = new Bridge(session.host, emit);
    emit({ type: "ready", ...session.info });
    await bridge.connectMcp();
  } catch (err) {
    emit({ type: "fatal", message: (err as Error).message });
    await exit(1);
  }
}

async function startSession(emit: Emit, exit: () => Promise<void>) {
  const log = (text: string) => emit({ type: "log", text });
  const orchestrator = process.env.GEMINI_CODE_ORCHESTRATOR !== "0";
  const argv = process.argv.slice(3);
  const gemMode = gemModeFlag(argv);

  const driver = new GeminiDriver();
  const launched = await ensureChromeRunning(log);
  if (launched) log("Chrome is up, attaching...");
  await driver.attach();
  await driver.ensureLoggedIn(SIGN_IN_TIMEOUT_MS, true);

  const tree = await buildProjectTree();
  const created = await ensureMemoryFile(tree);
  const docs = await collectProjectDocs();
  const resumable = await findResumablePlan();
  let skills = await skillSummaries();
  await driver.markTab("🤖 gemini-code · main");

  // Empty means leave Gemini on whatever its picker already has selected.
  let modelName = process.env.GEMINI_CODE_MODEL ?? "";
  let referenceGem: Gem | undefined;
  let gemConsultant: { tool: ToolDefinition; close: () => Promise<void> } | undefined;

  const consult = async (gem: Gem) => {
    // Drop the previous Gem's tab, or its thread lingers with nothing using it.
    await gemConsultant?.close();
    referenceGem = gem;
    gemConsultant = createAskGemTool({ gem, openTab: () => driver.spawnGemTab(gem), log });
  };

  const wantedGem = gemFlag(argv) ?? process.env.GEMINI_CODE_GEM;
  if (wantedGem) {
    try {
      if (gemMode === "inside") await driver.useGem(wantedGem);
      else await consult(await driver.findGem(wantedGem));
    } catch (err) {
      log(`Couldn't use Gem "${wantedGem}": ${(err as Error).message.split("\n")[0]}`);
    }
  }

  await driver.newConversation();

  if (modelName) {
    await driver.setModel(modelName).catch((err: Error) => {
      log(`Couldn't set model to "${modelName}": ${err.message.split("\n")[0]}`);
    });
  }
  const thinkingLevel = process.env.GEMINI_CODE_THINKING;
  if (thinkingLevel) {
    await driver.setThinkingLevel(thinkingLevel).catch((err: Error) => {
      log(`Couldn't set thinking to "${thinkingLevel}": ${err.message.split("\n")[0]}`);
    });
  }
  const current = await driver.getCurrentModel();
  // A picker that can't be read shouldn't stop the session: it can still work
  // on the selected model, and the app says it has no list.
  const menu = await driver.listModels().catch((err: Error): ModelMenu => {
    log(`Couldn't read the model list: ${err.message.split("\n")[0]}`);
    return { models: [], thinking: [], current };
  });

  const journal = new PlanJournal();
  const mcp = new McpManager();
  const makeSession = (memory: string | undefined, resumePlan?: string) =>
    createMainSession({
      driver,
      context: { tree, memory, docs, resumePlan, skills },
      journal,
      modelAlias: () => modelName,
      gemTool: gemConsultant?.tool,
      mcpTools: () => mcp.tools,
      orchestrator,
      log,
    });

  // The resume plan goes into the first session only, as in the terminal.
  const memory = await readMemory();
  let session: AgentSession = makeSession(memory, resumable?.raw);
  const freshThread = async () => {
    await driver.newConversation();
    const planning = session.inPlanMode;
    // Re-read, so a skill installed since the last thread is in the next one.
    skills = await skillSummaries();
    session = makeSession(await readMemory());
    session.setPlanMode(planning);
  };

  const host: BridgeHost = {
    runTask: (task, options) => session.runTask(task, options),
    latestMarkdown: () => driver.getLastResponseMarkdown().catch(() => ""),
    listModels: () => driver.listModels(),
    async setModel(name) {
      await driver.setModel(name);
      modelName = name;
    },
    setThinkingLevel: (level) => driver.setThinkingLevel(level),
    newThread: freshThread,
    setPlanMode: (on) => session.setPlanMode(on),
    inPlanMode: () => session.inPlanMode,
    async connectMcp() {
      await mcp.connectAll(log);
      if (!mcp.tools.length) return;
      // Nothing has been sent yet, so the session can simply be made again
      // with the servers' tools, keeping the plan the first one was resuming.
      const planning = session.inPlanMode;
      session = makeSession(memory, resumable?.raw);
      session.setPlanMode(planning);
    },
    mcpStatus: () => mcp.status,
    listGems: () => driver.listGems(),
    async setGem(name) {
      if (!name) {
        await gemConsultant?.close();
        gemConsultant = undefined;
        referenceGem = undefined;
        await driver.clearGem();
        await freshThread();
        return null;
      }
      let gem: Gem;
      if (gemMode === "inside") {
        gem = await driver.useGem(name);
      } else {
        gem = await driver.findGem(name);
        await consult(gem);
      }
      // The tool list changed and a Gem applies per thread, so the next task
      // needs a fresh thread and a re-sent primer.
      await freshThread();
      return gem.name;
    },
    markInterrupted: (reason) => journal.markInterrupted(reason),
    shutdown: exit,
  };

  const stop = async () => {
    setAsker(undefined);
    setQuestioner(undefined);
    await journal.markInterrupted("session terminated");
    await gemConsultant?.close();
    await mcp.close();
    // Don't leave a dev server holding its port after we're gone.
    killAllBackgroundProcesses();
    await driver.close();
  };

  const info = {
    cwd: process.cwd(),
    project: path.basename(process.cwd()),
    menu,
    gem: driver.currentGem?.name ?? referenceGem?.name ?? null,
    gemMode,
    mode: orchestrator ? "orchestrator" : "solo",
    workers: MAX_PARALLEL_WORKERS,
    tools: session.toolList,
    context: {
      treeLines: tree.split("\n").length,
      memory: memory ? MEMORY_FILENAME : null,
      docs: docs.map((d) => d.path),
    },
    createdMemory: created,
    resumablePlan: resumable?.status ?? null,
  };

  return { host, info, stop };
}
