/**
 * Lightweight smoke tests, no framework — `npm test` runs this with tsx.
 *
 * These cover everything that does NOT require a logged-in Gemini session:
 * the tool-call parser, the local tools, and the full agent loop wired
 * against a fake driver. They do NOT touch selectors.ts or prove the real
 * Gemini DOM automation works — that step still needs your own login and
 * selector calibration (see README.md).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGeminiReply, looksLikeAbandonedWork, looksUnfinished, looksLikeGeminiError } from "../agent/toolCallParser.js";
import { formatToolResult, buildContextDocument, buildSystemPrimer } from "../agent/promptTemplate.js";
import { AgentSession } from "../agent/loop.js";
import { looksLikeUnseenAttachment } from "../agent/toolCallParser.js";
import type { IGeminiDriver, GeminiResponse } from "../driver/IGeminiDriver.js";
import { readFileTool } from "../tools/readFile.js";
import { editFileTool } from "../tools/editFile.js";
import { multiEditTool } from "../tools/multiEdit.js";
import { searchCode, searchCodeTool, globToRegExp } from "../tools/searchCode.js";
import { findFilesTool } from "../tools/findFiles.js";
import { addRoot, displayPath, resolveInWorkspace, rootsFromArgs } from "../workspace.js";
import { autoApproved } from "../tools/confirm.js";
import { detectEol, findSpans, reindent, nearestContext } from "../tools/matchText.js";
import { gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBlameTool } from "../tools/git.js";
import { writeFileTool } from "../tools/writeFile.js";
import { listFilesTool } from "../tools/listFiles.js";
import { tools } from "../tools/index.js";
import type { ToolDefinition } from "../types.js";
import { createToolSearchTool } from "../tools/toolSearch.js";
import { createPlanModeTools, READ_ONLY_TOOLS } from "../tools/planMode.js";
import { copyFileTool, deleteFileTool, fileInfoTool, moveFileTool, readFilesTool } from "../tools/files.js";
import { notebookEditTool, notebookReadTool } from "../tools/notebook.js";
import { codeOutlineTool, findSymbolTool, outline } from "../tools/code.js";
import { findSkills, parseFrontmatter, renderSkill, useSkillTool } from "../tools/skills.js";
import { discoverSkills, installSkills, listInstalled, parseSkillSource, removeSkill } from "../tools/skillInstall.js";
import { askUserTool } from "../tools/askUser.js";
import { checkpoints } from "../context/checkpoint.js";
import { expandEnv, loadMcpConfig, McpManager } from "../tools/mcp.js";
import { describeEnvironment, onPath, type EnvironmentInfo } from "../context/environment.js";
import { bashTool, checkOutputTool, killProcessTool, looksLongRunning, resolveShell, waitForOutputTool } from "../tools/bash.js";
import { fetchUrlTool } from "../tools/fetchUrl.js";
import { webSearchTool, parseResults } from "../tools/webSearch.js";
import {
  resolveModel,
  modelWithFallbacks,
  resolveThinkingLevel,
  THINKING_LEVEL_MENU,
  DEFAULT_MODEL_ALIAS,
  EXTENDED_THINKING,
  menuRowMatches,
  parseModelRows,
  parseThinkingRows,
  type MenuRow,
} from "../driver/models.js";
import { resolveGem } from "../driver/GeminiDriver.js";
import { selectors, applySelectorOverrides } from "../driver/selectors.js";
import { appUrl, isAppPage, isEnterprise, isSignInPage, parseEnterpriseUrl } from "../driver/site.js";
import { enterpriseConfigured, setEnterprise } from "../enterprise.js";
import { envNameFor } from "../config.js";
import { createAskGemTool } from "../tools/askGem.js";
import { gemFlag, gemModeFlag, enterpriseFlag, serveArgs } from "../args.js";
import { startServer } from "../server/openai.js";
import { isDialogRace } from "../driver/processGuards.js";
import {
  buildFreshPrompt,
  buildContinuationPrompt,
  continuationOf,
  modelAliasFor,
  parseToolCalls,
  streamableDelta,
  validateRequest,
  type ChatMessage,
} from "../server/protocol.js";
import { buildProjectTree } from "../context/projectTree.js";
import { ensureMemoryFile, appendMemory, readMemory, MEMORY_FILENAME } from "../context/memory.js";
import { collectProjectDocs } from "../context/projectDocs.js";
import { isImagePath, normalizeDroppedPath } from "../context/clipboard.js";
import { CheckpointStore } from "../context/checkpoint.js";
import { createUpdatePlanTool } from "../tools/updatePlan.js";
import { confirmAction } from "../tools/confirm.js";
import { setAsker, setQuestioner } from "../ui/prompt.js";
import { PlanJournal, readPlan, findResumablePlan, clearPlan, parsePlan, resumeTaskText } from "../context/plan.js";
import { runParallelTasks, createDelegateTool, MAX_WORKER_REPORT_CHARS } from "../agent/workers.js";
import { gitignoreTests } from "./gitignore.js";
import { multiEditTests } from "./multiEdit.js";
import { Bridge, classifyActivity, parseQuestion, type BridgeEvent, type BridgeHost } from "../bridge/bridge.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${(err as Error).stack ?? err}`);
    // Shows on the run's page, where logs alone need a sign-in to read.
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error title=${name}::${String((err as Error).message ?? err).slice(0, 800).replace(/\r?\n/g, "%0A")}`);
    }
  }
}

// --- Builders that mimic what GeminiDriver.getLastResponse() actually
// extracts from the rendered DOM: a tool call arrives as JSON inside a
// code block, with NO surviving backtick fence, often alongside chrome
// text the UI itself injects (e.g. Gemini's own "Code snippet" label) —
// exactly what real usage surfaced. See toolCallParser.ts for why.
function toolCallResponse(name: string, args: Record<string, unknown>): GeminiResponse {
  const json = JSON.stringify({ name, args });
  return { text: `Code snippet\n${json}`, codeBlocks: [json] };
}
function malformedToolResponse(rawJsonish: string): GeminiResponse {
  return { text: `Code snippet\n${rawJsonish}`, codeBlocks: [rawJsonish] };
}
function toolCallResponseRaw(json: string): GeminiResponse {
  return { text: `JSON\n${json}`, codeBlocks: [json] };
}
function finalResponse(text: string): GeminiResponse {
  return { text, codeBlocks: [] };
}

// --- A fake driver that stands in for a real Gemini web session ---------
class FakeDriver implements IGeminiDriver {
  public sentMessages: string[] = [];
  public attachedFiles: (string | string[] | undefined)[] = [];
  private replies: GeminiResponse[];

  constructor(scriptedReplies: GeminiResponse[]) {
    this.replies = [...scriptedReplies];
  }

  async sendPrompt(text: string, opts?: { attachFile?: string | string[] }): Promise<void> {
    this.sentMessages.push(text);
    this.attachedFiles.push(opts?.attachFile);
  }

  async waitForResponseComplete(): Promise<void> {
    // Instant in the fake — no real generation to wait on.
  }

  async getLastResponse(): Promise<GeminiResponse> {
    const next = this.replies.shift();
    if (next === undefined) throw new Error("FakeDriver ran out of scripted replies");
    return next;
  }
}

async function main() {
  const tmpDir = path.resolve(process.cwd(), ".tmp-test");
  await mkdir(tmpDir, { recursive: true });

  // This whole suite is non-interactive (no TTY on stdin), so auto-approve
  // the confirm gates that write_file/run_bash would otherwise block on.
  process.env.GEMINI_CODE_AUTO_APPROVE = "1";
  process.env.GEMINI_CODE_PROMPT_UNATTENDED = "1"; // the suite has no TTY but still tests the prompts
  // Most loop tests script one reply per turn and assert on it. The
  // no-tool-call backstop adds a turn to any task that never calls a tool, so
  // it's off by default here and switched on by the tests that cover it.
  process.env.GEMINI_CODE_IDLE_NUDGES = "0";

  console.log("Parser:");
  await test("parses a tool call out of a rendered code block", () => {
    const result = parseGeminiReply(toolCallResponse("read_file", { path: "x.txt" }));
    assert.equal(result.kind, "tool_call");
    if (result.kind === "tool_call") {
      assert.equal(result.call.name, "read_file");
      assert.deepEqual(result.call.args, { path: "x.txt" });
    }
  });

  await test("ignores UI chrome text (e.g. \"Code snippet\" label) around the code block", () => {
    // Regression test for the real bug: .text carries rendering chrome the
    // UI adds, but codeBlocks should still parse cleanly regardless.
    const result = parseGeminiReply({
      text: 'Code snippet\n{"name": "run_bash", "args": {"command": "ls -la"}}',
      codeBlocks: ['{"name": "run_bash", "args": {"command": "ls -la"}}'],
    });
    assert.equal(result.kind, "tool_call");
    if (result.kind === "tool_call") assert.equal(result.call.name, "run_bash");
  });

  console.log("Crash and resume:");
  await test("the journal records the thread URL and parses back steps, log and task", async () => {
    const j = new PlanJournal(".tmp-test");
    await j.begin("ship the widget");
    await j.setSteps([{ title: "make it", done: true }, { title: "test it", done: false }]);
    await j.log("write_file(w.py) -> ok");
    await j.setThread("https://gemini.google.com/app/abc123");
    const plan = (await readPlan(".tmp-test"))!;
    assert.equal(plan.status, "in_progress");
    assert.equal(plan.task, "ship the widget");
    assert.equal(plan.thread, "https://gemini.google.com/app/abc123");
    assert.deepEqual(plan.steps, [{ title: "make it", done: true }, { title: "test it", done: false }]);
    assert.ok(plan.log.some((l) => /write_file\(w\.py\)/.test(l)));
    const text = resumeTaskText(plan);
    assert.match(text, /ORIGINAL TASK:\nship the widget/);
    assert.match(text, /\[x\] make it[\s\S]*\[ \] test it/);
    assert.match(text, /first unfinished step/);
    assert.equal(parsePlan("# nothing").task, "");
  });

  await test("resuming keeps the plan's steps through the next begin() instead of wiping them", async () => {
    const plan = (await readPlan(".tmp-test"))!;
    const j = new PlanJournal(".tmp-test");
    j.resume(plan);
    await j.begin("Continue the task…");
    assert.deepEqual(j.pendingSteps(), ["test it"], "open steps survive");
    assert.equal(j.thread, "https://gemini.google.com/app/abc123");
    const again = (await readPlan(".tmp-test"))!;
    assert.ok(again.log.some((l) => /resumed:/.test(l)));
    assert.equal(again.steps.length, 2);
    // A normal begin() afterwards starts fresh again.
    await j.begin("something new");
    assert.deepEqual(j.pendingSteps(), []);
  });

  await test("a session continuing in a reopened thread sends no primer, just a resume note", async () => {
    const driver = new FakeDriver([finalResponse("picking up")]);
    const session = new AgentSession(driver, { tree: "t" });
    session.continueInThread();
    const answer = await session.runTask("Continue the task that was interrupted…");
    assert.equal(answer, "picking up");
    assert.equal(driver.sentMessages.length, 1);
    assert.doesNotMatch(driver.sentMessages[0], /RULES FOR USING TOOLS/, "the thread already has the primer");
    assert.match(driver.sentMessages[0], /has just been resumed/);
    assert.match(driver.sentMessages[0], /Continue the task that was interrupted/);
  });

  await test("the loop records the thread URL as soon as the driver knows it", async () => {
    const base = new FakeDriver([finalResponse("ok")]);
    const driver: IGeminiDriver = {
      sendPrompt: (t, o) => base.sendPrompt(t, o),
      waitForResponseComplete: () => base.waitForResponseComplete(),
      getLastResponse: () => base.getLastResponse(),
      currentThreadUrl: () => "https://gemini.google.com/app/xyz789",
    };
    const j = new PlanJournal(".tmp-test");
    await new AgentSession(driver, {}, [], j).runTask("hello");
    assert.equal((await readPlan(".tmp-test"))!.thread, "https://gemini.google.com/app/xyz789");
  });

  console.log("Stalls and edge cases:");
  await test("the same call three times in a row, and ping-pong, are pointed out inside the result", async () => {
    const f = path.join(".tmp-test", "loop.txt");
    await writeFile(f, "hello\n", "utf8");
    const same = toolCallResponse("read_file", { path: f });
    const other = toolCallResponse("list_files", {});
    const driver = new FakeDriver([same, same, same, same, other, same, other, same, finalResponse("done")]);
    await new AgentSession(driver).runTask("loop");
    const notes = driver.sentMessages.filter((m) => /third identical read_file call/.test(m));
    assert.equal(notes.length, 1, "noted once per streak, not on every repeat");
    assert.ok(driver.sentMessages.some((m) => /alternating between the same two calls/.test(m)), "ping-pong noted");
  });

  await test("a tool that never returns is abandoned by the watchdog", async () => {
    process.env.GEMINI_CODE_TOOL_TIMEOUT_MS = "1000";
    try {
      const hang: ToolDefinition = { name: "hang", description: "hang()", run: () => new Promise(() => {}) };
      const driver = new FakeDriver([toolCallResponse("hang", {}), finalResponse("ok")]);
      const t0 = Date.now();
      await new AgentSession(driver, {}, [hang]).runTask("hang");
      assert.ok(Date.now() - t0 < 5_000, "didn't wait forever");
      assert.match(driver.sentMessages[1], /did not finish within 1s and was abandoned/);
    } finally {
      delete process.env.GEMINI_CODE_TOOL_TIMEOUT_MS;
    }
  });

  await test("exploring forever gets a nudge after N read-only calls", async () => {
    process.env.GEMINI_CODE_EXPLORE_NUDGE_TURNS = "3";
    try {
      const driver = new FakeDriver([
        toolCallResponse("list_files", {}),
        toolCallResponse("git_status", {}),
        toolCallResponse("list_files", { path: "src" }),
        toolCallResponse("git_status", {}),
        finalResponse("done"),
      ]);
      await new AgentSession(driver).runTask("explore");
      const nudges = driver.sentMessages.filter((m) => /consecutive read-only calls/.test(m));
      assert.equal(nudges.length, 1);
      assert.match(nudges[0], /3 consecutive/);
    } finally {
      delete process.env.GEMINI_CODE_EXPLORE_NUDGE_TURNS;
    }
  });

  await test("cancelling stops the task at the next safe point and journals it", async () => {
    const ac = new AbortController();
    const slow: ToolDefinition = {
      name: "slow",
      description: "slow()",
      run: async () => {
        ac.abort(); // the user hits Ctrl+C while a tool runs
        return { ok: true, output: "did a thing" };
      },
    };
    const driver = new FakeDriver([toolCallResponse("slow", {}), finalResponse("never reached")]);
    const answer = await new AgentSession(driver, {}, [slow]).runTask("x", { cancelSignal: ac.signal });
    assert.match(answer, /Cancelled/);
    assert.equal(driver.sentMessages.length, 1, "the tool result was not sent after cancellation");
  });

  await test("when Gemini says it can't see the attachment, the content is resent inline", async () => {
    const big = "line\n".repeat(2_000); // > 4,000 chars -> attached
    const bigTool: ToolDefinition = { name: "big", description: "big()", run: async () => ({ ok: true, output: big }) };
    assert.ok(looksLikeUnseenAttachment(finalResponse("I can't see the attached file. Could you upload it again?")));
    assert.ok(!looksLikeUnseenAttachment(finalResponse("The file is attached to the ticket; I read it and here is the fix.")));
    const driver = new FakeDriver([
      toolCallResponse("big", {}),
      finalResponse("I'm unable to open the attachment you mentioned."),
      finalResponse("Got it, thanks."),
    ]);
    await new AgentSession(driver, {}, [bigTool]).runTask("x");
    assert.ok(driver.attachedFiles[1], "first the result was attached");
    assert.match(driver.sentMessages[2], /didn't reach you, so here is its content inline/);
    assert.match(driver.sentMessages[2], /line\nline/);
  });

  await test("a lost tab is recovered and the thread re-primed from the journal", async () => {
    const f = path.join(".tmp-test", "recover.txt");
    await writeFile(f, "x\n", "utf8");
    let dead = true;
    let recovered = 0;
    const base = new FakeDriver([toolCallResponse("read_file", { path: f }), finalResponse("finished")]);
    const driver: IGeminiDriver = {
      async sendPrompt(text, opts) {
        if (dead) throw new Error("Target page, context or browser has been closed");
        return base.sendPrompt(text, opts);
      },
      waitForResponseComplete: () => base.waitForResponseComplete(),
      getLastResponse: () => base.getLastResponse(),
      isAlive: async () => !dead,
      recover: async () => {
        recovered++;
        dead = false;
        return true;
      },
      newConversation: async () => {},
    };
    const journal = new PlanJournal(".tmp-test");
    const session = new AgentSession(driver, { tree: "t" }, [], journal);
    // Prime the thread first so the loss happens mid-task.
    const answer = await session.runTask("read the file and finish");
    assert.equal(answer, "finished");
    assert.equal(recovered, 1);
    assert.match(base.sentMessages[0], /HANDOFF FROM YOUR PREVIOUS CONTEXT|from the journal/, "re-primed with a handoff");
    assert.match(base.sentMessages[0], /CONTINUE the task below/);
  });

  await test("offline and signed-out pauses don't consume retries", async () => {
    let offline = true;
    let signedOut = true;
    const base = new FakeDriver([finalResponse("back online")]);
    let sends = 0;
    const driver: IGeminiDriver = {
      async sendPrompt(text, opts) {
        sends++;
        if (offline) throw new Error("net::ERR_INTERNET_DISCONNECTED");
        if (signedOut) throw new Error("composer not found");
        return base.sendPrompt(text, opts);
      },
      waitForResponseComplete: () => base.waitForResponseComplete(),
      getLastResponse: () => base.getLastResponse(),
      isAlive: async () => true,
      isOffline: async () => offline,
      waitForOnline: async () => {
        offline = false;
        return true;
      },
      isLoggedIn: async () => !signedOut,
      ensureLoggedIn: async () => {
        signedOut = false;
      },
    };
    const answer = await new AgentSession(driver).runTask("hi");
    assert.equal(answer, "back online");
    assert.equal(sends, 3, "two environment pauses, then success");
  });

  await test("the journal can describe the task on its own for a handoff", async () => {
    const j = new PlanJournal(".tmp-test");
    await j.begin("build the thing");
    await j.setSteps([{ title: "a", done: true }, { title: "b", done: false }]);
    await j.log("write_file(x.py) -> ok");
    const note = j.summaryForHandoff()!;
    assert.match(note, /## Goal\nbuild the thing/);
    assert.match(note, /\[x\] a[\s\S]*\[ \] b/);
    assert.match(note, /write_file\(x\.py\)/);
  });

  await test("recognises Gemini's own error replies, and nothing else", () => {
    assert.ok(looksLikeGeminiError(finalResponse("I encountered an error doing what you asked. Could you try again?")));
    assert.ok(looksLikeGeminiError(finalResponse("Something went wrong. Please try again.")));
    assert.ok(!looksLikeGeminiError(finalResponse("The build failed: something went wrong in webpack. I fixed the loader config.")));
    assert.ok(!looksLikeGeminiError(finalResponse("I encountered an error doing what you asked — the file was read-only — so I changed permissions first and the edit then succeeded. Details follow.\n\n" + "x".repeat(300))));
    assert.ok(!looksLikeGeminiError(toolCallResponse("read_file", { path: "a" })));
  });

  await test("the loop retries a turn that Gemini answered with its own error", async () => {
    const replies: GeminiResponse[] = [
      finalResponse("I encountered an error doing what you asked. Could you try again?"),
      finalResponse("Forty-two."),
    ];
    const sent: string[] = [];
    const driver: IGeminiDriver = {
      async sendPrompt(text) {
        sent.push(text);
      },
      async waitForResponseComplete() {},
      async getLastResponse() {
        return replies.shift() ?? finalResponse("(no more)");
      },
    };
    const before = process.env.GEMINI_CODE_IDLE_NUDGES;
    process.env.GEMINI_CODE_IDLE_NUDGES = "0";
    try {
      const session = new AgentSession(driver, {});
      const answer = await session.runTask("What is the answer?");
      assert.equal(answer, "Forty-two.");
      assert.equal(sent.length, 2, "the same turn was sent again");
      assert.equal(sent[0], sent[1], "resent verbatim");
    } finally {
      process.env.GEMINI_CODE_IDLE_NUDGES = before;
    }
  });

  await test("collects several independent calls from one reply, as blocks or an array", () => {
    const known = new Set(["read_file", "search_code", "git_status"]);
    const a = JSON.stringify({ name: "read_file", args: { path: "a.py" } });
    const b = JSON.stringify({ name: "search_code", args: { pattern: "TODO" } });
    const blocks = parseGeminiReply({ text: `${a}\n${b}`, codeBlocks: [a, b] }, known);
    assert.equal(blocks.kind, "tool_call");
    if (blocks.kind !== "tool_call") return;
    assert.deepEqual(blocks.calls.map((c) => c.name), ["read_file", "search_code"]);
    assert.equal(blocks.call.name, "read_file", "call is still the first one, for old callers");

    const arr = `[${a}, ${b}, {"name": "git_status"}]`;
    const array = parseGeminiReply({ text: arr, codeBlocks: [arr] }, known);
    assert.equal(array.kind, "tool_call");
    if (array.kind === "tool_call") assert.deepEqual(array.calls.map((c) => c.name), ["read_file", "search_code", "git_status"]);

    // A list that is only partly tool calls is not a batch; the prose scan
    // still picks up the one real call in it, as it would anywhere in a reply.
    const mixed = `[${a}, {"version": "1.0.0"}]`;
    const partial = parseGeminiReply({ text: mixed, codeBlocks: [mixed] }, known);
    assert.equal(partial.kind, "tool_call");
    if (partial.kind === "tool_call") assert.equal(partial.calls.length, 1);
  });

  await test("repairs the JSON a model most often gets slightly wrong", () => {
    const known = new Set(["read_file", "edit_file"]);
    const trailing = '{"name": "read_file", "args": {"path": "a.py",},}';
    assert.equal(parseGeminiReply({ text: trailing, codeBlocks: [trailing] }, known).kind, "tool_call");
    const commented = '{\n  // the file to read\n  "name": "read_file", "args": {"path": "a.py"}\n}';
    assert.equal(parseGeminiReply({ text: commented, codeBlocks: [commented] }, known).kind, "tool_call");
    // A comment marker inside a string is left alone.
    const url = '{"name": "read_file", "args": {"path": "http://x/y"}}';
    const parsed = parseGeminiReply({ text: url, codeBlocks: [url] }, known);
    assert.equal(parsed.kind, "tool_call");
    if (parsed.kind === "tool_call") assert.equal(parsed.call.args.path, "http://x/y");
    // Other spellings of "name", only for a real tool.
    const fn = '{"function": {"name": "edit_file", "arguments": {"path": "a", "old_text": "x", "new_text": "y"}}}';
    const asFn = parseGeminiReply({ text: fn, codeBlocks: [fn] }, known);
    assert.equal(asFn.kind, "tool_call");
    if (asFn.kind === "tool_call") assert.equal(asFn.call.args.old_text, "x");
    const tool = '{"tool": "read_file", "path": "a.py"}';
    const asTool = parseGeminiReply({ text: tool, codeBlocks: [tool] }, known);
    assert.equal(asTool.kind, "tool_call");
    if (asTool.kind === "tool_call") assert.deepEqual(asTool.call, { name: "read_file", args: { path: "a.py" } });
    const notTool = '{"tool": "hammer", "weight": 2}';
    assert.equal(parseGeminiReply({ text: notTool, codeBlocks: [notTool] }, known).kind, "final");
  });

  await test("flags malformed JSON inside a code block as an attempted tool call", () => {
    const result = parseGeminiReply(malformedToolResponse('{"name": "read_file", "args": {oops}'));
    assert.equal(result.kind, "malformed");
  });

  await test("treats plain text with no code block as final", () => {
    const result = parseGeminiReply(finalResponse("Here's my answer: 42."));
    assert.equal(result.kind, "final");
    if (result.kind === "final") assert.equal(result.text, "Here's my answer: 42.");
  });

  await test("still recognizes a literal ```tool fence as a fallback", () => {
    const result = parseGeminiReply(
      finalResponse('```tool\n{"name": "read_file", "args": {"path": "x.txt"}}\n```')
    );
    assert.equal(result.kind, "tool_call");
  });

  await test("accepts drifted tool-call shapes, but only for real tool names", () => {
    const known = new Set(["search_code", "read_file", "git_status"]);
    // The exact reply that silently ended a worker in a live run.
    const flat = parseGeminiReply(
      { text: 'JSON\n{"name": "search_code", "pattern": "\\\\$bus"}', codeBlocks: ['{"name": "search_code", "pattern": "\\\\$bus"}'] },
      known
    );
    assert.equal(flat.kind, "tool_call");
    if (flat.kind === "tool_call") assert.deepEqual(flat.call, { name: "search_code", args: { pattern: "\\$bus" } });

    const alt = parseGeminiReply(toolCallResponseRaw('{"name": "read_file", "arguments": {"path": "a.txt"}}'), known);
    assert.ok(alt.kind === "tool_call" && alt.call.args.path === "a.txt");

    const noArgs = parseGeminiReply(toolCallResponseRaw('{"name": "git_status"}'), known);
    assert.ok(noArgs.kind === "tool_call" && noArgs.call.name === "git_status");

    // package.json in a final answer must stay prose.
    const pkg = parseGeminiReply(toolCallResponseRaw('{"name": "vue2-dashboard", "version": "1.0.0"}'), known);
    assert.equal(pkg.kind, "final");

    // A broken call naming a real tool gets a retry instead of ending the turn.
    const broken = parseGeminiReply(toolCallResponseRaw('{"name": "search_code", "pattern": oops}'), known);
    assert.equal(broken.kind, "malformed");
  });

  await test("formatToolResult never starts with a ``` fence", () => {
    // Regression guard for the live-UI bug: a message starting with a fence
    // flips the composer into code-block mode and silently never sends.
    const formatted = formatToolResult('{"some": "json"}');
    assert.ok(!formatted.trimStart().startsWith("```"), "must not lead with a code fence");
    assert.match(formatted, /TOOL_RESULT/);
  });

  console.log("Tools:");
  const testFile = path.join(".tmp-test", "hello.txt");
  await test("write_file then read_file round-trips content", async () => {
    const writeResult = await writeFileTool.run({ path: testFile, content: "hello gemini-code" });
    assert.equal(writeResult.ok, true);
    const readResult = await readFileTool.run({ path: testFile });
    assert.equal(readResult.ok, true);
    assert.equal(readResult.output, "hello gemini-code");
  });

  await test("write_file/read_file refuse to escape the project root", async () => {
    const result = await writeFileTool.run({ path: "../outside.txt", content: "nope" });
    assert.equal(result.ok, false);
    assert.match(result.output, /outside the workspace/);
  });

  await test("run_bash executes and returns stdout (auto-approved)", async () => {
    const result = await bashTool.run({ command: "echo hello-from-bash" });
    assert.equal(result.ok, true);
    assert.match(result.output, /hello-from-bash/);
  });

  console.log("Protocol drift (long threads):");
  await test("spots a reply that pasted code instead of calling a tool", () => {
    assert.ok(looksLikeAbandonedWork({
      text: "Sure! I'll create the file for you.\n\ndef add(a,b): return a+b",
      codeBlocks: ["def add(a,b): return a+b"],
    }));
    assert.ok(looksLikeAbandonedWork({
      text: "Here's the code — you can save it as app.py:",
      codeBlocks: ["print('hi')"],
    }));
  });

  await test("does not mistake a genuine answer that quotes code for drift", () => {
    assert.ok(!looksLikeAbandonedWork({
      text: "The bug is on line 4, where `add` returns a string.",
      codeBlocks: ["return str(a+b)"],
    }));
    assert.ok(!looksLikeAbandonedWork({ text: "The version is 1.2.3.", codeBlocks: [] }));
  });

  await test("nudges a drifted reply back to tool calls instead of stopping", async () => {
    const driver = new FakeDriver([
      // Gemini forgets the protocol and pastes code...
      { text: "I'll create the file now.\n\nprint('hi')", codeBlocks: ["print('hi')"] },
      // ...then complies after the reminder.
      toolCallResponse("write_file", { path: ".tmp-test/drift.py", content: "print('hi')" }),
      finalResponse("Created it."),
    ]);
    const answer = await new AgentSession(driver).runTask("create a script");
    assert.equal(answer, "Created it.", "must recover rather than ending with nothing done");
    assert.match(driver.sentMessages[1], /REMINDER/, "should restate the contract");
    assert.equal(driver.sentMessages.length, 3);
  });

  await test("finds a tool call written as prose, not as a code block", async () => {
    // A real complaint: "tool calls are not working, the response looks
    // normal". Gemini wrote the JSON as a sentence, so codeBlocks was empty
    // and the whole thing was accepted as a finished answer.
    const driver = new FakeDriver([
      {
        text: 'Sure — I will call {"name": "read_file", "args": {"path": "package.json"}} to check.',
        codeBlocks: [],
      },
      finalResponse("It is version 1.0.0."),
    ]);
    const answer = await new AgentSession(driver).runTask("what version is this?");
    assert.equal(answer, "It is version 1.0.0.");
    assert.match(driver.sentMessages[1], /TOOL_RESULT/, "the call must actually run");
  });

  await test("prose naming no tool stays a final answer", async () => {
    // The scan must not turn ordinary JSON in an answer into a tool call.
    const driver = new FakeDriver([
      finalResponse('The config is {"name": "my-app", "version": "2.0.0"} and that is all.'),
    ]);
    const answer = await new AgentSession(driver).runTask("what is in the config?");
    assert.match(answer, /my-app/);
    assert.equal(driver.sentMessages.length, 1, "no nudge, no tool call");
  });

  await test("a task that ends with no tool call at all is pushed to act", async () => {
    process.env.GEMINI_CODE_IDLE_NUDGES = "1";
    try {
      const driver = new FakeDriver([
        // Nothing here matches the drift wordings — the backstop is the only
        // thing that catches it.
        finalResponse("The fix would be to change the timeout in config.py."),
        toolCallResponse("write_file", { path: ".tmp-test/idle.txt", content: "done" }),
        finalResponse("Changed it."),
      ]);
      const answer = await new AgentSession(driver).runTask("fix the timeout");
      assert.equal(answer, "Changed it.");
      assert.match(driver.sentMessages[1], /without using a single tool/);
    } finally {
      process.env.GEMINI_CODE_IDLE_NUDGES = "0";
    }
  });

  await test("the backstop gives up after one try, so a question still gets answered", async () => {
    process.env.GEMINI_CODE_IDLE_NUDGES = "1";
    try {
      const driver = new FakeDriver([
        finalResponse("It uses PostgreSQL."),
        finalResponse("It uses PostgreSQL. That is the whole answer."),
      ]);
      const answer = await new AgentSession(driver).runTask("which database?");
      assert.match(answer, /PostgreSQL/);
      assert.equal(driver.sentMessages.length, 2, "nudged once, then accepted");
    } finally {
      process.env.GEMINI_CODE_IDLE_NUDGES = "0";
    }
  });

  await test("asking permission instead of acting counts as drift", () => {
    assert.equal(
      looksLikeAbandonedWork({ text: "Would you like me to update the config?", codeBlocks: [] }),
      true
    );
    assert.equal(
      looksLikeAbandonedWork({ text: "I'll now update the timeout in config.py.", codeBlocks: [] }),
      true
    );
    assert.equal(
      looksLikeAbandonedWork({ text: "The timeout is set in config.py, line 12.", codeBlocks: [] }),
      false,
      "a plain factual answer is not drift"
    );
  });

  await test("tells the model to change approach when one call keeps failing", async () => {
    // The screenshot from a real run: edit_file failing the same way over and
    // over until the turn limit, having changed nothing.
    const failing = toolCallResponse("edit_file", {
      path: ".tmp-test/nope.txt",
      old_text: "not there",
      new_text: "x",
    });
    const driver = new FakeDriver([
      failing,
      failing,
      failing,
      toolCallResponse("write_file", { path: ".tmp-test/stall.txt", content: "rewritten" }),
      finalResponse("Rewrote the file instead."),
    ]);
    const answer = await new AgentSession(driver).runTask("change that line");
    assert.equal(answer, "Rewrote the file instead.");
    const escalation = driver.sentMessages.find((m) => m.includes("STOP AND CHANGE APPROACH"));
    assert.ok(escalation, "the third identical failure must be called out");
    assert.match(escalation!, /3 attempts at edit_file/);
    assert.match(escalation!, /write_file/, "and name a way out");
  });

  await test("gives up nudging so it can't loop forever on a real answer", async () => {
    const stubborn = { text: "I'll do it: x=1", codeBlocks: ["x=1"] };
    const driver = new FakeDriver([stubborn, stubborn, stubborn, stubborn]);
    const answer = await new AgentSession(driver).runTask("do it");
    assert.match(answer, /I'll do it/, "accepts it as final once the nudges are spent");
    assert.ok(driver.sentMessages.length <= 4, "bounded, not an infinite nudge loop");
  });

  console.log("Project-root containment:");
  await test("a SIBLING directory that merely extends the root's name is refused", async () => {
    // The bug this guards: `abs.startsWith(process.cwd())` is a string
    // prefix test, so with the project at /home/me/app the path
    // ../app-secrets/creds.txt resolved to /home/me/app-secrets/creds.txt,
    // which "starts with" the root and was let through. read_file and
    // list_files have no confirm gate, so it leaked silently.
    const sibling = `${path.basename(process.cwd())}-escape-probe`;
    const outside = path.resolve(process.cwd(), "..", sibling);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "creds.txt"), "CANARY", "utf8");

    try {
      const rel = path.join("..", sibling, "creds.txt");

      const read = await readFileTool.run({ path: rel });
      assert.equal(read.ok, false, "read_file must refuse a sibling-directory path");
      assert.doesNotMatch(read.output, /CANARY/, "must not leak the file's contents");

      const list = await listFilesTool.run({ path: path.join("..", sibling) });
      assert.equal(list.ok, false, "list_files must refuse it too");
      assert.doesNotMatch(list.output, /creds\.txt/, "must not leak the directory listing");

      const wrote = await writeFileTool.run({ path: rel, content: "pwned" });
      assert.equal(wrote.ok, false, "write_file must refuse it");

      const edited = await editFileTool.run({ path: rel, old_text: "CANARY", new_text: "pwned" });
      assert.equal(edited.ok, false, "edit_file must refuse it");

      assert.equal(
        await readFile(path.join(outside, "creds.txt"), "utf8"),
        "CANARY",
        "the file outside the project must be untouched"
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  await test("ordinary paths inside the project still work", async () => {
    const inside = await readFileTool.run({ path: "package.json" });
    assert.equal(inside.ok, true, "a normal relative path must not be caught by the guard");

    const nested = await readFileTool.run({ path: "./src/../package.json" });
    assert.equal(nested.ok, true, "a path that leaves and returns is still inside the root");

    const root = await listFilesTool.run({ path: "." });
    assert.equal(root.ok, true, "the root itself is inside the root");
  });

  console.log("Long-running commands:");
  await test("recognises commands that never exit", () => {
    for (const cmd of ["npm run dev", "pnpm dev", "vite", "npx nodemon app.js", "uvicorn main:app",
                       "python3 -m http.server 8000", "tail -f log.txt", "next dev", "tsc --watch"]) {
      assert.ok(looksLongRunning(cmd), `should flag: ${cmd}`);
    }
    for (const cmd of ["npm run build", "ls -la", "pytest", "git status", "vite build", "npm test"]) {
      assert.ok(!looksLongRunning(cmd), `should NOT flag: ${cmd}`);
    }
  });

  await test("a server command is backgrounded instead of blocking the agent", async () => {
    const started = Date.now();
    const result = await bashTool.run({ command: "python3 -m http.server 8911" });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.match(result.output, /background/i, "must say it was backgrounded");
    assert.ok(elapsed < 5_000, `must return immediately, took ${elapsed}ms`);

    const id = String(result.output.match(/"(bg_[a-z0-9]+)"/)?.[1]);
    assert.ok(id.startsWith("bg_"), "returns a handle to read later");

    // Polled rather than a fixed wait: Python took longer than 1.5s to start
    // on a busy CI machine, which failed this for nothing. 127.0.0.1 because
    // http.server binds IPv4 and localhost can resolve to IPv6 first.
    const serving = () => fetch("http://127.0.0.1:8911").then((r) => r.ok).catch(() => false);
    const until = async (wanted: boolean) => {
      for (let i = 0; i < 80 && (await serving()) !== wanted; i++) await new Promise((r) => setTimeout(r, 250));
      return serving();
    };

    // It should actually be serving.
    assert.ok(await until(true), "the backgrounded server should really be running");

    const logs = await checkOutputTool.run({ id });
    assert.match(logs.output, /running/);

    // And killing it must take down the whole tree, not just the shell.
    await killProcessTool.run({ id });
    assert.equal(await until(false), false, "killing must stop the server, leaving no orphan holding the port");
  });

  await test("surfaces the error from the MIDDLE of a huge failing build", async () => {
    // The case tail-only output loses: 3000 lines with the failure buried
    // in the middle, so the last 25 lines explain nothing.
    const cmd = `node -e "for(let i=1;i<=600;i++)console.log('compiling mod-'+i);` +
      `console.error('ERROR: Cannot find name BuriedSymbol');` +
      `for(let i=601;i<=1200;i++)console.log('compiling mod-'+i);process.exit(1)"`;
    const r = await bashTool.run({ command: cmd });
    assert.equal(r.ok, false);
    assert.match(r.output, /BuriedSymbol/, "the real error must be surfaced, not just the tail");
    assert.match(r.output, /Error lines found/);
    assert.match(r.output, /saved as "fg_/, "should point at the saved log");
  });

  await test("says so when it shows only a tail, instead of passing it off as the whole output", async () => {
    // 40 lines, exit 0: under the old "is it big?" threshold, so the result
    // was the last 25 lines labelled only "[saved as ...]" — the model saw
    // output starting at "17" with nothing saying 16 lines were dropped.
    const r = await bashTool.run({ command: "seq 1 40" });
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.output, /^1$/m, "this really is a truncated tail");
    assert.match(r.output, /15 earlier line\(s\) not shown/, "the dropped lines must be disclosed");
    assert.match(r.output, /40 lines total/, "and the real size given");
  });

  await test("one enormous line is clipped and disclosed, not passed through whole", async () => {
    // A single 300 KB line has no "earlier lines" to drop, so a line-count
    // check alone let all of it through to the model.
    const r = await bashTool.run({ command: `node -e "process.stdout.write('x'.repeat(300000))"` });
    assert.equal(r.ok, true);
    assert.ok(r.output.length < 25_000, `output should be capped, was ${r.output.length} chars`);
    assert.match(r.output, /characters of an over-long line not shown/);
  });

  await test("output short enough to show in full is not labelled as truncated", async () => {
    const r = await bashTool.run({ command: "seq 1 5" });
    assert.equal(r.ok, true);
    assert.match(r.output, /^1$/m, "all of it is there");
    assert.doesNotMatch(r.output, /not shown/, "nothing was dropped, so claim nothing was");
  });

  await test("check_output greps a saved log with context", async () => {
    const cmd = `node -e "for(let i=1;i<=300;i++)console.log('line '+i);console.log('NEEDLE here');process.exit(0)"`;
    const r = await bashTool.run({ command: cmd });
    const useId = String(r.output.match(/"(fg_[a-z0-9]+)"/)?.[1] ?? "");
    assert.ok(useId, "every run should report the id of its saved log");

    const listed = await checkOutputTool.run({});
    assert.match(listed.output, /foreground/, "finished foreground commands are listed too");

    const g = await checkOutputTool.run({ id: useId, grep: "NEEDLE", context: 1 });
    assert.equal(g.ok, true, g.output);
    assert.match(g.output, /NEEDLE here/);
    assert.match(g.output, /matching line/);

    const none = await checkOutputTool.run({ id: useId, grep: "zzz-not-present-zzz" });
    assert.match(none.output, /No lines matching/);

    const bad = await checkOutputTool.run({ id: useId, grep: "([unclosed" });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /Invalid 'grep'/);
  });

  await test("GEMINI_CODE_SHELL overrides the shell commands run in", () => {
    const before = process.env.GEMINI_CODE_SHELL;
    try {
      process.env.GEMINI_CODE_SHELL = "powershell.exe";
      assert.equal(resolveShell(), "powershell.exe");
      delete process.env.GEMINI_CODE_SHELL;
      // Off Windows, the default is Node's own /bin/sh.
      if (process.platform !== "win32") assert.equal(resolveShell(), true);
    } finally {
      if (before === undefined) delete process.env.GEMINI_CODE_SHELL;
      else process.env.GEMINI_CODE_SHELL = before;
    }
  });

  await test("run_bash tells the model which shell and OS it's in", () => {
    // On Windows that's the difference between writing bash and cmd syntax.
    assert.match(bashTool.description, new RegExp(`on ${process.platform}`));
    assert.match(bashTool.description, /shell: /);
  });

  await test("check_output lists processes and rejects unknown ids", async () => {
    const list = await checkOutputTool.run({});
    assert.ok(typeof list.output === "string");
    const bad = await checkOutputTool.run({ id: "bg_nope" });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /No saved output/);
  });

  console.log("Stopping early (progress reports treated as final):");
  await test("spots a progress report that isn't actually finished", () => {
    // The exact shape seen in a real migration run.
    assert.ok(looksUnfinished({
      text: "The migration of ClientApp to Vue 3 and Kite 2.0 is underway.\n\n1. Package Architecture\nDependencies Updated",
      codeBlocks: [],
    }));
    assert.ok(looksUnfinished({ text: "I will now update the router configuration.", codeBlocks: [] }));
    assert.ok(looksUnfinished({ text: "Done with step 1. Next steps: migrate the views.", codeBlocks: [] }));
    assert.ok(looksUnfinished({ text: "So far: 3 of 8 components converted.", codeBlocks: [] }));
  });

  await test("lets a genuinely finished answer end the task", () => {
    assert.ok(!looksUnfinished({ text: "The migration is complete. All 8 components now use Vue 3.", codeBlocks: [] }));
    assert.ok(!looksUnfinished({ text: "The version in package.json is 1.2.3.", codeBlocks: [] }));
    assert.ok(!looksUnfinished({ text: "I have successfully implemented the login form.", codeBlocks: [] }));
    assert.ok(!looksUnfinished({ text: "All steps are done.", codeBlocks: [] }));
  });

  await test("pushes on when the plan still has open steps", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    const journal = new PlanJournal(root);
    const driver = new FakeDriver([
      // The agent records its plan...
      toolCallResponse("update_plan", {
        steps: [{ title: "update deps", done: false }, { title: "migrate views", done: false }],
      }),
      // ...then stops early with a progress report, which used to end the task.
      finalResponse("Migration underway. Package architecture updated."),
      // After the nudge it carries on and ticks the steps off.
      toolCallResponse("update_plan", {
        steps: [{ title: "update deps", done: true }, { title: "migrate views", done: true }],
      }),
      finalResponse("The migration is complete."),
    ]);
    const session = new AgentSession(driver, {}, [createUpdatePlanTool(journal)], journal);

    const answer = await session.runTask("migrate the app");
    assert.equal(answer, "The migration is complete.", "must not stop on the progress report");
    const nudge = driver.sentMessages.find((m) => /not a finished task/.test(m));
    assert.ok(nudge, "should have pushed it to continue");
    assert.match(String(nudge), /update deps/, "should name the open steps");
    await clearPlan(root);
  });

  await test("gives up nudging so a real answer can't loop forever", async () => {
    const stubborn = finalResponse("Work is underway, next steps to follow.");
    const driver = new FakeDriver([stubborn, stubborn, stubborn, stubborn, stubborn, stubborn]);
    const answer = await new AgentSession(driver).runTask("do it");
    assert.match(answer, /underway/, "accepts it once the nudges are spent");
    assert.ok(driver.sentMessages.length <= 5, `bounded, sent ${driver.sentMessages.length}`);
  });

  console.log("Web search:");
  await test("parses results out of the search HTML", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpypi.org%2Fproject%2Ffastapi%2F&amp;rut=x">fastapi &middot; PyPI</a>
      <a class="result__snippet" href="#">FastAPI is a modern, <b>fast</b> web framework.</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffastapi.tiangolo.com%2F">FastAPI docs</a>`;
    const results = parseResults(html, 5);
    assert.equal(results.length, 2);
    // The redirect wrapper must be unwrapped to the real destination.
    assert.equal(results[0].url, "https://pypi.org/project/fastapi/");
    assert.match(results[0].title, /fastapi/i);
    assert.match(results[0].snippet, /modern, fast web framework/);
    assert.equal(results[1].url, "https://fastapi.tiangolo.com/");
  });

  await test("web_search requires a query", async () => {
    const r = await webSearchTool.run({});
    assert.equal(r.ok, false);
    assert.match(r.output, /'query' is required/);
  });

  console.log("Confirmation prompts:");
  await test("asks through the REPL's reader, not a second one on stdin", async () => {
    // Two readlines on one stdin echo every keystroke twice ("yy") and both
    // receive the line, so the answer also reached the REPL and was sent to
    // Gemini as a task. Confirmations must go through the registered asker.
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    const asked: string[] = [];
    setAsker(async (question) => {
      asked.push(question);
      return "y";
    });
    try {
      const approved = await confirmAction("Do the thing?", "details here");
      assert.equal(approved, true);
      assert.equal(asked.length, 1, "must ask exactly once, through the owner");
      assert.match(asked[0], /Do the thing\?/);
      assert.match(asked[0], /\(y\/N\)/);
    } finally {
      setAsker(undefined);
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
    }
  });

  await test("treats anything other than y as a refusal", async () => {
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    try {
      for (const reply of ["n", "", "no", "yes please", "Y "]) {
        setAsker(async () => reply);
        const approved = await confirmAction("Run?", "rm -rf /");
        assert.equal(approved, reply.trim().toLowerCase() === "y", `reply ${JSON.stringify(reply)}`);
      }
    } finally {
      setAsker(undefined);
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
    }
  });

  await test("auto-approve skips the prompt entirely", async () => {
    let askedAnything = false;
    setAsker(async () => {
      askedAnything = true;
      return "n";
    });
    try {
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
      assert.equal(await confirmAction("Run?", "ls"), true);
      assert.equal(askedAnything, false, "must not prompt when auto-approving");
    } finally {
      setAsker(undefined);
    }
  });

  console.log("Checkpoints (/undo):");
  await test("restores overwritten files and deletes newly-created ones", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    const store = new CheckpointStore(root);
    const existing = path.join(root, "keep.txt");
    const fresh = path.join(root, "new.txt");
    await writeFileTool.run({ path: path.join(".tmp-test", "keep.txt"), content: "ORIGINAL" });

    store.begin("do some damage");
    await store.recordBeforeWrite(existing);
    await writeFile(existing, "CLOBBERED", "utf8");
    await store.recordBeforeWrite(fresh);
    await writeFile(fresh, "brand new", "utf8");
    await store.commit();

    const result = await store.undoLast();
    assert.equal(result.ok, true, result.message);
    assert.equal(await readFile(existing, "utf8"), "ORIGINAL", "overwritten file must be restored");
    const stillThere = await readFile(fresh, "utf8").catch(() => undefined);
    assert.equal(stillThere, undefined, "a file created by the task must be removed again");
  });

  await test("keeps the FIRST version of a file edited repeatedly in one task", async () => {
    // Undo should go back to before the task, not to the second-to-last edit.
    const root = path.resolve(process.cwd(), ".tmp-test");
    const store = new CheckpointStore(root);
    const f = path.join(root, "multi.txt");
    await writeFile(f, "v1", "utf8");

    store.begin("edit twice");
    await store.recordBeforeWrite(f);
    await writeFile(f, "v2", "utf8");
    await store.recordBeforeWrite(f);
    await writeFile(f, "v3", "utf8");
    await store.commit();

    await store.undoLast();
    assert.equal(await readFile(f, "utf8"), "v1", "must restore the pre-task state");
  });

  await test("undo with nothing recorded says so instead of failing", async () => {
    const store = new CheckpointStore(path.resolve(process.cwd(), ".tmp-test", "empty"));
    const r = await store.undoLast();
    assert.equal(r.ok, false);
    assert.match(r.message, /Nothing to undo/);
  });

  console.log("Editing, search and git:");
  await test("edit_file changes only the targeted text", async () => {
    const f = path.join(".tmp-test", "edit.ts");
    await writeFileTool.run({ path: f, content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" });
    const r = await editFileTool.run({ path: f, old_text: "const b = 2;", new_text: "const b = 20;" });
    assert.equal(r.ok, true, r.output);
    const after = await readFile(path.resolve(f), "utf8");
    assert.equal(after, "const a = 1;\nconst b = 20;\nconst c = 3;\n", "surrounding lines must be untouched");
  });

  await test("edit_file REFUSES an ambiguous match rather than guessing", async () => {
    // The whole safety property: picking "the first one" would silently
    // edit a line the model didn't mean.
    const f = path.join(".tmp-test", "dup.ts");
    await writeFileTool.run({ path: f, content: "x = 1;\nx = 1;\n" });
    const r = await editFileTool.run({ path: f, old_text: "x = 1;", new_text: "x = 2;" });
    assert.equal(r.ok, false);
    assert.match(r.output, /appears 2 times/);
    const untouched = await readFile(path.resolve(f), "utf8");
    assert.equal(untouched, "x = 1;\nx = 1;\n", "the file must not be modified on an ambiguous edit");

    const all = await editFileTool.run({ path: f, old_text: "x = 1;", new_text: "x = 2;", replace_all: true });
    assert.equal(all.ok, true);
    assert.equal(await readFile(path.resolve(f), "utf8"), "x = 2;\nx = 2;\n");
  });

  await test("edit_file explains a miss instead of corrupting the file", async () => {
    const f = path.join(".tmp-test", "edit.ts");
    const before = await readFile(path.resolve(f), "utf8");
    const r = await editFileTool.run({ path: f, old_text: "not in the file", new_text: "y" });
    assert.equal(r.ok, false);
    assert.match(r.output, /that text isn't in/);
    assert.equal(await readFile(path.resolve(f), "utf8"), before, "file unchanged after a failed edit");
  });

  await test("read_file returns verbatim text that edit_file can match", async () => {
    // Line numbers in read_file output would make every edit fail, since
    // the model copies from it into old_text.
    const f = path.join(".tmp-test", "verbatim.ts");
    await writeFileTool.run({ path: f, content: "alpha\nbeta\ngamma\n" });
    const read = await readFileTool.run({ path: f });
    assert.ok(!/^\s*\d+\s/m.test(read.output), "must not prefix lines with numbers");
    const edit = await editFileTool.run({ path: f, old_text: "beta", new_text: "delta" });
    assert.equal(edit.ok, true, "text copied from read_file must match");
  });

  await test("read_file windows a large file instead of dumping it", async () => {
    const f = path.join(".tmp-test", "big.txt");
    await writeFileTool.run({ path: f, content: Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\n") });
    const head = await readFileTool.run({ path: f });
    assert.match(head.output, /more lines/, "should say there's more rather than returning everything");
    assert.ok(!head.output.includes("line 900"), "must not dump the whole file");

    const windowed = await readFileTool.run({ path: f, offset: 500, limit: 3 });
    assert.match(windowed.output, /line 500/);
    assert.match(windowed.output, /line 502/);
    assert.ok(!windowed.output.includes("line 503"));
  });

  await test("edit_file works on a CRLF file, and keeps it CRLF", async () => {
    // The real Windows failure: the checkout is CRLF, the model reproduces the
    // line with LF, and every edit is rejected until the turn limit is hit.
    const crlf = path.join(".tmp-test", "crlf.js");
    await writeFile(crlf, "function a() {\r\n  return 1;\r\n}\r\n", "utf8");
    await readFileTool.run({ path: crlf });
    const r = await editFileTool.run({ path: crlf, old_text: "function a() {\n  return 1;\n}", new_text: "function a() {\n  return 2;\n}" });
    assert.equal(r.ok, true, r.output);
    const after = await readFile(path.resolve(crlf), "utf8");
    assert.equal(after, "function a() {\r\n  return 2;\r\n}\r\n", "content changed and CRLF preserved");
  });

  await test("edit_file tolerates trailing spaces and indentation, and says so", async () => {
    const f = path.join(".tmp-test", "ws.py");
    await writeFile(f, "def f():\n        value = 1\n        return value\n", "utf8");
    await readFileTool.run({ path: f });

    // The model's copy carries trailing spaces the file doesn't have.
    const trailing = await editFileTool.run({ path: f, old_text: "        value = 1   ", new_text: "        value = 2" });
    assert.equal(trailing.ok, true, trailing.output);
    assert.match(trailing.output, /ignoring trailing whitespace/);

    // Model sends the block with its own (wrong) indentation.
    const indented = await editFileTool.run({ path: f, old_text: "  value = 2\n  return value", new_text: "  value = 3\n  return value * 2" });
    assert.equal(indented.ok, true, indented.output);
    assert.match(indented.output, /ignoring indentation/);
    const after = await readFile(path.resolve(f), "utf8");
    assert.equal(after, "def f():\n        value = 3\n        return value * 2\n", "re-indented to the file, not the model");
  });

  await test("edit_file and write_file refuse files the model never read, or that changed since", async () => {
    const f = path.join(".tmp-test", "gate.ts");
    await writeFile(f, "export const a = 1;\n", "utf8");
    const unread = await editFileTool.run({ path: f, old_text: "a = 1", new_text: "a = 2" });
    assert.equal(unread.ok, false);
    assert.match(unread.output, /haven't read/);
    const blind = await writeFileTool.run({ path: f, content: "export const a = 9;\n" });
    assert.equal(blind.ok, false);
    assert.match(blind.output, /already exists and you haven't read/);

    await readFileTool.run({ path: f });
    const ok = await editFileTool.run({ path: f, old_text: "a = 1", new_text: "a = 2" });
    assert.equal(ok.ok, true, ok.output);
    assert.match(ok.output, /now read:\n[\s\S]*a = 2/, "the result shows the edited region");

    // Someone else changes it: the next edit must re-read first.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(f, "export const a = 2;\nexport const b = 3;\n", "utf8");
    const stale = await editFileTool.run({ path: f, old_text: "b = 3", new_text: "b = 4" });
    assert.equal(stale.ok, false);
    assert.match(stale.output, /changed on disk/);
    await readFileTool.run({ path: f });
    assert.equal((await editFileTool.run({ path: f, old_text: "b = 3", new_text: "b = 4" })).ok, true);
  });

  await test("read_file suggests the right path when the model guesses wrong", async () => {
    await mkdir(path.join(".tmp-test", "deep", "er"), { recursive: true });
    await writeFile(path.join(".tmp-test", "deep", "er", "config_loader.py"), "x = 1\n", "utf8");
    const miss = await readFileTool.run({ path: ".tmp-test/config_loader.py" });
    assert.equal(miss.ok, false);
    assert.match(miss.output, /Did you mean[\s\S]*deep\/er\/config_loader\.py/);
  });

  await test("find_files globs the workspace; search_code takes a path scope", async () => {
    const found = await findFilesTool.run({ glob: "**/config_loader.py", path: ".tmp-test" });
    assert.equal(found.ok, true);
    assert.match(found.output, /\.tmp-test\/deep\/er\/config_loader\.py/);
    const scoped = await searchCodeTool.run({ pattern: "x = 1", path: ".tmp-test/deep" });
    assert.equal(scoped.ok, true, scoped.output);
    assert.match(scoped.output, /\.tmp-test\/deep\/er\/config_loader\.py:1/);
    const outside = await searchCodeTool.run({ pattern: "x", path: "../../" });
    assert.equal(outside.ok, false);
    assert.match(outside.output, /outside the workspace/);
  });

  await test("workspace roots: paths resolve into added roots and nowhere else", async () => {
    const sibling = path.resolve(process.cwd(), "..", ".tmp-test-sibling");
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, "lib.py"), "def dep(): return 42\n", "utf8");
    try {
      assert.equal(resolveInWorkspace("../.tmp-test-sibling/lib.py").ok, false, "not a root yet");
      const added = addRoot(sibling);
      assert.ok(added.ok && added.added);
      const r = resolveInWorkspace("../.tmp-test-sibling/lib.py");
      assert.ok(r.ok && r.root.name === ".tmp-test-sibling");
      assert.equal(displayPath(path.join(sibling, "lib.py")), "../.tmp-test-sibling/lib.py");
      assert.equal(resolveInWorkspace("../.tmp-test-sibling-evil/x").ok, false, "a sibling with a longer name is not inside");
      const read = await readFileTool.run({ path: "../.tmp-test-sibling/lib.py" });
      assert.equal(read.ok, true);
      assert.match(read.output, /def dep/);
      const hits = await searchCodeTool.run({ pattern: "def dep", path: "../.tmp-test-sibling" });
      assert.match(hits.output, /\.\.\/\.tmp-test-sibling\/lib\.py:1/);
      const ran = await bashTool.run({ command: "pwd", cwd: "../.tmp-test-sibling" });
      assert.ok(ran.output.includes(".tmp-test-sibling"), ran.output);
      assert.deepEqual(rootsFromArgs(["--add-dir", "a", "--add-dir=b"], { GEMINI_CODE_ADD_DIRS: `c${path.delimiter}d` }), ["a", "b", "c", "d"]);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  await test("approval levels: edits can run while commands and requests still ask", () => {
    assert.equal(autoApproved("edit", ""), false);
    assert.equal(autoApproved("edit", "0"), false);
    assert.equal(autoApproved("edit", "1"), true);
    assert.equal(autoApproved("network", "all"), true);
    assert.equal(autoApproved("edit", "edits"), true);
    assert.equal(autoApproved("command", "edits"), false);
    assert.equal(autoApproved("command", "edits,commands"), true);
    assert.equal(autoApproved("network", "edits,commands"), false);
  });

  await test("edit_file still refuses a wrong or ambiguous edit, with the nearest lines", async () => {
    const f = path.join(".tmp-test", "miss.js");
    await writeFile(f, "const timeout = 30;\nconst retries = 3;\n", "utf8");
    await readFileTool.run({ path: f });

    const wrong = await editFileTool.run({ path: f, old_text: "const timeout = 99;", new_text: "const timeout = 60;" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.output, /closest lines/);
    assert.match(wrong.output, /const timeout = 30;/, "shows the real line so it can correct itself");

    await writeFile(f, "a = 1;\na = 1;\n", "utf8");
    await readFileTool.run({ path: f });
    const ambiguous = await editFileTool.run({ path: f, old_text: "a = 1;", new_text: "a = 2;" });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.output, /appears 2 times/);

    const all = await editFileTool.run({ path: f, old_text: "a = 1;", new_text: "a = 2;", replace_all: true });
    assert.equal(all.ok, true, all.output);
    assert.equal(await readFile(path.resolve(f), "utf8"), "a = 2;\na = 2;\n");
  });

  await test("matcher prefers the most exact tier and keeps relative indentation", () => {
    assert.equal(detectEol("a\r\nb\r\n"), "\r\n");
    assert.equal(detectEol("a\nb\n"), "\n");

    // An exact match must win even when a sloppier one also exists.
    const content = "x = 1\n  x = 1\n";
    const exact = findSpans(content, "  x = 1");
    assert.equal(exact?.how, "exact");

    assert.equal(findSpans("if a:\n    b()\n", "if a:\n  b()")?.how, "indentation");
    assert.equal(findSpans("value = 2", "value = 9"), undefined, "different characters never match");

    assert.equal(reindent("if x:\n  y()\n  z()", "    "), "    if x:\n      y()\n      z()");
    assert.equal(nearestContext("aaa\nbbb\n", "zzz"), undefined, "no misleading 'closest' line");
  });

  await test("search_code finds matches and skips noise directories", async () => {
    const r = await searchCodeTool.run({ pattern: "looksLikeAbandonedWork", glob: "*.ts" });
    assert.equal(r.ok, true);
    assert.match(r.output, /toolCallParser\.ts:\d+/);
    assert.ok(!r.output.includes("node_modules"), "must not search dependencies");

    // Built at runtime so the literal never appears in this file — the
    // first version of this test matched its own source and "failed".
    const absent = ["zq7", "nope", "marker"].join("_");
    const none = await searchCodeTool.run({ pattern: absent });
    assert.match(none.output, /No matches/);

    const bad = await searchCodeTool.run({ pattern: "([unclosed" });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /invalid regular expression/);
  });

  await test("search_code globs match paths as well as filenames", async () => {
    // A real Gemini run used "src/components/*.vue" and got "searched 0
    // files", because the glob was only ever tested against the basename.
    const byPath = await searchCodeTool.run({ pattern: "looksLikeAbandonedWork", glob: "src/agent/*.ts" });
    assert.match(byPath.output, /toolCallParser\.ts:\d+/);
    const deep = await searchCodeTool.run({ pattern: "looksLikeAbandonedWork", glob: "src/**/*.ts" });
    assert.match(deep.output, /toolCallParser\.ts:\d+/);
    const wrongDir = await searchCodeTool.run({ pattern: "looksLikeAbandonedWork", glob: "src/tools/*.ts" });
    assert.ok(!/toolCallParser\.ts/.test(wrongDir.output), "must not match outside the given directory");

    assert.ok(globToRegExp("*.{ts,vue}").test("App.vue"));
    assert.ok(!globToRegExp("*.{ts,vue}").test("a,b.js"));
    assert.ok(globToRegExp("./src/**/x.ts").test("src/x.ts"), "** matches zero directories");
    assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"), "* stays within one segment");
  });

  await test("git_status and git_diff report on the working tree", async () => {
    const status = await gitStatusTool.run({});
    assert.equal(status.ok, true, status.output);
    assert.match(status.output, /On branch/);
    const diff = await gitDiffTool.run({ stat: true });
    assert.equal(diff.ok, true, diff.output);
  });

  console.log("Agent loop (against a fake driver, no real browser):");
  await test("runs a tool call then returns the final answer", async () => {
    const targetPath = path.join(".tmp-test", "loop-output.txt");
    const driver = new FakeDriver([
      toolCallResponse("write_file", { path: targetPath, content: "written by the agent loop" }),
      finalResponse("Done — I created the file."),
    ]);
    const session = new AgentSession(driver);

    const answer = await session.runTask("create a test file");

    assert.equal(answer, "Done — I created the file.");
    assert.equal(driver.sentMessages.length, 2, "expected one prompt, then one tool result reply");
    assert.match(driver.sentMessages[0], /TASK:\ncreate a test file/);
    // Plain delimiter, NOT a ``` fence — see formatToolResult's comment: a
    // message starting with a fence silently never sends in the real UI.
    assert.match(driver.sentMessages[1], /TOOL_RESULT >>>/);
    assert.ok(!driver.sentMessages[1].startsWith("```"), "must not start with a code fence");
    assert.match(driver.sentMessages[1], /Wrote \d+ bytes/);

    const written = await readFile(path.resolve(process.cwd(), targetPath), "utf8");
    assert.equal(written, "written by the agent loop");
  });

  await test("retries once when Gemini emits malformed tool JSON", async () => {
    const driver = new FakeDriver([
      malformedToolResponse('{"name": "read_file", "args": {oops}'),
      finalResponse("Understood, here's my final answer instead."),
    ]);
    const session = new AgentSession(driver);
    const answer = await session.runTask("do something");
    assert.equal(answer, "Understood, here's my final answer instead.");
    assert.match(driver.sentMessages[1], /wasn't valid/);
  });

  await test("uploads oversized tool output as a file instead of pasting it", async () => {
    // Write a file bigger than the inline limit, then have the agent read it.
    const bigPath = path.join(".tmp-test", "big.txt");
    const bigContent = "x".repeat(9_000);
    await writeFileTool.run({ path: bigPath, content: bigContent });

    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: bigPath }),
      finalResponse("Got the big file."),
    ]);
    const session = new AgentSession(driver);
    await session.runTask("read the big file");

    // The second message must NOT contain the payload — it should say the
    // result was attached, and carry an actual attachment path.
    assert.ok(!driver.sentMessages[1].includes(bigContent), "payload must not be pasted inline");
    assert.match(driver.sentMessages[1], /ATTACHED/);
    assert.ok(driver.attachedFiles[1], "expected an attached file on the tool-result turn");
    assert.match(String(driver.attachedFiles[1]), /big\.txt$/);
  });

  await test("keeps small tool output inline (no attachment)", async () => {
    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: testFile }),
      finalResponse("Read it."),
    ]);
    const session = new AgentSession(driver);
    await session.runTask("read the small file");
    assert.match(driver.sentMessages[1], /hello gemini-code/);
    assert.equal(driver.attachedFiles[1], undefined);
  });

  await test("fetch_url validates the URL and refuses non-http schemes", async () => {
    assert.match((await fetchUrlTool.run({})).output, /'url' is required/);
    assert.match((await fetchUrlTool.run({ url: "not a url" })).output, /not a valid URL/);
    assert.match((await fetchUrlTool.run({ url: "file:///etc/passwd" })).output, /only http\/https/);
    assert.match((await fetchUrlTool.run({ url: "ftp://example.com" })).output, /only http\/https/);
  });

  console.log("Context document:");
  await test("collects project .md docs, excluding GEMINI.md and noise dirs", async () => {
    const docs = await collectProjectDocs();
    const paths = docs.map((d) => d.path);
    assert.ok(paths.includes("README.md"), `expected README.md, got ${paths.join(", ")}`);
    assert.ok(!paths.includes(MEMORY_FILENAME), "GEMINI.md is carried separately as memory");
    assert.ok(!paths.some((p) => p.includes("node_modules")), "must skip node_modules");
  });

  await test("context document carries tree, memory and docs", () => {
    const doc = buildContextDocument({
      tree: "proj/\n└── a.ts",
      memory: "- uses pnpm",
      docs: [{ path: "README.md", content: "# Hello" }],
    });
    assert.match(String(doc), /Project structure/);
    assert.match(String(doc), /a\.ts/);
    assert.match(String(doc), /uses pnpm/);
    assert.match(String(doc), /README\.md/);
    assert.match(String(doc), /# Hello/);
    assert.equal(buildContextDocument({}), undefined, "nothing to send -> undefined");
  });

  await test("large context is attached as a file, not pasted inline", async () => {
    const bigTree = Array.from({ length: 500 }, (_, i) => `├── file-${i}.ts`).join("\n");
    const driver = new FakeDriver([finalResponse("ok")]);
    const session = new AgentSession(driver, { tree: bigTree });
    await session.runTask("say hi");

    const first = driver.sentMessages[0];
    // Rules must stay inline — Gemini can't emit a valid tool call without
    // them, so they must not depend on it opening the attachment first.
    assert.match(first, /RULES FOR USING TOOLS/);
    assert.ok(!first.includes("file-499.ts"), "bulk context must not be pasted inline");
    assert.match(first, /ATTACHED/);
    assert.ok(driver.attachedFiles[0], "expected a context attachment");
    // Short, stable filename on purpose — the attachment chip ellipsizes
    // long names, which broke the upload-succeeded check against the UI.
    assert.match(String(driver.attachedFiles[0]), /context\.md$/);
  });

  await test("small context stays inline (no attachment)", async () => {
    const driver = new FakeDriver([finalResponse("ok")]);
    const session = new AgentSession(driver, { tree: "proj/\n└── a.ts" });
    await session.runTask("say hi");
    assert.match(driver.sentMessages[0], /a\.ts/);
    assert.equal(driver.attachedFiles[0], undefined);
  });

  await test("mid-task input is injected as steering on the next turn", async () => {
    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: "package.json" }),
      finalResponse("done"),
    ]);
    const session = new AgentSession(driver);
    // Simulates the user typing AFTER the task is already under way:
    // nothing queued on turn 1, something queued by turn 2.
    let turn = 0;
    await session.runTask("build a thing", {
      getSteering: () => (turn++ === 0 ? [] : ["actually use TypeScript, not JS"]),
    });
    assert.ok(!driver.sentMessages[0].includes("USER UPDATE"), "nothing to steer with yet on turn 1");
    assert.match(driver.sentMessages[1], /USER UPDATE/);
    assert.match(driver.sentMessages[1], /use TypeScript, not JS/);
    // Steering leads the message so the model reads the correction first.
    assert.ok(
      driver.sentMessages[1].indexOf("USER UPDATE") < driver.sentMessages[1].indexOf("TOOL_RESULT"),
      "steering should precede the tool result"
    );
  });

  await test("a failed turn is retried by RE-SENDING, not just re-waiting", async () => {
    // The real-world failure is Gemini accepting a message then never
    // replying — so a retry that only waits again can never recover. The
    // retry must re-send.
    let sends = 0;
    let waits = 0;
    const flaky: IGeminiDriver = {
      async sendPrompt() {
        sends++;
      },
      async waitForResponseComplete() {
        waits++;
        if (waits < 2) throw new Error("no new response ever appeared");
      },
      async getLastResponse() {
        return finalResponse("recovered");
      },
    } as unknown as IGeminiDriver;

    const answer = await new AgentSession(flaky).runTask("do it");
    assert.equal(answer, "recovered");
    assert.equal(waits, 2, "waited twice");
    assert.equal(sends, 2, "must have re-sent the message, not just waited again");
  });

  console.log("Attachments (images & screenshots):");
  await test("a tool that returns an attachment gets it sent with the result", async () => {
    const shot = path.join(".tmp-test", "shot.png");
    await writeFileTool.run({ path: shot, content: "fake-png" });
    const fakeTool = {
      name: "screenshot_page",
      description: "screenshot_page(args) -> attaches an image",
      run: async () => ({ ok: true, output: "Screenshot attached.", attachment: path.resolve(shot) }),
    };
    const driver = new FakeDriver([
      toolCallResponse("screenshot_page", { url: "http://localhost:3000" }),
      finalResponse("looks good"),
    ]);
    await new AgentSession(driver, {}, [fakeTool]).runTask("check the page");
    assert.deepEqual(driver.attachedFiles[1], [path.resolve(shot)], "the image must ride along with the result");
    assert.match(driver.sentMessages[1], /Screenshot attached/);
  });

  await test("user-supplied images are attached to the first message", async () => {
    const img = path.resolve(".tmp-test", "mine.png");
    await writeFileTool.run({ path: path.join(".tmp-test", "mine.png"), content: "x" });
    const driver = new FakeDriver([finalResponse("ok")]);
    await new AgentSession(driver).runTask("what is in this image?", { attachments: [img] });
    assert.deepEqual(driver.attachedFiles[0], [img]);
  });

  await test("NEVER deletes a user's own file after sending it", async () => {
    // Attachments we generate live in .gemini-code-tmp and are cleaned up;
    // a file the user pointed at is theirs and must survive.
    const mine = path.join(".tmp-test", "keep-me.png");
    await writeFileTool.run({ path: mine, content: "precious" });
    const absolute = path.resolve(mine);
    const driver = new FakeDriver([finalResponse("ok")]);
    await new AgentSession(driver).runTask("look at this", { attachments: [absolute] });
    const survived = await readFile(absolute, "utf8").catch(() => undefined);
    assert.equal(survived, "precious", "the user's file must still exist after being sent");
  });

  await test("recognises image paths, including dragged-in quoted ones", () => {
    assert.ok(isImagePath("/tmp/a.png"));
    assert.ok(isImagePath("shot.JPEG"));
    assert.ok(!isImagePath("notes.txt"));
    assert.equal(normalizeDroppedPath("'/tmp/my shot.png'"), "/tmp/my shot.png");
    assert.equal(normalizeDroppedPath("/tmp/my\\ shot.png"), "/tmp/my shot.png");
  });

  console.log("Orchestrator / worker roles:");
  await test("orchestrator is told to delegate, not to write code itself", () => {
    const primer = buildSystemPrimer([], "orchestrator");
    assert.match(primer, /ORCHESTRATOR/);
    assert.match(primer, /DO NOT write application code yourself/);
    assert.match(primer, /VALIDATE/);
    assert.match(primer, /CORRECTION round/);
  });

  await test("worker is told to report briefly, never paste code back", () => {
    const primer = buildSystemPrimer([], "worker");
    assert.match(primer, /WORKER/);
    assert.match(primer, /SHORT REPORT/);
    assert.match(primer, /Never paste full file contents/);
    assert.ok(!/ORCHESTRATOR \(main thread\)/.test(primer), "worker must not get orchestrator rules");
  });

  await test("a worker report that ignores instructions is truncated anyway", async () => {
    const fakeParent = {
      async spawnTab() {
        return { setModel: async () => "Flash", close: async () => {} };
      },
    } as unknown as Parameters<typeof runParallelTasks>[1]["parent"];
    const huge = "x".repeat(MAX_WORKER_REPORT_CHARS + 5_000);
    const [result] = await runParallelTasks([{ name: "w", prompt: "p" }], {
      parent: fakeParent,
      context: {},
      log: () => {},
      createSession: () => ({ runTask: async () => huge }),
    });
    assert.ok(
      result.result.length < huge.length,
      "the orchestrator's context must be protected even from a misbehaving worker"
    );
    assert.match(result.result, /report truncated/);
  });

  console.log("Plan journal (crash resumability):");
  await test("journals task, steps and progress to disk as it goes", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    const journal = new PlanJournal(root);
    await journal.begin("build an API");
    await journal.setSteps([{ title: "create app", done: true }, { title: "add tests", done: false }]);
    await journal.log("write_file(app.py) -> ok");

    const mid = await readPlan(root);
    assert.equal(mid?.status, "in_progress", "an unfinished task stays in_progress on disk");
    assert.match(String(mid?.raw), /build an API/);
    assert.match(String(mid?.raw), /- \[x\] create app/);
    assert.match(String(mid?.raw), /- \[ \] add tests/);
    assert.match(String(mid?.raw), /write_file\(app\.py\)/);

    // Written progressively, so a crash right here still leaves it resumable.
    const resumable = await findResumablePlan(root);
    assert.ok(resumable, "an in_progress plan must be offered for resume");

    await journal.complete("done");
    assert.equal((await readPlan(root))?.status, "completed");
    assert.equal(await findResumablePlan(root), undefined, "a finished plan is not resumed");
  });

  await test("an interrupted plan is marked and stays resumable", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    await clearPlan(root);
    const journal = new PlanJournal(root);
    await journal.begin("long task");
    await journal.markInterrupted("session terminated");
    const plan = await readPlan(root);
    assert.equal(plan?.status, "interrupted");
    assert.ok(await findResumablePlan(root), "interrupted work must be resumable");
    await clearPlan(root);
  });

  await test("the agent loop journals automatically, without model cooperation", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    await clearPlan(root);
    const journal = new PlanJournal(root);
    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: "package.json" }),
      finalResponse("all done"),
    ]);
    await new AgentSession(driver, {}, [], journal).runTask("inspect the project");
    const plan = await readPlan(root);
    assert.match(String(plan?.raw), /inspect the project/, "records the task");
    assert.match(String(plan?.raw), /read_file\(package\.json\)/, "records tool calls even if the model never calls update_plan");
    assert.equal(plan?.status, "completed");
    await clearPlan(root);
  });

  await test("a resumable plan is carried into the primer as unfinished work", () => {
    const doc = buildContextDocument({ resumePlan: "- [x] step one\n- [ ] step two" });
    assert.match(String(doc), /UNFINISHED WORK/);
    assert.match(String(doc), /Do NOT start over/);
    assert.match(String(doc), /step two/);
  });

  console.log("Parallel workers:");
  // Stagger/retries are read at call time so tests can pin them.
  process.env.GEMINI_CODE_WORKER_STAGGER_MS = "0";
  await test("runs subtasks concurrently, each in its own tab", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    let liveTabs = 0;
    let peakConcurrency = 0;

    const fakeParent = {
      async spawnTab() {
        const id = `tab-${opened.length + 1}`;
        opened.push(id);
        liveTabs++;
        peakConcurrency = Math.max(peakConcurrency, liveTabs);
        return {
          setModel: async () => "Flash",
          close: async () => {
            liveTabs--;
            closed.push(id);
          },
        };
      },
    } as unknown as Parameters<typeof runParallelTasks>[1]["parent"];

    const results = await runParallelTasks(
      [
        { name: "a", prompt: "do a" },
        { name: "b", prompt: "do b" },
        { name: "c", prompt: "do c" },
      ],
      {
        parent: fakeParent,
        context: {},
        log: () => {},
        createSession: () => ({
          runTask: async (task: string) => {
            await new Promise((r) => setTimeout(r, 30));
            return `result of ${task}`;
          },
        }),
      }
    );

    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.name), ["a", "b", "c"], "results keep input order");
    assert.ok(results.every((r) => r.ok));
    assert.match(results[1].result, /do b/);
    assert.ok(peakConcurrency > 1, `expected real concurrency, peaked at ${peakConcurrency}`);
    assert.equal(closed.length, 3, "every worker tab must be closed");
  });

  await test("one failing worker doesn't sink the others", async () => {
    let closedCount = 0;
    const fakeParent = {
      async spawnTab() {
        return { setModel: async () => "Flash", close: async () => void closedCount++ };
      },
    } as unknown as Parameters<typeof runParallelTasks>[1]["parent"];

    const results = await runParallelTasks(
      [
        { name: "good", prompt: "ok" },
        { name: "bad", prompt: "boom" },
      ],
      {
        parent: fakeParent,
        context: {},
        log: () => {},
        createSession: () => ({
          runTask: async (task: string) => {
            if (task === "boom") throw new Error("worker exploded");
            return "fine";
          },
        }),
      }
    );

    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.match(results[1].result, /worker exploded/);
    assert.match(results[1].result, /attempt/, "records how many attempts were made");
    // 1 good worker + the failing one retried once = 3 tabs, all closed.
    assert.equal(closedCount, 3, "tabs must be closed even when the task throws, including retries");
  });

  await test("delegate tool validates its input", async () => {
    const tool = createDelegateTool({
      parent: {} as never,
      context: {},
      log: () => {},
      createSession: () => ({ runTask: async () => "x" }),
    });
    assert.match((await tool.run({})).output, /non-empty array/);
    assert.match((await tool.run({ tasks: [{ name: "a" }] })).output, /has no prompt/);
  });

  await test("workers cannot delegate further (no recursive spawning)", async () => {
    // The main session gets delegate_tasks injected; worker sessions are
    // built without it, so a worker can't spawn its own workers.
    const driver = new FakeDriver([finalResponse("ok")]);
    const delegate = createDelegateTool({
      parent: {} as never,
      context: {},
      log: () => {},
      createSession: () => ({ runTask: async () => "x" }),
    });
    const main = new AgentSession(driver, {}, [delegate]);
    await main.runTask("hi");
    assert.match(driver.sentMessages[0], /delegate_tasks/, "main session advertises delegation");

    const workerDriver = new FakeDriver([finalResponse("ok")]);
    const worker = new AgentSession(workerDriver, {});
    await worker.runTask("hi");
    assert.ok(
      !workerDriver.sentMessages[0].includes("delegate_tasks"),
      "worker session must NOT advertise delegation"
    );
  });

  console.log("Model selection:");
  await test("resolves friendly aliases, and 'thinking' is the default", () => {
    assert.equal(resolveModel("fast")?.name, "Flash");
    assert.equal(resolveModel("pro")?.name, "Pro");
    assert.equal(resolveModel("fastest")?.name, "Flash-Lite");
    assert.equal(resolveModel("nonsense"), undefined);
    assert.equal(resolveModel(DEFAULT_MODEL_ALIAS)?.name, "Thinking");
    assert.equal(resolveModel("3.8")?.name, "Thinking");
    // "3.8 Thinking" is a model in the newest picker; "Extended thinking"
    // is still the toggle stacked on top of whichever model is selected.
    const thinking = resolveModel("thinking")!;
    assert.ok(thinking.matches("3.8 Thinking\nReasons before answering"));
    assert.ok(thinking.matches("Thinking"));
    assert.ok(!thinking.matches("Standard thinking\nQuick everyday help"));
    assert.ok(!thinking.matches("High thinking\nComplex problem solving"));
    assert.ok(!thinking.matches("Extended thinking"));
    assert.ok(!resolveModel("pro")!.matches("3.8 Thinking\nComplex problem solving"), "pro's blurb rule must not steal Thinking");
    assert.ok(!EXTENDED_THINKING.matches("3.8 Thinking\nReasons before answering"), "the toggle must not click the Thinking model");
    assert.deepEqual(modelWithFallbacks(thinking).map((m) => m.name), ["Thinking", "Auto", "Pro", "Flash"]);
    // The 2026 picker seen live: Auto / 3.1 Pro / 4 Argon / a "Thinking level" submenu.
    assert.ok(!thinking.matches("Thinking level"), "the submenu entry is a setting, not the Thinking model");
    assert.ok(!EXTENDED_THINKING.matches("Thinking level"));
    assert.equal(resolveModel("auto")?.name, "Auto");
    assert.ok(resolveModel("auto")!.matches("Auto\nGemini 3 models"));
    assert.ok(resolveModel("argon")!.matches("4 Argon\nComplex tasks"));
    assert.ok(!resolveModel("pro")!.matches("4 Argon\nComplex tasks"));
    assert.equal(resolveThinkingLevel("High"), "high");
    assert.equal(resolveThinkingLevel("med"), "medium");
    assert.equal(resolveThinkingLevel(undefined), undefined);
    assert.equal(resolveThinkingLevel("nope"), undefined);
    assert.ok(THINKING_LEVEL_MENU.item("high", "High\nExtra thorough"));
    assert.ok(!THINKING_LEVEL_MENU.item("low", "Low-latency mode"));
  });

  await test("matches live menu labels despite version-number drift", () => {
    // The picker shows e.g. "3.6 Flash", which Google bumps over time —
    // matching must be keyword-based, not exact-label.
    const flash = resolveModel("fast")!;
    const lite = resolveModel("fastest")!;
    assert.ok(flash.matches("3.6 Flash\nAll-around help"), "should match current label");
    assert.ok(flash.matches("4.0 Flash\nAll-around help"), "should survive a version bump");
    assert.ok(!flash.matches("3.5 Flash-Lite\nFastest answers"), "must not swallow Flash-Lite");
    assert.ok(lite.matches("3.5 Flash-Lite\nFastest answers"));
    assert.ok(resolveModel("pro")!.matches("3.1 Pro\nAdvanced reasoning"));
    assert.ok(EXTENDED_THINKING.matches("Extended thinking\nComplex problem solving"));
    // The toggle's on/off state is read from the picker label suffix.
    assert.ok(EXTENDED_THINKING.labelMarker.test("Flash Extended"));
    assert.ok(!EXTENDED_THINKING.labelMarker.test("Flash"));
  });

  // Rows as read from a live free-plan picker, Nov 2026.
  const liveMenu: MenuRow[] = [
    { text: "", testId: "local-images-files-uploader-button", selected: false },
    { text: "Auto\nGemini 3 models", testId: "bard-mode-option-cf41b0e0dd7d53e5", selected: true },
    { text: "3.1 Pro\nAdvanced reasoning", testId: "bard-mode-option-upsell_MODE_CATEGORY_PRO", selected: false },
    { text: "4 Argon\nComplex tasks", testId: "bard-mode-option-upsell_MODE_CATEGORY_ULTRA", selected: false },
    { text: "Thinking level", testId: "", selected: false },
  ];

  await test("reads the live menu, marking models above the plan as locked", () => {
    assert.deepEqual(parseModelRows(liveMenu), [
      { name: "Auto", description: "Gemini 3 models", selected: true, locked: false },
      { name: "3.1 Pro", description: "Advanced reasoning", selected: false, locked: true },
      { name: "4 Argon", description: "Complex tasks", selected: false, locked: true },
    ]);
  });

  // The same menu two weeks later: radio items, and a padlock instead of an id.
  const liveMenuNov17: MenuRow[] = [
    { text: "Auto\nAdapts to your needs", testId: "bard-mode-option-cf41b0e0dd7d53e5", selected: true },
    { text: "Code & analysis\n4 Argon", testId: "bard-mode-option-argon", selected: false, locked: true },
    { text: "Thinking level", testId: "", selected: false },
  ];

  await test("a padlock marks a locked model when its id no longer does", () => {
    assert.deepEqual(parseModelRows(liveMenuNov17), [
      { name: "Auto", description: "Adapts to your needs", selected: true, locked: false },
      { name: "Code & analysis", description: "4 Argon", selected: false, locked: true },
    ]);
  });

  await test("a row answers to the name on either of its lines", () => {
    assert.ok(menuRowMatches("4 Argon", "Code & analysis\n4 Argon"));
    assert.ok(menuRowMatches("code & analysis", "Code & analysis\n4 Argon"));
    assert.ok(!menuRowMatches("Argon", "Code & analysis\n4 Argon"), "a part of a name isn't a match");
  });

  await test("the picker selector matches radio items, which is what models are now", () => {
    const matches = (role: string) => new RegExp(`^${selectors.modeMenuItem.match(/\^="(\w+)"/)![1]}`).test(role);
    for (const role of ["menuitem", "menuitemradio", "menuitemcheckbox"]) assert.ok(matches(role), role);
  });

  await test("reads thinking levels from the submenu", () => {
    const levels = parseThinkingRows([{ text: "Low\nQuick and efficient", testId: "", selected: true }]);
    assert.deepEqual(levels, [{ name: "Low", description: "Quick and efficient", selected: true }]);
  });

  await test("a picker row answers to its own name, or a friendly alias", () => {
    assert.ok(menuRowMatches("3.1 Pro", "3.1 Pro\nAdvanced reasoning"));
    assert.ok(menuRowMatches("pro", "3.1 Pro\nAdvanced reasoning"));
    assert.ok(menuRowMatches("fast", "Auto\nGemini 3 models"), "the default must work on an Auto-only picker");
    assert.ok(!menuRowMatches("4 Argon", "3.1 Pro\nAdvanced reasoning"));
    assert.ok(!menuRowMatches("fast", "Thinking level"));
  });

  console.log("Gemini Enterprise:");
  await test("an Enterprise link is validated and normalised, with its cid", () => {
    const link = parseEnterpriseUrl("vertexaisearch.cloud.google.com/home/cid/1a2b3c4d-0000-4e5f-9a8b-123456789abc#x");
    assert.equal(link.url, "https://vertexaisearch.cloud.google.com/home/cid/1a2b3c4d-0000-4e5f-9a8b-123456789abc");
    assert.equal(link.cid, "1a2b3c4d-0000-4e5f-9a8b-123456789abc");
    assert.equal(link.knownHost, true);
    assert.equal(parseEnterpriseUrl("https://business.gemini.google/home/cid/abc").knownHost, true);
    assert.equal(parseEnterpriseUrl("https://intranet.example.com/gemini/cid/abc").knownHost, false, "unknown hosts are allowed but flagged");
    assert.throws(() => parseEnterpriseUrl("http://vertexaisearch.cloud.google.com/home/cid/x"), /https/);
    assert.throws(() => parseEnterpriseUrl("https://gemini.google.com/app"), /consumer/);
    assert.throws(() => parseEnterpriseUrl("   "), /empty/);
  });

  await test("the site follows GEMINI_CODE_ENTERPRISE_URL at call time", () => {
    const prev = process.env.GEMINI_CODE_ENTERPRISE_URL;
    try {
      delete process.env.GEMINI_CODE_ENTERPRISE_URL;
      assert.equal(isEnterprise(), false);
      assert.equal(appUrl(), "https://gemini.google.com/app");
      assert.ok(isAppPage("https://gemini.google.com/app/abc123"));

      process.env.GEMINI_CODE_ENTERPRISE_URL = "https://vertexaisearch.cloud.google.com/home/cid/tenant-1";
      assert.equal(isEnterprise(), true);
      assert.equal(appUrl(), "https://vertexaisearch.cloud.google.com/home/cid/tenant-1");
      assert.ok(isAppPage("https://vertexaisearch.cloud.google.com/home/cid/tenant-1/r/session/99"), "a thread in the tenant");
      assert.ok(!isAppPage("https://vertexaisearch.cloud.google.com/home/cid/tenant-2"), "another organisation's app");
      assert.ok(!isAppPage("https://gemini.google.com/app"), "the consumer app");
      assert.ok(isSignInPage("https://accounts.google.com/v3/signin/identifier?continue=x"));
      assert.ok(isSignInPage("https://auth.cloud.google/signin/locations/global/pools/p"));
      assert.ok(!isSignInPage("https://vertexaisearch.cloud.google.com/home/cid/tenant-1"));

      for (const off of ["off", "0", ""]) {
        process.env.GEMINI_CODE_ENTERPRISE_URL = off;
        assert.equal(isEnterprise(), false, `"${off}" means consumer Gemini`);
      }
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CODE_ENTERPRISE_URL;
      else process.env.GEMINI_CODE_ENTERPRISE_URL = prev;
    }
  });

  await test("Enterprise selectors swap in and back, and user overrides apply on top", () => {
    const consumerComposer = selectors.composerInput;
    try {
      applySelectorOverrides({ enterprise: true });
      assert.match(selectors.composerInput, /textarea/);
      assert.match(selectors.responseContainer, /ucs-summary/);
      const notes = applySelectorOverrides({
        enterprise: true,
        overrides: { responseContainer: "ucs-answer", uploadFilesText: "/add files/i", nope: "x", stopButton: 3 },
      });
      assert.equal(selectors.responseContainer, "ucs-answer");
      assert.ok(selectors.uploadFilesText instanceof RegExp && selectors.uploadFilesText.test("Add Files"));
      assert.ok(notes.some((n) => /unknown selector "nope"/.test(n)));
      assert.ok(notes.some((n) => /"stopButton" must be a non-empty string/.test(n)));
      applySelectorOverrides({ enterprise: false });
      assert.equal(selectors.composerInput, consumerComposer, "back to the consumer set, overrides dropped");
    } finally {
      applySelectorOverrides({ enterprise: false });
    }
  });

  await test("--enterprise is read, saved to the user config with the rest kept, and 'off' undoes it", async () => {
    assert.equal(enterpriseFlag(["--enterprise", "https://x.cloud.google.com/home/cid/a"]), "https://x.cloud.google.com/home/cid/a");
    assert.equal(enterpriseFlag(["--enterprise=off"]), "off");
    assert.equal(enterpriseFlag(["--model", "pro"]), undefined);
    assert.equal(envNameFor("enterprise"), "GEMINI_CODE_ENTERPRISE_URL");

    const home = path.resolve(".tmp-test", `ent-home-${Date.now().toString(36)}`);
    await mkdir(home, { recursive: true });
    const prevHome = process.env.GEMINI_CODE_HOME;
    const prevUrl = process.env.GEMINI_CODE_ENTERPRISE_URL;
    process.env.GEMINI_CODE_HOME = home;
    try {
      await writeFile(path.join(home, "config.json"), JSON.stringify({ model: "pro" }));
      const link = setEnterprise("vertexaisearch.cloud.google.com/home/cid/abc");
      assert.equal(link?.cid, "abc");
      assert.equal(process.env.GEMINI_CODE_ENTERPRISE_URL, "https://vertexaisearch.cloud.google.com/home/cid/abc");
      const saved = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
      assert.deepEqual(saved, { model: "pro", enterprise: "https://vertexaisearch.cloud.google.com/home/cid/abc" });
      assert.ok(enterpriseConfigured());

      assert.equal(setEnterprise("off"), undefined);
      assert.equal(isEnterprise(), false);
      assert.equal(JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).enterprise, "off");
      assert.ok(enterpriseConfigured(), "an explicit 'off' counts as answered, so the first-start question isn't repeated");
      assert.throws(() => setEnterprise("not a link at all"), /isn't a link|https/);
    } finally {
      if (prevHome === undefined) delete process.env.GEMINI_CODE_HOME;
      else process.env.GEMINI_CODE_HOME = prevHome;
      if (prevUrl === undefined) delete process.env.GEMINI_CODE_ENTERPRISE_URL;
      else process.env.GEMINI_CODE_ENTERPRISE_URL = prevUrl;
      await rm(home, { recursive: true, force: true });
    }
  });

  console.log("Gems:");
  await test("picks a Gem by id, exact name or unambiguous partial", () => {
    const gems = [
      { id: "coding-partner", name: "Coding partner" },
      { id: "a1b2c3", name: "Kite 2" },
      { id: "d4e5f6", name: "Kite 2 QA" },
    ];
    assert.equal((resolveGem("a1b2c3", gems) as { gem: { name: string } }).gem.name, "Kite 2");
    assert.equal((resolveGem("kite 2", gems) as { gem: { id: string } }).gem.id, "a1b2c3", "exact name wins over partial");
    assert.equal((resolveGem("QA", gems) as { gem: { id: string } }).gem.id, "d4e5f6");
    assert.equal((resolveGem("Coding Partner", gems) as { gem: { id: string } }).gem.id, "coding-partner");
  });

  await test("refuses an ambiguous or unknown Gem instead of guessing", () => {
    const gems = [
      { id: "a", name: "Kite 2 Backend" },
      { id: "b", name: "Kite 2 Frontend" },
    ];
    const ambiguous = resolveGem("kite", gems);
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.match(ambiguous.error, /matches several Gems.*Backend.*Frontend/s);

    const missing = resolveGem("nope", gems);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /No Gem matching "nope".*Available/s);

    assert.equal(resolveGem("   ", gems).ok, false);
  });

  await test("a Gem is reference by default, inside only when asked", () => {
    assert.equal(gemModeFlag([], undefined), "reference");
    assert.equal(gemModeFlag(["--gem", "Kite 2"], undefined), "reference");
    assert.equal(gemModeFlag(["--gem-mode", "inside"], undefined), "inside");
    assert.equal(gemModeFlag(["--gem-mode=inside"], undefined), "inside");
    assert.equal(gemModeFlag([], "inside"), "inside", "env works too");
    assert.equal(gemModeFlag([], "nonsense"), "reference", "anything unrecognised stays reference");
    assert.equal(gemModeFlag(["--gem-mode", "inside"], "reference"), "inside", "the flag beats the env");
  });

  await test("ask_gem relays the Gem's answer, and opens its tab only once", async () => {
    const asked: string[] = [];
    let opens = 0;
    const fakeTab = {
      async sendPrompt(text: string) {
        asked.push(text);
      },
      async waitForResponseComplete() {},
      async getLastResponse() {
        return { text: `answer to ${asked.length}`, codeBlocks: [] };
      },
      async close() {},
    };
    const consultant = createAskGemTool({
      gem: { id: "a1", name: "Kite 2" },
      openTab: async () => {
        opens++;
        return fakeTab as never;
      },
    });

    const first = await consultant.tool.run({ question: "Which state library do we use?" });
    assert.equal(first.ok, true);
    assert.match(first.output, /Kite 2.*says/s);
    assert.match(first.output, /answer to 1/);

    await consultant.tool.run({ question: "and why?" });
    assert.equal(opens, 1, "the Gem tab is reused, not reopened per question");
    assert.deepEqual(asked, ["Which state library do we use?", "and why?"]);

    const empty = await consultant.tool.run({ question: "   " });
    assert.equal(empty.ok, false);
    assert.match(empty.output, /'question' is required/);
    await consultant.close();
  });

  await test("ask_gem failing is recoverable, not fatal", async () => {
    const consultant = createAskGemTool({
      gem: { id: "a1", name: "Kite 2" },
      openTab: async () => {
        throw new Error("tab blew up");
      },
    });
    const r = await consultant.tool.run({ question: "anything" });
    assert.equal(r.ok, false);
    assert.match(r.output, /tab blew up/);
    assert.match(r.output, /Carry on using the files/);
  });

  await test("--gem is read in both spellings", () => {
    assert.equal(gemFlag(["--gem", "Kite 2"]), "Kite 2");
    assert.equal(gemFlag(["--gem=Kite 2"]), "Kite 2");
    assert.equal(gemFlag([]), undefined);
    assert.equal(gemFlag(["--gem"]), undefined, "a bare --gem is not a Gem named undefined");
  });

  console.log("OpenAI-compatible API:");
  await test("model rules match both live picker variants", () => {
    const byAlias = (a: string) => resolveModel(a)!;
    // Older menu
    assert.ok(byAlias("fast").matches("3.6 Flash"));
    assert.ok(byAlias("pro").matches("3.1 Pro"));
    // Newer menu, seen on freshly opened tabs
    assert.ok(byAlias("fastest").matches("3.5 Flash-Lite Fastest answers"));
    assert.ok(byAlias("fast").matches("Standard thinking Quick everyday help"));
    assert.ok(byAlias("pro").matches("High thinking Complex problem solving"));
    assert.ok(!byAlias("fast").matches("3.5 Flash-Lite Fastest answers"), "lite is not flash");
    // The thinking toggle must not grab a model entry
    assert.ok(EXTENDED_THINKING.matches("Extended thinking"));
    assert.ok(!EXTENDED_THINKING.matches("Standard thinking Quick everyday help"));
    assert.ok(!EXTENDED_THINKING.matches("High thinking Complex problem solving"));
  });

  await test("maps any client model name to a Gemini model", () => {
    assert.equal(modelAliasFor(undefined), "thinking");
    assert.equal(modelAliasFor("gemini-web-thinking"), "thinking");
    assert.equal(modelAliasFor("gemini-3.8-thinking"), "thinking");
    assert.equal(modelAliasFor("gemini-web-pro"), "pro");
    assert.equal(modelAliasFor("gemini-web-flash-lite"), "fastest");
    assert.equal(modelAliasFor("gemini-2.5-pro"), "pro", "real Gemini API names work");
    assert.equal(modelAliasFor("gemini-2.0-flash-lite"), "fastest", "lite wins over flash");
    assert.equal(modelAliasFor("gpt-4o"), "thinking", "unknown names fall back instead of failing");
  });

  await test("rejects requests the web UI can't serve", () => {
    assert.match(validateRequest({})!, /messages/);
    assert.match(validateRequest({ messages: [{ role: "robot", content: "x" }] })!, /not supported/);
    assert.match(validateRequest({ messages: [{ role: "assistant", content: "x" }] })!, /nothing to reply to/);
    assert.match(validateRequest({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function" }] })!, /tools\[0\]/);
    assert.equal(validateRequest({ messages: [{ role: "user", content: "hi" }] }), undefined);
  });

  await test("a single question is sent plainly; a history is sent as a transcript", () => {
    const simple = buildFreshPrompt({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "What is 2+2?" },
      ],
    });
    assert.match(simple, /Be terse\./);
    assert.match(simple, /What is 2\+2\?$/);
    assert.doesNotMatch(simple, /User:/, "no transcript framing for one question");

    const history = buildFreshPrompt({
      messages: [
        { role: "user", content: "My name is Ada." },
        { role: "assistant", content: "Hi Ada." },
        { role: "user", content: [{ type: "text", text: "What is my name?" }] },
      ],
    });
    assert.match(history, /User: My name is Ada\.[\s\S]*Assistant: Hi Ada\.[\s\S]*User: What is my name\?/);
  });

  await test("continues a thread only when it is exactly the start of the conversation", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const next = [...history, { role: "user" as const, content: "and now?" }];
    assert.deepEqual(continuationOf(history, next), [{ role: "user", content: "and now?" }]);

    const edited = [{ role: "user" as const, content: "HI" }, history[1], { role: "user" as const, content: "x" }];
    assert.equal(continuationOf(history, edited), undefined, "edited history starts fresh");
    assert.equal(continuationOf(history, history), undefined, "nothing new to send");
    assert.equal(continuationOf([], next), undefined, "an empty thread is not a continuation");

    assert.match(
      buildContinuationPrompt([{ role: "tool", tool_call_id: "call_1", content: "22C" }]),
      /Function result \(call_1\):\n22C/
    );
  });

  await test("parses function calls in every shape Gemini drifts into", () => {
    const tools = [{ type: "function" as const, function: { name: "get_weather", parameters: {} } }];
    const wanted = parseToolCalls(
      { text: "", codeBlocks: ['{"tool_calls": [{"name": "get_weather", "arguments": {"city": "Chennai"}}]}'] },
      tools
    );
    assert.equal(wanted?.[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(wanted![0].function.arguments), { city: "Chennai" });
    assert.match(wanted![0].id, /^call-/);

    const single = parseToolCalls({ text: 'Calling {"name": "get_weather", "args": {"city": "Pune"}} now', codeBlocks: [] }, tools);
    assert.equal(JSON.parse(single![0].function.arguments).city, "Pune");

    assert.equal(
      parseToolCalls({ text: '{"name": "delete_everything", "arguments": {}}', codeBlocks: [] }, tools),
      undefined,
      "only functions the client offered"
    );
    assert.equal(parseToolCalls({ text: "It is sunny.", codeBlocks: [] }, tools), undefined);
  });

  await test("streams only text that can't change, and never takes text back", () => {
    assert.equal(streamableDelta("", "line one\nline tw", false), "line one\n", "unfinished line held back");
    assert.equal(streamableDelta("line one\n", "line one\nline two", true), "line two", "released at the end");
    assert.equal(streamableDelta("abc", "xbc\n", true), "", "a rewritten prefix sends nothing rather than garbage");
  });

  await test("serve options: safe defaults, validated values", () => {
    const d = serveArgs([], {});
    assert.deepEqual(d, { host: "127.0.0.1", port: 8787, tabs: 2, apiKey: undefined, allowedOrigins: [] });
    const custom = serveArgs(["--port", "9000", "--tabs=3", "--api-key", "k", "--cors-origin", "http://localhost:3000/"], {});
    assert.equal(custom.port, 9000);
    assert.equal(custom.tabs, 3);
    assert.equal(custom.apiKey, "k");
    assert.deepEqual(custom.allowedOrigins, ["http://localhost:3000"]);
    assert.throws(() => serveArgs(["--port", "abc"], {}), /Invalid port/);
    assert.throws(() => serveArgs(["--tabs", "50"], {}), /1-8/);
  });

  // A stand-in for the browser: records prompts, answers from a script.
  const fakeTabs: string[][] = [];
  const makeFakeDriver = (answers: string[]) => {
    const prompts: string[] = [];
    fakeTabs.push(prompts);
    const next = () => answers.shift() ?? "(no scripted answer)";
    let current = "";
    const driver = {
      prompts,
      newConversationCalls: 0,
      async newConversation() {
        driver.newConversationCalls++;
      },
      async setModel(alias: string) {
        return alias;
      },
      async sendPrompt(text: string) {
        prompts.push(text);
        current = next();
      },
      async waitForResponseComplete() {},
      async streamResponse(on: (md: string) => void) {
        const lines = current.split("\n");
        for (let i = 1; i <= lines.length; i++) on(lines.slice(0, i).join("\n"));
      },
      async getLastResponse() {
        return { text: current, codeBlocks: current.startsWith("{") ? [current] : [] };
      },
      async getLastResponseMarkdown() {
        return current;
      },
      async spawnTab() {
        throw new Error("the fake has one tab");
      },
      async close() {},
    };
    return driver;
  };

  const startFake = async (answers: string[], extra: Partial<Parameters<typeof startServer>[0]> = {}) => {
    const driver = makeFakeDriver(answers);
    const port = 18000 + Math.floor(Math.random() * 2000);
    const server = await startServer({
      driver: driver as never,
      host: "127.0.0.1",
      port,
      tabs: 1,
      allowedOrigins: [],
      log: () => {},
      ...extra,
    });
    return { driver, server, base: `http://127.0.0.1:${port}` };
  };
  const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  await test("serves /v1/models and a chat completion in OpenAI's shape", async () => {
    const { server, base } = await startFake(["## Hi\n\nHello **there**."]);
    try {
      const models = await (await fetch(`${base}/v1/models`)).json();
      assert.ok(models.data.some((m: { id: string }) => m.id === "gemini-web-pro"));

      const r = await post(base, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.object, "chat.completion");
      assert.equal(body.choices[0].message.content, "## Hi\n\nHello **there**.", "markdown, not flattened text");
      assert.equal(body.choices[0].finish_reason, "stop");
      assert.ok(body.usage.total_tokens > 0);
    } finally {
      await server.close();
    }
  });

  await test("streams server-sent events ending in [DONE]", async () => {
    const { server, base } = await startFake(["one\ntwo\nthree"]);
    try {
      const r = await post(base, { messages: [{ role: "user", content: "count" }], stream: true, stream_options: { include_usage: true } });
      assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
      const events = (await r.text()).split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
      assert.equal(events[events.length - 1], "[DONE]");
      const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
      const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
      assert.equal(text, "one\ntwo\nthree", "the pieces add up to the whole answer");
      assert.ok(chunks.filter((c) => c.choices[0]?.delta?.content).length > 1, "sent in more than one piece");
      assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === "stop"));
      assert.ok(chunks.some((c) => c.usage), "usage chunk when asked for");
    } finally {
      await server.close();
    }
  });

  await test("function calling round trip, continuing the same thread", async () => {
    const { server, base, driver } = await startFake([
      '{"tool_calls": [{"name": "get_weather", "arguments": {"city": "Chennai"}}]}',
      "It is 31C in Chennai.",
    ]);
    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }];
    try {
      const first = await (await post(base, { messages: [{ role: "user", content: "Weather in Chennai?" }], tools })).json();
      const call = first.choices[0].message.tool_calls[0];
      assert.equal(first.choices[0].finish_reason, "tool_calls");
      assert.equal(first.choices[0].message.content, null);
      assert.equal(call.function.name, "get_weather");
      assert.match(driver.prompts[0], /get_weather/, "the tools were described to Gemini");

      const second = await (
        await post(base, {
          tools,
          messages: [
            { role: "user", content: "Weather in Chennai?" },
            first.choices[0].message,
            { role: "tool", tool_call_id: call.id, content: "31C" },
          ],
        })
      ).json();
      assert.equal(second.choices[0].message.content, "It is 31C in Chennai.");
      assert.equal(driver.newConversationCalls, 1, "the second request continued the thread");
      assert.match(driver.prompts[1], /^Function result \(call-[0-9a-f]+\):\n31C$/, "only the new turn was sent");
    } finally {
      await server.close();
    }
  });

  await test("API key, origin and content-type checks", async () => {
    const { server, base } = await startFake(["ok", "ok"], { apiKey: "secret" });
    try {
      const noKey = await post(base, { messages: [{ role: "user", content: "hi" }] });
      assert.equal(noKey.status, 401);
      assert.equal((await noKey.json()).error.type, "authentication_error");

      const good = await post(base, { messages: [{ role: "user", content: "hi" }] }, { Authorization: "Bearer secret" });
      assert.equal(good.status, 200);

      // A web page the user visits must not be able to use the account.
      const fromSite = await post(base, { messages: [{ role: "user", content: "hi" }] }, { Authorization: "Bearer secret", Origin: "https://evil.example" });
      assert.equal(fromSite.status, 403);

      const plain = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: "Bearer secret" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(plain.status, 415, "a no-preflight text/plain POST is refused");
    } finally {
      await server.close();
    }
  });

  await test("another process answering a dialog first is not fatal; other errors still are", () => {
    // The exact error that killed a process when a second gemini-code
    // instance handled the same "Leave site?" dialog first.
    const race = new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");
    assert.equal(isDialogRace(race), true);
    assert.equal(isDialogRace(new Error("Protocol error (Page.navigate): Target closed")), false);
    assert.equal(isDialogRace(new Error("No dialog is showing")), false, "must name the dialog call");
  });

  await test("refuses to listen on a network address without a key", async () => {
    await assert.rejects(
      startServer({ driver: makeFakeDriver([]) as never, host: "0.0.0.0", port: 18999, tabs: 1, allowedOrigins: [], log: () => {} }),
      /without an API key/
    );
  });

  /** Runs with real prompts, answering from a list the test fills in. */
  const withPrompts = async (fn: (answers: string[]) => Promise<void>) => {
    const answers: string[] = [];
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    setAsker(async () => answers.shift() ?? "");
    try {
      await fn(answers);
    } finally {
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
      setAsker(undefined);
    }
  };

  console.log("On-demand tools:");
  const sessionReplies = (replies: GeminiResponse[], extra: ToolDefinition[] = []) => {
    const driver = new FakeDriver(replies);
    return { driver, session: new AgentSession(driver, {}, extra) };
  };
  const echo = (ran: string[]): ToolDefinition => ({
    name: "echo_later",
    deferred: true,
    description: "echo_later(args: {text: string}) -> says it back. UNIQUE-ECHO-DOC",
    async run(args) {
      ran.push(String(args.text));
      return { ok: true, output: "echoed" };
    },
  });

  await test("the primer names deferred tools without describing them", () => {
    const primer = buildSystemPrimer(tools);
    for (const tool of tools) {
      assert.ok(primer.includes(tool.name), `${tool.name} isn't even named`);
      assert.equal(primer.includes(tool.description), !tool.deferred, tool.name);
    }
    assert.ok(primer.includes("tool_search"));
  });

  await test("every tool describes its own name and args", () => {
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, "duplicate tool name");
    for (const tool of tools) assert.ok(tool.description.startsWith(`${tool.name}(`), tool.name);
  });

  await test("keywords find a tool, and select loads several at once", async () => {
    const loaded = new Set<string>();
    const search = createToolSearchTool(() => tools, loaded);
    const byKeyword = await search.run({ query: "notebook" });
    assert.ok(byKeyword.ok && byKeyword.output.includes("notebook_read("));
    assert.ok(loaded.has("notebook_read"));

    loaded.clear();
    const selected = await search.run({ query: "select:git_log, git_blame,no_such_tool" });
    assert.deepEqual([...loaded].sort(), ["git_blame", "git_log"]);
    assert.match(selected.output, /Not found: no_such_tool/);
    assert.ok(selected.output.includes(gitLogTool.description));
  });

  await test("a search that finds nothing lists what exists", async () => {
    const search = createToolSearchTool(() => tools, new Set());
    const result = await search.run({ query: "zzzqqq" });
    assert.equal(result.ok, false);
    assert.match(result.output, /delete_file/);
  });

  await test("a deferred tool runs once tool_search has loaded it", async () => {
    const ran: string[] = [];
    const { session, driver } = sessionReplies(
      [
        toolCallResponse("tool_search", { query: "select:echo_later" }),
        toolCallResponse("echo_later", { text: "hi" }),
        finalResponse("done"),
      ],
      [echo(ran)]
    );
    assert.equal(await session.runTask("go"), "done");
    assert.deepEqual(ran, ["hi"]);
    assert.ok(!driver.sentMessages[0].includes("UNIQUE-ECHO-DOC"), "its docs must stay out of the primer");
    assert.ok(driver.sentMessages[1].includes("UNIQUE-ECHO-DOC"), "and arrive when searched for");
  });

  await test("calling an unloaded tool returns its definition and runs nothing", async () => {
    const ran: string[] = [];
    const { session, driver } = sessionReplies(
      [
        toolCallResponse("echo_later", { guess: "x" }),
        toolCallResponse("echo_later", { text: "fixed" }),
        finalResponse("done"),
      ],
      [echo(ran)]
    );
    await session.runTask("go");
    assert.deepEqual(ran, ["fixed"], "the first call, on guessed args, must not run");
    assert.match(driver.sentMessages[1], /did NOT run[\s\S]*UNIQUE-ECHO-DOC/);
  });

  console.log("Plan mode:");
  await test("plan mode allow-lists tools, so a new tool is blocked by default", async () => {
    const ran: string[] = [];
    const { session, driver } = sessionReplies(
      [toolCallResponse("tool_search", { query: "select:echo_later" }), toolCallResponse("echo_later", { text: "x" }), finalResponse("ok")],
      [echo(ran)]
    );
    session.setPlanMode(true);
    await session.runTask("look");
    assert.deepEqual(ran, []);
    assert.match(driver.sentMessages.join("\n"), /Plan mode is on, so echo_later did not run/);
    assert.match(driver.sentMessages[0], /PLAN MODE IS ON/);
  });

  await test("nothing that changes anything is on the read-only list", () => {
    for (const name of ["write_file", "edit_file", "multi_edit", "run_bash", "delete_file", "move_file", "copy_file",
      "notebook_edit", "delegate_tasks", "browser_do", "remember", "kill_process"]) {
      assert.ok(!READ_ONLY_TOOLS.has(name), name);
    }
  });

  await test("a declined plan stays in plan mode, an approved one leaves it", async () => {
    await withPrompts(async (answers) => {
      const state = { active: true };
      const exit = createPlanModeTools(state).find((t) => t.name === "exit_plan_mode")!;
      answers.push("n");
      assert.match((await exit.run({ plan: "Rewrite it" })).output, /did not approve/);
      assert.equal(state.active, true);
      answers.push("y");
      await exit.run({ plan: "Rewrite it" });
      assert.equal(state.active, false);
    });
  });

  console.log("Claude Code tools:");
  const scratchFile = (name: string) => path.join(".tmp-test", name);

  await test("find_files matches filenames and paths", async () => {
    assert.match((await findFilesTool.run({ pattern: "smoke.ts" })).output, /src\/tests\/smoke\.ts/);
    assert.match((await findFilesTool.run({ pattern: "src/**/*Gem*.ts" })).output, /askGem\.ts/);
    assert.match((await findFilesTool.run({ pattern: "*.nothing" })).output, /No files match/);
  });

  await test("read_files reads several, and refuses to leave the project", async () => {
    await writeFile(scratchFile("a.txt"), "alpha");
    const { output } = await readFilesTool.run({ paths: [scratchFile("a.txt"), "../outside.txt", scratchFile("gone.txt")] });
    assert.match(output, /alpha/);
    assert.match(output, /escapes the project root/);
    assert.match(output, /Error reading it/);
  });

  await test("multi_edit is all or nothing", async () => {
    const file = scratchFile("multi.txt");
    await writeFile(file, "one\ntwo\n");
    const unread = await multiEditTool.run({ path: file, edits: [{ old_text: "one", new_text: "1" }] });
    assert.match(unread.output, /haven't read/, "multi_edit has the same read-before-edit gate as edit_file");
    await readFilesTool.run({ paths: [file] });
    const failed = await multiEditTool.run({
      path: file,
      edits: [{ old_text: "one", new_text: "1" }, { old_text: "missing", new_text: "x" }],
    });
    assert.equal(failed.ok, false);
    assert.match(failed.output, /changed nothing[\s\S]*Edit 2 \(/);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\n");

    const applied = await multiEditTool.run({
      path: file,
      edits: [{ old_text: "one", new_text: "1" }, { old_text: "two", new_text: "2" }],
    });
    assert.ok(applied.ok, applied.output);
    assert.equal(await readFile(file, "utf8"), "1\n2\n");
  });

  await test("move, copy and delete can all be undone", async () => {
    const store = checkpoints;
    const [a, b, c] = ["undo-a.txt", "undo-b.txt", "undo-c.txt"].map(scratchFile);
    await writeFile(a, "A");
    store.begin("files");
    assert.ok((await copyFileTool.run({ from: a, to: c })).ok);
    assert.ok((await moveFileTool.run({ from: a, to: b })).ok);
    assert.ok((await deleteFileTool.run({ path: b })).ok);
    await store.commit();
    await store.undoLast();
    assert.equal(await readFile(a, "utf8"), "A", "the original is back");
    await assert.rejects(readFile(c, "utf8"), "the copy is gone");
  });

  await test("move and copy won't overwrite unless told to, or leave the project", async () => {
    const [a, b] = ["keep-a.txt", "keep-b.txt"].map(scratchFile);
    await writeFile(a, "A");
    await writeFile(b, "B");
    assert.match((await moveFileTool.run({ from: a, to: b })).output, /already exists/);
    assert.equal(await readFile(b, "utf8"), "B");
    assert.ok((await copyFileTool.run({ from: a, to: b, overwrite: true })).ok);
    assert.equal(await readFile(b, "utf8"), "A");
    assert.match((await moveFileTool.run({ from: a, to: "../stolen.txt" })).output, /escapes/);
    assert.match((await deleteFileTool.run({ path: ".tmp-test" })).output, /isn't a file/);
  });

  await test("file_info reports size and lines, and says when nothing's there", async () => {
    await writeFile(scratchFile("info.txt"), "a\nb\n");
    assert.match((await fileInfoTool.run({ path: scratchFile("info.txt") })).output, /file, 4 bytes, 3 lines/);
    assert.match((await fileInfoTool.run({ path: scratchFile("none.txt") })).output, /does not exist/);
  });

  await test("notebook cells can be read, replaced, inserted and deleted", async () => {
    const file = scratchFile("n.ipynb");
    const original = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { id: "a", cell_type: "markdown", metadata: {}, source: ["# Title\n"] },
        { id: "b", cell_type: "code", metadata: {}, execution_count: 3, source: ["print(1)\n", "print(2)"],
          outputs: [{ output_type: "stream", name: "stdout", text: ["1\n2\n"] }] },
      ],
    };
    await writeFile(file, JSON.stringify(original));

    const { output } = await notebookReadTool.run({ path: file });
    assert.match(output, /cell 1 \(code\)[\s\S]*print\(2\)[\s\S]*--- output ---\n1\n2/);

    assert.ok((await notebookEditTool.run({ path: file, cell: 1, source: "print(3)\nprint(4)" })).ok);
    let saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved.cells[1].source, ["print(3)\n", "print(4)"]);
    assert.deepEqual(saved.cells[1].outputs, [], "stale output must not outlive the code");
    assert.equal(saved.cells[1].execution_count, null);

    assert.ok((await notebookEditTool.run({ path: file, cell: 2, mode: "insert", source: "x", cell_type: "markdown" })).ok);
    saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.cells[2].cell_type, "markdown");
    assert.ok(saved.cells[2].id, "format 4.5 needs a cell id");

    assert.ok((await notebookEditTool.run({ path: file, cell: 0, mode: "delete" })).ok);
    assert.equal(JSON.parse(await readFile(file, "utf8")).cells.length, 2);
    assert.match((await notebookEditTool.run({ path: file, cell: 9, source: "x" })).output, /between 0 and 1/);
    assert.match((await notebookReadTool.run({ path: "package.json" })).output, /isn't a .ipynb/);
  });

  await test("outlines definitions across languages, and not control flow", () => {
    const names = (src: string) => outline(src).map((d) => `${d.kind} ${d.name}`);
    assert.deepEqual(names("export class Foo {\n  async bar(x: string): Promise<void> {\n    if (x) {\n    }\n  }\n}"), [
      "class Foo",
      "method bar",
    ]);
    assert.deepEqual(names("def run(a):\n    pass\nclass B:\n    def go(self):\n        pass"), ["def run", "class B", "def go"]);
    assert.deepEqual(names("func (s *Server) Start() error {\n}\nfunc main() {\n}"), ["method Start", "func main"]);
    assert.deepEqual(names("pub fn parse() {}\nstruct Token;"), ["fn parse", "struct Token"]);
    assert.deepEqual(names("export const add = (a, b) => a + b;"), ["function add"]);
  });

  await test("code_outline and find_symbol work on this project", async () => {
    assert.match((await codeOutlineTool.run({ path: "src/tools/toolSearch.ts" })).output, /function createToolSearchTool/);
    const found = await findSymbolTool.run({ name: "createToolSearchTool", references: true, glob: "src/**/*.ts" });
    assert.match(found.output, /src.tools.toolSearch\.ts:\d+: export function createToolSearchTool/);
    assert.match(found.output, /Used at:[\s\S]*loop\.ts/);
    assert.match((await findSymbolTool.run({ name: "a b(" })).output, /plain identifier/);
  });

  await test("search_code shows context and can list just the files", async () => {
    const file = scratchFile("ctx.ts");
    const hits = await searchCode({ pattern: "createToolSearchTool\\(", glob: "src/tools/toolSearch.ts", context: 1 });
    assert.ok(hits.hits[0].before?.length && hits.hits[0].after?.length, file);
    const { output } = await searchCodeTool.run({ pattern: "createToolSearchTool", glob: "src/**/*.ts", filesOnly: true });
    assert.ok(!/:\d+:/.test(output), "no line numbers in a file list");
    assert.match(output, /loop\.ts/);
  });

  await test("git history tools read this repository", async () => {
    assert.match((await gitLogTool.run({ count: 2 })).output.split("\n")[0], /^[0-9a-f]{7,} \d{4}-\d\d-\d\d /);
    assert.match((await gitShowTool.run({ ref: "HEAD", stat: true })).output, /commit [0-9a-f]+/);
    assert.match((await gitBlameTool.run({ path: "package.json", start: 1, end: 2 })).output, /gemini-code|\{/);
  });

  await test("a git ref can't smuggle in an option, which could write files", async () => {
    const trap = scratchFile("pwned.txt");
    assert.equal((await gitShowTool.run({ ref: `--output=${trap}` })).ok, false);
    assert.equal((await gitLogTool.run({ ref: `--output=${trap}` })).ok, false);
    await assert.rejects(readFile(trap, "utf8"), "no file may have been written");
  });

  await test("wait_for_output waits for a line, and reports an exit without one", async () => {
    const start = async (script: string) => {
      const { output } = await bashTool.run({ command: `node -e "${script}"`, background: true });
      return /"(bg_\w+)"/.exec(output)![1];
    };
    const ready = await start(`setTimeout(()=>{console.log('listening on 3000');setTimeout(()=>{},300)},300)`);
    assert.match((await waitForOutputTool.run({ id: ready, pattern: "listening", timeout_seconds: 10 })).output, /Matched: listening on 3000/);

    await new Promise((r) => setTimeout(r, 5));
    const quiet = await start(`console.log('nope')`);
    const missed = await waitForOutputTool.run({ id: quiet, pattern: "listening", timeout_seconds: 10 });
    assert.equal(missed.ok, false);
    assert.match(missed.output, /without a matching line/);
    assert.match((await waitForOutputTool.run({ id: "bg_none" })).output, /No command/);
  });

  await test("ask_user asks in the terminal, and a number picks an option", async () => {
    await withPrompts(async (answers) => {
      answers.push("2");
      assert.match((await askUserTool.run({ question: "Which?", options: ["red", "blue"] })).output, /answered: blue/);
      answers.push("green");
      assert.match((await askUserTool.run({ question: "Which?", options: ["red"] })).output, /answered: green/);
    });
  });

  await test("ask_user still asks under auto-approve, and copes with nobody there", async () => {
    const prev = process.env.GEMINI_CODE_PROMPT_UNATTENDED;
    const prevApprove = process.env.GEMINI_CODE_AUTO_APPROVE;
    process.env.GEMINI_CODE_PROMPT_UNATTENDED = "1";
    process.env.GEMINI_CODE_AUTO_APPROVE = "all";
    try {
      setAsker(async () => "yes");
      assert.match((await askUserTool.run({ question: "Sure?" })).output, /answered: yes/);
      setAsker(undefined);
      const alone = await askUserTool.run({ question: "Anyone?" });
      assert.match(alone.output, /No one is available/);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CODE_PROMPT_UNATTENDED;
      else process.env.GEMINI_CODE_PROMPT_UNATTENDED = prev;
      if (prevApprove === undefined) delete process.env.GEMINI_CODE_AUTO_APPROVE;
      else process.env.GEMINI_CODE_AUTO_APPROVE = prevApprove;
    }
  });

  await test("skills are listed with descriptions and read by name", async () => {
    const dir = path.resolve(".gemini-code", "skills", "smoke-skill");
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(path.join(dir, "SKILL.md"), "---\nname: smoke-skill\ndescription: Does a smoke test\n---\nStep one.");
      assert.match((await useSkillTool.run({})).output, /- smoke-skill: Does a smoke test/);
      assert.match((await useSkillTool.run({ name: "smoke-skill" })).output, /Step one\./);
      assert.equal((await useSkillTool.run({ name: "../../package" })).ok, false);
    } finally {
      await rm(path.resolve(".gemini-code"), { recursive: true, force: true });
    }
  });

  console.log("MCP:");
  const fixture = path.resolve("src", "tests", "fixtures", "mcp-server.mjs");
  /** A throwaway project and home folder, so real approvals are never touched. */
  const mcpFolders = async (servers: Record<string, unknown>, file = ".mcp.json") => {
    const base = path.resolve(".tmp-test", `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    const root = path.join(base, "project");
    const home = path.join(base, "home");
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(path.join(file === ".mcp.json" ? root : home, file), JSON.stringify({ mcpServers: servers }));
    return { root, home };
  };
  const stdioServer = { command: process.execPath, args: [fixture] };

  await test("a project's server doesn't start until the user approves it", async () => {
    await withPrompts(async (answers) => {
      const { root, home } = await mcpFolders({ demo: stdioServer });
      const declined = new McpManager(root, home);
      answers.push("n");
      await declined.connectAll();
      assert.equal(declined.status[0].state, "declined");
      assert.equal(declined.tools.length, 0);

      const approved = new McpManager(root, home);
      answers.push("y");
      await approved.connectAll();
      assert.equal(approved.status[0].state, "connected");
      await approved.close();
    });
  });

  await test("auto-approve doesn't start a project's server", async () => {
    const { root, home } = await mcpFolders({ demo: stdioServer });
    let asked = 0;
    setAsker(async () => {
      asked++;
      return "n";
    });
    process.env.GEMINI_CODE_AUTO_APPROVE = "1";
    const manager = new McpManager(root, home);
    await manager.connectAll();
    setAsker(undefined);
    assert.equal(asked, 1, "the question must still be asked");
    assert.equal(manager.status[0].state, "declined");
  });

  await test("approval is remembered, until the command changes", async () => {
    await withPrompts(async (answers) => {
      const { root, home } = await mcpFolders({ demo: stdioServer });
      answers.push("y");
      const first = new McpManager(root, home);
      await first.connectAll();
      await first.close();

      const again = new McpManager(root, home);
      await again.connectAll();
      assert.equal(again.status[0].state, "connected", "no second question");
      await again.close();

      await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { ...stdioServer, args: [fixture, "--changed"] } } }));
      answers.push("n");
      const changed = new McpManager(root, home);
      await changed.connectAll();
      assert.equal(changed.status[0].state, "declined", "a changed command needs approving again");
    });
  });

  await test("a personal server starts without asking", async () => {
    const { root, home } = await mcpFolders({ mine: stdioServer }, "mcp.json");
    const manager = new McpManager(root, home);
    await manager.connectAll();
    assert.equal(manager.status[0].source, "personal");
    assert.equal(manager.status[0].state, "connected");
    await manager.close();
  });

  await test("server tools are deferred, confirmed, and report errors and images", async () => {
    const { root, home } = await mcpFolders({ "my server": stdioServer }, "mcp.json");
    const manager = new McpManager(root, home);
    await manager.connectAll();
    const tool = (name: string) => manager.tools.find((t) => t.name === name)!;
    assert.deepEqual(manager.status[0].tools, [
      "mcp__my_server__add",
      "mcp__my_server__secret_env",
      "mcp__my_server__fail",
      "mcp__my_server__picture",
    ]);
    assert.ok(manager.tools.every((t) => t.deferred));
    assert.match(tool("mcp__my_server__add").description, /Adds two numbers[\s\S]*my server/);

    assert.deepEqual(await tool("mcp__my_server__add").run({ a: 2, b: 3 }), { ok: true, output: "5" });
    const failed = await tool("mcp__my_server__fail").run({});
    assert.equal(failed.ok, false);
    assert.equal(failed.output, "it broke");
    const picture = await tool("mcp__my_server__picture").run({});
    assert.ok(picture.attachment && (await readFile(picture.attachment)).length > 0);

    await withPrompts(async (answers) => {
      answers.push("n");
      assert.match((await tool("mcp__my_server__add").run({ a: 1, b: 1 })).output, /declined/);
    });
    await manager.close();
  });

  await test("a stdio server gets only what its config names, not our secrets", async () => {
    process.env.GEMINI_CODE_SMOKE_SECRET = "leaked";
    const { root, home } = await mcpFolders({ s: { ...stdioServer, env: { GIVEN: "${GEMINI_CODE_SMOKE_SECRET}" } } }, "mcp.json");
    const manager = new McpManager(root, home);
    await manager.connectAll();
    const env = manager.tools.find((t) => t.name.endsWith("secret_env"))!;
    assert.equal((await env.run({ name: "GEMINI_CODE_SMOKE_SECRET" })).output, "(unset)");
    assert.equal((await env.run({ name: "GIVEN" })).output, "leaked", "${VAR} expands when the config asks for it");
    await manager.close();
    delete process.env.GEMINI_CODE_SMOKE_SECRET;
  });

  await test("connects to a server over HTTP", async () => {
    const child = spawn(process.execPath, [fixture, "--http"], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      const url = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim())));
      const { root, home } = await mcpFolders({ remote: { url } }, "mcp.json");
      const manager = new McpManager(root, home);
      await manager.connectAll();
      assert.equal(manager.status[0].state, "connected", manager.status[0].error);
      assert.equal((await manager.tools[0].run({ a: 4, b: 5 })).output, "9");
      await manager.close();
    } finally {
      child.kill();
    }
  });

  await test("a server that won't start is reported, and the rest still connect", async () => {
    const { root, home } = await mcpFolders(
      { broken: { command: "this-command-does-not-exist-anywhere" }, good: stdioServer, empty: {} },
      "mcp.json"
    );
    const manager = new McpManager(root, home);
    await manager.connectAll();
    const state = Object.fromEntries(manager.status.map((s) => [s.name, s.state]));
    assert.deepEqual(state, { broken: "failed", good: "connected", empty: "failed" });
    assert.ok(manager.status.find((s) => s.name === "broken")?.error);
    await manager.close();
  });

  await test("a broken config file is a warning, not a crash", async () => {
    const { root, home } = await mcpFolders({});
    await writeFile(path.join(root, ".mcp.json"), "{not json");
    const warnings: string[] = [];
    assert.deepEqual(loadMcpConfig(root, home, (m) => warnings.push(m)), []);
    assert.match(warnings[0], /Ignoring/);
  });

  await test("a config saved with a BOM, as Windows PowerShell writes it, still loads", async () => {
    const { root, home } = await mcpFolders({});
    await writeFile(path.join(root, ".mcp.json"), "﻿" + JSON.stringify({ mcpServers: { bom: { command: "x" } } }));
    const warnings: string[] = [];
    assert.deepEqual(loadMcpConfig(root, home, (m) => warnings.push(m)).map((e) => e.name), ["bom"]);
    assert.deepEqual(warnings, []);
  });

  await test("a project's server replaces a personal one of the same name", async () => {
    const { root, home } = await mcpFolders({ same: { command: "personal" } }, "mcp.json");
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { same: { command: "project" } } }));
    assert.deepEqual(loadMcpConfig(root, home).map((e) => [e.source, e.config.command]), [["project", "project"]]);
  });

  await test("expands variables and defaults", () => {
    assert.equal(expandEnv("${A}-${B:-fallback}-${C}", { A: "1" }), "1-fallback-");
  });

  await test("plan mode blocks MCP tools, whatever a server says about them", () => {
    assert.ok(![...READ_ONLY_TOOLS].some((name) => name.startsWith("mcp__")));
  });

  console.log("Environment:");
  const machine = (platform: NodeJS.Platform, shell: string, have: string[]): EnvironmentInfo => ({
    platform,
    release: "1.0",
    arch: "x64",
    shell,
    commands: Object.fromEntries(["python3", "python", "node", "git", "brew"].map((c) => [c, have.includes(c)])),
  });

  await test("Windows with Git Bash: bash syntax, Windows paths", () => {
    const text = describeEnvironment(machine("win32", "bash.exe", ["python", "node", "git"]));
    assert.match(text, /^ENVIRONMENT: Windows 1\.0 \(x64\)/);
    assert.match(text, /Git Bash, so write bash/);
    assert.match(text, /C:\/Users/);
    assert.match(text, /Python is `python`/);
    assert.match(describeEnvironment(machine("win32", "bash.exe", ["python3", "python"])), /Python is `python`/,
      "on Windows, python is preferred when both work");
  });

  await test("Windows with cmd or PowerShell gets their own syntax, not bash's", () => {
    assert.match(describeEnvironment(machine("win32", "cmd.exe", [])), /write cmd: dir, del[\s\S]*no ls, rm, grep/);
    assert.match(describeEnvironment(machine("win32", "powershell.exe", [])), /write PowerShell[\s\S]*no `&&`/);
  });

  await test("macOS is told about BSD tools, Linux about GNU ones", () => {
    const mac = describeEnvironment(machine("darwin", "sh", ["python3", "git", "brew"]));
    assert.match(mac, /^ENVIRONMENT: macOS/);
    assert.match(mac, /sed -i ''/);
    assert.match(mac, /Python is `python3`; install packages with `python3 -m pip`/);
    assert.match(mac, /Not installed: node/);
    assert.match(describeEnvironment(machine("linux", "sh", ["python3"])), /GNU tools/);
  });

  await test("the primer carries the real machine's environment", () => {
    const primer = buildSystemPrimer([]);
    const expected = { win32: "Windows", darwin: "macOS", linux: "Linux" }[process.platform as string] ?? process.platform;
    assert.match(primer, new RegExp(`ENVIRONMENT: ${expected} `));
    assert.match(buildSystemPrimer([], "worker"), /ENVIRONMENT:/, "workers run commands too");
  });

  await test("PATH lookup finds a command by its Windows extension, and not a missing one", async () => {
    const dir = path.resolve(".tmp-test", "path-lookup");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "tool.CMD"), "");
    assert.equal(onPath("tool", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"), true);
    assert.equal(onPath("absent", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"), false);
  });

  console.log("Skills:");
  /** Writes files under a fresh folder. Each key is a path, each value its content. */
  const tree = async (files: Record<string, string>) => {
    const base = path.resolve(".tmp-test", `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(base, name)), { recursive: true });
      await writeFile(path.join(base, name), content);
    }
    await mkdir(base, { recursive: true });
    return base;
  };
  /** Stands in for GitHub: a real archive, laid out the way codeload's are. */
  const fakeGithub = async (files: Record<string, string>) => {
    const prefixed = Object.fromEntries(Object.entries(files).map(([k, v]) => [`repo-main/${k}`, v]));
    const base = await tree(prefixed);
    await tree({});
    const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(process.platform === "win32" ? system : "tar", ["-czf", path.join(base, "repo.tgz"), "-C", base, "repo-main"]);
    return { home: await tree({}), download: async (_url: string, file: string) => writeFile(file, await readFile(path.join(base, "repo.tgz"))) };
  };
  const skillMd = (name: string, description: string, body = "Do the thing.") =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

  await test("reads every way of naming a GitHub skill", () => {
    assert.deepEqual(parseSkillSource("anthropics/skills"), { owner: "anthropics", repo: "skills" });
    assert.deepEqual(parseSkillSource("https://github.com/anthropics/skills.git"), { owner: "anthropics", repo: "skills" });
    assert.deepEqual(parseSkillSource("a/b/skills/pdf"), { owner: "a", repo: "b", subpath: "skills/pdf" });
    assert.deepEqual(parseSkillSource("a/b@v2"), { owner: "a", repo: "b", ref: "v2" });
    assert.deepEqual(parseSkillSource("https://github.com/a/b/tree/main/skills/pdf/"), {
      owner: "a", repo: "b", ref: "main", subpath: "skills/pdf",
    });
    assert.deepEqual(parseSkillSource("https://github.com/a/b/blob/dev/x/SKILL.md"), { owner: "a", repo: "b", ref: "dev", subpath: "x" });
  });

  await test("refuses anything that isn't a GitHub repository", () => {
    for (const bad of ["", "justaname", "https://evil.example/a/b", "a/b/../../etc", "a b/c"]) {
      assert.throws(() => parseSkillSource(bad), /isn't a GitHub repository/, bad);
    }
  });

  await test("reads frontmatter, quoted and folded onto several lines", () => {
    assert.deepEqual(parseFrontmatter(`---\nname: "pdf"\ndescription: >\n  Reads PDFs\n  and fills forms\nlicense: MIT\n---\nBody`), {
      name: "pdf",
      description: "Reads PDFs and fills forms",
      license: "MIT",
    });
    assert.deepEqual(parseFrontmatter("no frontmatter here"), {});
  });

  await test("finds skills in the project, at home and in Claude's folder, project first", async () => {
    const root = await tree({
      ".gemini-code/skills/mine/SKILL.md": skillMd("mine", "Project one"),
      ".claude/skills/shared/SKILL.md": skillMd("shared", "From the project"),
    });
    const home = await tree({ "skills/installed/SKILL.md": skillMd("installed", "Installed") });
    const claude = await tree({
      "skills/synced/nested/SKILL.md": skillMd("nested", "Deep in a folder"),
      "skills/shared/SKILL.md": skillMd("shared", "From home"),
    });
    const found = await findSkills(root, home, claude);
    assert.deepEqual([...found.keys()].sort(), ["installed", "mine", "nested", "shared"]);
    assert.equal(found.get("shared")?.description, "From the project");
    assert.equal(found.get("nested")?.source, "claude");
  });

  await test("Claude's own skills can be turned off", async () => {
    const claude = await tree({ "skills/hidden/SKILL.md": skillMd("hidden", "Private") });
    process.env.GEMINI_CODE_CLAUDE_SKILLS = "0";
    try {
      assert.equal((await findSkills(await tree({}), await tree({}), claude)).size, 0);
    } finally {
      delete process.env.GEMINI_CODE_CLAUDE_SKILLS;
    }
  });

  await test("a skill loads with its folder, its files and Claude's tool names translated", async () => {
    const root = await tree({
      ".gemini-code/skills/pdf/SKILL.md": skillMd("pdf", "PDFs", "Run ${CLAUDE_SKILL_DIR}/scripts/go.py on $ARGUMENTS. See {baseDir}/ref.md"),
      ".gemini-code/skills/pdf/scripts/go.py": "print(1)",
      ".gemini-code/skills/pdf/ref.md": "reference",
    });
    const skill = (await findSkills(root, await tree({}), await tree({}))).get("pdf")!;
    const text = await renderSkill(skill, "invoice.pdf");
    const dir = skill.dir!.split(path.sep).join("/");
    assert.ok(text.includes(`Run ${dir}/scripts/go.py on invoice.pdf. See ${dir}/ref.md`), text);
    assert.match(text, /It bundles: .*scripts\/go\.py/);
    assert.match(text, /Read=read_file/);
    assert.ok(!text.includes("description: PDFs"), "the frontmatter isn't instructions");
  });

  await test("arguments reach a skill that doesn't ask for them by name", async () => {
    const root = await tree({ ".gemini-code/skills/plain/SKILL.md": skillMd("plain", "x") });
    const skill = (await findSkills(root, await tree({}), await tree({}))).get("plain")!;
    assert.match(await renderSkill(skill, "extra"), /Arguments given: extra/);
  });

  await test("use_skill reads bundled files, and only those", async () => {
    const dir = path.resolve(".gemini-code", "skills", "bundle");
    await mkdir(path.join(dir, "refs"), { recursive: true });
    try {
      await writeFile(path.join(dir, "SKILL.md"), skillMd("bundle", "x"));
      await writeFile(path.join(dir, "refs", "a.md"), "bundled text");
      assert.equal((await useSkillTool.run({ name: "bundle", file: "refs/a.md" })).output, "bundled text");
      for (const file of ["../../../package.json", "..", "missing.md", path.resolve("package.json")]) {
        assert.equal((await useSkillTool.run({ name: "bundle", file })).ok, false, file);
      }
    } finally {
      await rm(path.resolve(".gemini-code"), { recursive: true, force: true });
    }
  });

  await test("discovering a repo installs nothing, and shows what it would run", async () => {
    const github = await fakeGithub({
      "README.md": "not a skill",
      "skills/pdf/SKILL.md": skillMd("pdf", "Reads PDFs"),
      "skills/pdf/scripts/fill.py": "x",
      "skills/docx/SKILL.md": skillMd("docx", "Reads Word files"),
    });
    const found = await discoverSkills("a/b", github);
    assert.deepEqual(found.map((s) => s.name), ["docx", "pdf"]);
    assert.deepEqual(found[1].scripts, ["scripts/fill.py"]);
    assert.deepEqual(await listInstalled(github.home), []);
  });

  await test("installs what's chosen, with its files, and won't guess among several", async () => {
    const github = await fakeGithub({
      "skills/pdf/SKILL.md": skillMd("pdf", "Reads PDFs"),
      "skills/pdf/scripts/fill.py": "print('fill')",
      "skills/docx/SKILL.md": skillMd("docx", "Reads Word files"),
    });
    await assert.rejects(installSkills("a/b", [], github), /has 2 skills, so choose/);
    await assert.rejects(installSkills("a/b", ["nope"], github), /Not in that repository: nope/);

    await installSkills("a/b", ["pdf"], github);
    const installed = await listInstalled(github.home);
    assert.deepEqual(installed.map((s) => [s.name, s.source]), [["pdf", "a/b"]]);
    assert.equal(await readFile(path.join(github.home, "skills", "pdf", "scripts", "fill.py"), "utf8"), "print('fill')");
  });

  await test("a repo that is one skill, or one folder of a repo, installs directly", async () => {
    const single = await fakeGithub({ "SKILL.md": "# no frontmatter", "helper.md": "x" });
    assert.deepEqual((await installSkills("me/my-skill", [], single)).map((s) => s.name), ["my-skill"]);

    const many = await fakeGithub({ "x/one/SKILL.md": skillMd("one", "1"), "x/two/SKILL.md": skillMd("two", "2") });
    assert.deepEqual((await installSkills("a/b/x/two", [], many)).map((s) => s.name), ["two"]);
    await assert.rejects(installSkills("a/b/missing", [], many), /no folder "missing"/);
  });

  await test("reinstalling replaces the old copy, and removing deletes only that skill", async () => {
    const first = await fakeGithub({ "SKILL.md": skillMd("demo", "v1"), "old.md": "x" });
    await installSkills("a/demo", [], first);
    const second = await fakeGithub({ "SKILL.md": skillMd("demo", "v2") });
    await installSkills("a/demo", [], { ...second, home: first.home });
    assert.equal((await listInstalled(first.home))[0].description, "v2");
    await assert.rejects(readFile(path.join(first.home, "skills", "demo", "old.md"), "utf8"));

    await assert.rejects(removeSkill("other", first.home), /isn't installed/);
    await removeSkill("demo", first.home);
    assert.deepEqual(await listInstalled(first.home), []);
  });

  await test("a skill's name can't put it outside the skills folder", async () => {
    const github = await fakeGithub({ "SKILL.md": skillMd("../../escaped", "x") });
    await installSkills("a/b", [], github);
    await assert.rejects(readFile(path.join(github.home, "..", "escaped", "SKILL.md"), "utf8"));
    assert.equal((await listInstalled(github.home)).length, 1);
  });

  await test("a repo with no skills says so", async () => {
    const github = await fakeGithub({ "README.md": "nothing" });
    await assert.rejects(installSkills("a/b", [], github), /No skills found/);
  });

  await test("nothing Gemini can call installs a skill", () => {
    assert.ok(!tools.some((t) => /install|skill_add/i.test(t.name)));
    assert.ok(!READ_ONLY_TOOLS.has("skill_install"));
  });

  await test("the context lists skills, and caps how many", () => {
    const skills = Array.from({ length: 45 }, (_, i) => ({ name: `s${i}`, description: "d".repeat(500) }));
    const doc = buildContextDocument({ skills })!;
    assert.match(doc, /load it with use_skill/);
    assert.match(doc, /- s39:/);
    assert.ok(!doc.includes("- s40:"));
    assert.match(doc, /5 more/);
    assert.ok(!doc.includes("d".repeat(300)), "a long description is cut");
  });

  console.log("Desktop bridge:");
  const bridgeFixture = (replies: GeminiResponse[]) => {
    const events: BridgeEvent[] = [];
    const calls: string[] = [];
    const session = new AgentSession(new FakeDriver(replies));
    const host: BridgeHost = {
      runTask: (task, options) => session.runTask(task, options),
      latestMarkdown: async () => "",
      listModels: async () => {
        calls.push("list");
        return { models: [], thinking: [], current: "Gemini Auto" };
      },
      setModel: async (name) => {
        calls.push(`model start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        calls.push(`model end ${name}`);
      },
      setThinkingLevel: async () => undefined,
      newThread: async () => undefined,
      setPlanMode: (on) => session.setPlanMode(on),
      inPlanMode: () => session.inPlanMode,
      connectMcp: async () => undefined,
      mcpStatus: () => [],
      listGems: async () => [],
      setGem: async (name) => name,
      markInterrupted: async () => undefined,
      shutdown: async () => undefined,
    };
    const bridge = new Bridge(host, (e) => void events.push(e));
    const send = (command: Record<string, unknown>) => bridge.handleLine(JSON.stringify(command));
    const ofType = (type: string) => events.filter((e) => e.type === type);
    const until = async (type: string) => {
      while (!ofType(type).length) await new Promise((r) => setTimeout(r, 2));
      return ofType(type)[0];
    };
    return { bridge, events, calls, send, ofType, until };
  };
  const withConfirmations = async (fn: () => Promise<void>) => {
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    try {
      await fn();
    } finally {
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
      setAsker(undefined);
    }
  };

  await test("sorts the loop's log lines, worker tags included", () => {
    assert.deepEqual(classifyActivity("⏺ read_file(a.ts)"), { kind: "tool", text: "read_file(a.ts)", worker: undefined });
    assert.equal(classifyActivity("[api] ⏺ run_bash(ls)").worker, "api");
    assert.equal(classifyActivity("[api]   ⎿ 3 lines (40 B)").kind, "detail");
    assert.equal(classifyActivity("  ⎿ Exit code 1").failed, true);
    assert.equal(classifyActivity("[api] opening tab…").kind, "note");
    // The ASCII glyphs a legacy Windows console gets.
    assert.deepEqual(classifyActivity("* list_files(.)"), { kind: "tool", text: "list_files(.)", worker: undefined });
    assert.equal(classifyActivity("[api]   |-3 lines (40 B)").kind, "detail");
    assert.equal(classifyActivity("  |-Exit code 1").failed, true);
  });

  await test("reads the label and detail out of a confirmation question", () => {
    const q = parseQuestion("\n[gemini-code] Run this command?\n  npm test\n  (y/N) ");
    assert.deepEqual(q, { label: "Run this command?", detail: "npm test" });
  });

  await test("runs a task and reports tools, then the answer, then the end", async () => {
    const { bridge, send, ofType } = bridgeFixture([
      toolCallResponse("list_files", { path: "." }),
      finalResponse("All done."),
    ]);
    await send({ id: 1, cmd: "task", text: "look around" });
    await bridge.idle();
    assert.deepEqual(ofType("reply")[0], { type: "reply", id: 1, ok: true, data: undefined });
    assert.ok(ofType("activity").some((e) => e.kind === "tool" && String(e.text).startsWith("list_files")));
    assert.equal(ofType("answer")[0].text, "All done.");
    assert.equal(ofType("task_end")[0].status, "done");
  });

  await test("a plain question keeps its real answer, not just the nudge's reply", async () => {
    process.env.GEMINI_CODE_IDLE_NUDGES = "1";
    try {
      const { bridge, send, ofType } = bridgeFixture([
        finalResponse("Paris is the capital of France."),
        finalResponse("That answer is complete."),
      ]);
      await send({ cmd: "task", text: "capital of France?" });
      await bridge.idle();
      const answers = ofType("answer");
      assert.equal(answers[0].text, "Paris is the capital of France.");
      assert.equal(answers[0].interim, true);
      assert.equal(answers[1].text, "That answer is complete.");
    } finally {
      process.env.GEMINI_CODE_IDLE_NUDGES = "0";
    }
  });

  await test("a confirmation waits for the UI, and only that request is answered", async () => {
    await withConfirmations(async () => {
      const target = path.join(".tmp-test", "bridge-approved.txt");
      const { bridge, send, ofType, until } = bridgeFixture([
        toolCallResponse("write_file", { path: target, content: "hi" }),
        finalResponse("Wrote it."),
      ]);
      await send({ cmd: "task", text: "write it" });
      const ask = await until("confirm");
      assert.match(String(ask.label), /write/i);

      await send({ id: 2, cmd: "confirm", confirm_id: Number(ask.id) + 1, approve: true });
      assert.equal(ofType("reply").at(-1)?.ok, false, "a stale id must not approve anything");

      await send({ id: 3, cmd: "confirm", confirm_id: ask.id, approve: true });
      await bridge.idle();
      assert.equal(await readFile(target, "utf8"), "hi");
    });
  });

  await test("stop refuses the pending confirmation and ends at the next turn", async () => {
    await withConfirmations(async () => {
      const target = path.join(".tmp-test", "bridge-stopped.txt");
      const { bridge, send, ofType, until } = bridgeFixture([
        toolCallResponse("write_file", { path: target, content: "no" }),
        finalResponse("should never be read"),
      ]);
      await send({ cmd: "task", text: "write it" });
      await until("confirm");
      await send({ cmd: "stop" });
      await bridge.idle();
      assert.equal(ofType("task_end")[0].status, "stopped");
      assert.equal(ofType("confirm_closed").length, 1);
      await assert.rejects(readFile(target, "utf8"), "the refused write must not have happened");
    });
  });

  await test("refuses commands that would disturb a running task", async () => {
    await withConfirmations(async () => {
      const { bridge, send, ofType, until } = bridgeFixture([
        toolCallResponse("write_file", { path: path.join(".tmp-test", "bridge-busy.txt"), content: "x" }),
        finalResponse("Done."),
      ]);
      await send({ cmd: "task", text: "write it" });
      const ask = await until("confirm");
      await send({ id: 9, cmd: "new_chat" });
      assert.match(String(ofType("reply").at(-1)?.error), /while a task is running/);
      await send({ cmd: "confirm", confirm_id: ask.id, approve: false });
      await bridge.idle();
    });
  });

  await test("commands that use the tab's menus run one at a time", async () => {
    const { calls, send } = bridgeFixture([]);
    await Promise.all([send({ cmd: "model", text: "Auto" }), send({ cmd: "model", text: "Pro" })]);
    assert.deepEqual(calls, ["model start Auto", "model end Auto", "list", "model start Pro", "model end Pro", "list"]);
    setAsker(undefined);
  });

  await test("a question waits for the user, and stale answers are refused", async () => {
    const { bridge, send, ofType, until } = bridgeFixture([
      toolCallResponse("tool_search", { query: "select:ask_user" }),
      toolCallResponse("ask_user", { question: "Which database?", options: ["Postgres", "SQLite"] }),
      finalResponse("Going with SQLite."),
    ]);
    await send({ cmd: "task", text: "set up storage" });
    const asked = await until("question");
    assert.deepEqual(asked.options, ["Postgres", "SQLite"]);
    await send({ id: 2, cmd: "answer", question_id: Number(asked.id) + 1, text: "SQLite" });
    assert.equal(ofType("reply").at(-1)?.ok, false);
    await send({ cmd: "answer", question_id: asked.id, text: "SQLite" });
    await bridge.idle();
    assert.equal(ofType("question_closed")[0].answer, "SQLite");
    assert.equal(ofType("answer")[0].text, "Going with SQLite.");
    setAsker(undefined);
    setQuestioner(undefined);
  });

  await test("stop closes a pending question", async () => {
    const { bridge, send, ofType, until } = bridgeFixture([
      toolCallResponse("tool_search", { query: "select:ask_user" }),
      toolCallResponse("ask_user", { question: "Which?" }),
      finalResponse("never read"),
    ]);
    await send({ cmd: "task", text: "go" });
    await until("question");
    await send({ cmd: "stop" });
    await bridge.idle();
    assert.equal(ofType("task_end")[0].status, "stopped");
    setAsker(undefined);
    setQuestioner(undefined);
  });

  await test("task_end reports plan mode, which the model can end itself", async () => {
    const { bridge, send, ofType } = bridgeFixture([
      toolCallResponse("tool_search", { query: "select:exit_plan_mode" }),
      toolCallResponse("exit_plan_mode", { plan: "Do it." }),
      finalResponse("Done."),
    ]);
    await send({ id: 1, cmd: "plan_mode", on: true });
    await send({ cmd: "task", text: "plan it" });
    await bridge.idle();
    assert.equal(ofType("task_end")[0].planMode, false);
    setAsker(undefined);
    setQuestioner(undefined);
  });

  await test("bad input gets an error reply rather than killing the bridge", async () => {
    const { bridge, send, ofType } = bridgeFixture([]);
    await bridge.handleLine("not json");
    await send({ id: 1, cmd: "nonsense" });
    assert.equal(ofType("reply").length, 2);
    assert.ok(ofType("reply").every((r) => r.ok === false));
    setAsker(undefined);
  });

  console.log("multi_edit:");
  await multiEditTests(test);

  console.log("Ignore rules (.gitignore and the walk policy):");
  await gitignoreTests(test);

  console.log("Context (tree + memory):");
  await test("project tree renders and excludes noise directories", async () => {
    const tree = await buildProjectTree();
    assert.match(tree, /src\//);
    assert.ok(!tree.includes("node_modules"), "node_modules must be excluded");
    assert.ok(!tree.includes(".gemini-code-profile"), "browser profile must be excluded");
  });

  await test("GEMINI.md is created once and appended to, never clobbered", async () => {
    const memRoot = path.resolve(process.cwd(), ".tmp-test");
    const created = await ensureMemoryFile("fake-tree/", memRoot);
    assert.equal(created, true, "first call should create it");

    const createdAgain = await ensureMemoryFile("different-tree/", memRoot);
    assert.equal(createdAgain, false, "second call must not recreate/clobber");

    await appendMemory("uses pnpm, not npm", memRoot);
    const memory = await readMemory(memRoot);
    assert.match(String(memory), /fake-tree\//, "original content preserved");
    assert.match(String(memory), /uses pnpm, not npm/, "note appended");
  });

  await rm(tmpDir, { recursive: true, force: true });
  await rm(path.resolve(process.cwd(), ".gemini-code-tmp"), { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
