import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { confirmAction } from "./confirm.js";

export const MCP_CONFIG_FILENAME = ".mcp.json";

const CONNECT_TIMEOUT_MS = 60_000;
const MAX_DESCRIPTION_CHARS = 3_000;
const MAX_STDERR_CHARS = 1_000;
const TMP_DIR = ".gemini-code-tmp";

function callTimeoutMs(): number {
  return Number(process.env.GEMINI_CODE_MCP_TIMEOUT_MS ?? 60_000);
}

/** One entry of `mcpServers`, in the format Claude Code uses for .mcp.json. */
export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerEntry {
  name: string;
  /** "project" came from the repo and needs approval. "personal" is the user's own. */
  source: "project" | "personal";
  config: McpServerConfig;
}

export interface McpServerStatus {
  name: string;
  source: McpServerEntry["source"];
  state: "connected" | "failed" | "declined" | "disconnected";
  tools: string[];
  error?: string;
}

/** `${VAR}` and `${VAR:-default}`, so a config can be committed without its secrets. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

function expandConfig(config: McpServerConfig): McpServerConfig {
  const map = (values?: Record<string, string>) =>
    values && Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expandEnv(String(v))]));
  return {
    ...config,
    command: config.command && expandEnv(config.command),
    args: config.args?.map((arg) => expandEnv(String(arg))),
    url: config.url && expandEnv(config.url),
    env: map(config.env),
    headers: map(config.headers),
  };
}

function readServers(file: string, warn: (msg: string) => void): Record<string, McpServerConfig> {
  if (!existsSync(file)) return {};
  try {
    // Without the BOM that Windows PowerShell and some editors put at the start,
    // which JSON.parse rejects, so the whole file was quietly ignored.
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, McpServerConfig> };
    return parsed.mcpServers ?? {};
  } catch (err) {
    warn(`Ignoring ${file}: ${(err as Error).message}`);
    return {};
  }
}

/** Project servers win over personal ones of the same name. */
export function loadMcpConfig(
  root = process.cwd(),
  home = path.join(homedir(), ".gemini-code"),
  warn: (msg: string) => void = () => {}
): McpServerEntry[] {
  const servers = new Map<string, McpServerEntry>();
  for (const [name, config] of Object.entries(readServers(path.join(home, "mcp.json"), warn))) {
    servers.set(name, { name, source: "personal", config });
  }
  for (const [name, config] of Object.entries(readServers(path.join(root, MCP_CONFIG_FILENAME), warn))) {
    servers.set(name, { name, source: "project", config });
  }
  return [...servers.values()];
}

/**
 * What the user approved, tied to the exact config. A change to the command,
 * or a different project using the same server name, has to be approved again:
 * otherwise a later commit could swap an approved command for another one.
 */
export function approvalKey(root: string, entry: McpServerEntry): string {
  return createHash("sha256").update(JSON.stringify([path.resolve(root), entry.name, entry.config])).digest("hex");
}

function describeServer(entry: McpServerEntry): string {
  const { command, args = [], url, env } = entry.config;
  const target = url ?? [command, ...args].join(" ");
  const names = Object.keys(env ?? {});
  return `${target}${names.length ? `\nenvironment: ${names.join(", ")}` : ""}`;
}

/** MCP tools are named mcp__server__tool, as Claude Code names them. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${safe(server)}__${safe(tool)}`;
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string };
}

/**
 * Turns a tools/call result into what the agent loop expects. A plain record,
 * because the SDK also allows an old `{ toolResult }` shape with none of these
 * fields, which then reads as "the tool returned nothing" rather than failing.
 */
export function formatMcpResult(
  result: Record<string, unknown>,
  saveImage: (data: string, mimeType: string) => string = saveTempImage
): ToolResult {
  const blocks = (Array.isArray(result.content) ? result.content : []) as ContentBlock[];
  const parts: string[] = [];
  let attachment: string | undefined;

  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text ?? "");
    else if (block.type === "image" && block.data && !attachment) {
      attachment = saveImage(block.data, block.mimeType ?? "image/png");
      parts.push("[image attached]");
    } else if (block.type === "resource") parts.push(block.resource?.text ?? `[resource ${block.resource?.uri ?? ""}]`);
    else if (block.type === "resource_link") parts.push(`[resource ${block.uri ?? ""}]`);
    else parts.push(`[${block.type} content not shown]`);
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  if (!parts.length && "toolResult" in result) parts.push(JSON.stringify(result.toolResult));

  return { ok: !result.isError, output: parts.join("\n") || "(the tool returned nothing)", ...(attachment ? { attachment } : {}) };
}

function saveTempImage(data: string, mimeType: string): string {
  const dir = path.resolve(process.cwd(), TMP_DIR);
  mkdirSync(dir, { recursive: true });
  // Short on purpose: the upload check matches on the attachment's filename.
  const file = path.join(dir, `mcp-${Date.now().toString(36)}.${mimeType.split("/")[1] ?? "png"}`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

interface LiveServer {
  client: Client;
  status: McpServerStatus;
}

/**
 * The project's MCP servers, and their tools as ordinary deferred tools.
 *
 * Every server connects at startup, because tool_search can only offer what's
 * known, but none of its descriptions reach Gemini until they're asked for, so
 * a server with fifty tools costs fifty names rather than fifty schemas.
 *
 * The trust boundary is deliberate. A project's .mcp.json can name any command,
 * so opening a cloned repository must not run it: each project server needs the
 * user's approval, and auto-approve doesn't apply. Once running, each tool call
 * is confirmed like any other side effect, and nothing a server says about
 * itself ("read-only") is taken on trust, so plan mode blocks all of them.
 */
export class McpManager {
  readonly tools: ToolDefinition[] = [];
  private readonly servers = new Map<string, LiveServer>();
  private readonly statuses: McpServerStatus[] = [];

  constructor(
    private readonly root = process.cwd(),
    private readonly home = path.join(homedir(), ".gemini-code")
  ) {}

  get status(): McpServerStatus[] {
    return this.statuses;
  }

  private approvedFile(): string {
    return path.join(this.home, "mcp-approved.json");
  }

  private approvedKeys(): string[] {
    try {
      return JSON.parse(readFileSync(this.approvedFile(), "utf8")) as string[];
    } catch {
      return [];
    }
  }

  private async approved(entry: McpServerEntry): Promise<boolean> {
    if (entry.source === "personal") return true;
    const key = approvalKey(this.root, entry);
    const known = this.approvedKeys();
    if (known.includes(key)) return true;

    const yes = await confirmAction(
      `Start MCP server "${entry.name}" from this project's ${MCP_CONFIG_FILENAME}?`,
      describeServer(entry),
      { always: true }
    );
    if (yes) {
      mkdirSync(this.home, { recursive: true });
      writeFileSync(this.approvedFile(), JSON.stringify([...known, key], null, 2), "utf8");
    }
    return yes;
  }

  async connectAll(log: (msg: string) => void = () => {}): Promise<void> {
    const entries = loadMcpConfig(this.root, this.home, log);
    const allowed: McpServerEntry[] = [];
    // One at a time: these are questions for a person.
    for (const entry of entries) {
      if (await this.approved(entry)) allowed.push(entry);
      else this.statuses.push({ name: entry.name, source: entry.source, state: "declined", tools: [] });
    }
    await Promise.all(allowed.map((entry) => this.connect(entry, log)));
  }

  private async connect(entry: McpServerEntry, log: (msg: string) => void): Promise<void> {
    const status: McpServerStatus = { name: entry.name, source: entry.source, state: "failed", tools: [] };
    this.statuses.push(status);
    const config = expandConfig(entry.config);
    let stderr = "";

    try {
      const transport = makeTransport(config, this.root);
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
        });
      }
      const client = new Client({ name: "gemini-code", version: "0" });
      client.onclose = () => {
        if (status.state === "connected") status.state = "disconnected";
      };
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });

      const found: { name: string; description?: string; inputSchema?: unknown }[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor }, { timeout: CONNECT_TIMEOUT_MS });
        found.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);

      for (const tool of found) {
        const definition = this.makeTool(entry.name, client, status, tool);
        this.tools.push(definition);
        status.tools.push(definition.name);
      }
      this.servers.set(entry.name, { client, status });
      status.state = "connected";
      log(`MCP server "${entry.name}" connected: ${found.length} tool(s).`);
    } catch (err) {
      const reason = `${(err as Error).message.split("\n")[0]}${stderr.trim() ? ` (${stderr.trim().split("\n").at(-1)})` : ""}`;
      status.error = reason;
      log(`MCP server "${entry.name}" failed: ${reason}`);
    }
  }

  private makeTool(
    server: string,
    client: Client,
    status: McpServerStatus,
    tool: { name: string; description?: string; inputSchema?: unknown }
  ): ToolDefinition {
    const name = mcpToolName(server, tool.name);
    const signature = JSON.stringify(tool.inputSchema ?? {});
    return {
      name,
      deferred: true,
      description:
        `${name}(args matching ${signature}) -> ${tool.description ?? "no description"} ` +
        `(from the MCP server "${server}")`.slice(0, MAX_DESCRIPTION_CHARS),
      async run(args) {
        if (status.state !== "connected") return { ok: false, output: `MCP server "${server}" is not connected.` };
        if (!(await confirmAction(`Run MCP tool ${tool.name} from "${server}"?`, JSON.stringify(args, null, 2)))) {
          return { ok: false, output: "User declined this tool call." };
        }
        try {
          const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: callTimeoutMs() });
          return formatMcpResult(result);
        } catch (err) {
          return { ok: false, output: `MCP error: ${(err as Error).message}` };
        }
      },
    };
  }

  /** Stops every server, so none outlives the session that started it. */
  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.client.close().catch(() => undefined)));
    this.servers.clear();
  }
}

function makeTransport(config: McpServerConfig, root: string) {
  if (config.url) {
    const url = new URL(config.url);
    const requestInit = { headers: config.headers ?? {} };
    return config.type === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }
  if (!config.command) throw new Error(`needs a "command" or a "url"`);
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    // The SDK's minimal environment, not all of ours: a server gets only what
    // its config names, rather than every secret in the user's shell.
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    cwd: root,
    stderr: "pipe",
  });
}
