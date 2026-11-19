// A real MCP server over stdio or HTTP, built on the official SDK, so the client
// is tested against the protocol rather than against a mock of it.
//
//   node mcp-server.mjs            stdio
//   node mcp-server.mjs --http     prints its URL, then serves Streamable HTTP
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeServer() {
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "add",
        description: "Adds two numbers.",
        inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      },
      { name: "secret_env", description: "Says whether a variable reached the server.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
      { name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
      { name: "picture", description: "Returns an image.", inputSchema: { type: "object" } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    if (params.name === "add") return { content: [{ type: "text", text: String(args.a + args.b) }] };
    if (params.name === "secret_env") return { content: [{ type: "text", text: process.env[args.name] ?? "(unset)" }] };
    if (params.name === "picture") return { content: [{ type: "image", data: PIXEL, mimeType: "image/png" }] };
    return { isError: true, content: [{ type: "text", text: "it broke" }] };
  });
  return server;
}

if (process.argv.includes("--http")) {
  const listener = http.createServer(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await makeServer().connect(transport);
    let body = "";
    for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  listener.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${listener.address().port}/mcp`));
} else {
  await makeServer().connect(new StdioServerTransport());
}
