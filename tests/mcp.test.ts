import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { McpClient } from "../src/mcp/client.ts";
import { isMcpToolReadOnly, mcpToolToTool } from "../src/mcp/adapter.ts";

test("isMcpToolReadOnly identifies read-only prefixes", () => {
  assert.equal(isMcpToolReadOnly("get_user"), true);
  assert.equal(isMcpToolReadOnly("list_items"), true);
  assert.equal(isMcpToolReadOnly("search_docs"), true);
  assert.equal(isMcpToolReadOnly("delete_user"), false);
  assert.equal(isMcpToolReadOnly("create_database"), false);
});

test("mcpToolToTool wraps schema into executable Tool", () => {
  let calledWith: unknown = null;
  const mockClient = {
    name: "testServer",
    async callTool(name: string, args: Record<string, unknown>) {
      calledWith = { name, args };
      return { ok: true, output: "mock output" };
    },
  } as unknown as McpClient;

  const tool = mcpToolToTool(
    "testServer",
    {
      name: "get_weather",
      description: "Get weather for city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
    mockClient,
  );

  assert.equal(tool.spec.name, "testServer__get_weather");
  assert.equal(tool.spec.readOnly, true);
  assert.equal(tool.spec.description, "Get weather for city");
});

test("McpClient communicates with a stdio MCP server process", async () => {
  // Create a minimal Node script acting as a mock MCP server
  const serverScript = join(process.cwd(), "test-mcp-mock-server.cjs");
  const code = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2024-11-05", serverInfo: { name: "mock-server", version: "1.0.0" } }
    }));
  } else if (msg.method === "tools/list") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{
          name: "calculate_sum",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"]
          }
        }]
      }
    }));
  } else if (msg.method === "tools/call") {
    const { a, b } = msg.params.arguments;
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: String((a || 0) + (b || 0)) }]
      }
    }));
  }
});
`;
  await writeFile(serverScript, code, "utf8");

  const client = new McpClient("calcServer", {
    command: process.execPath,
    args: [serverScript],
  });

  try {
    await client.connect();

    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "calculate_sum");

    const callResult = await client.callTool("calculate_sum", { a: 15, b: 27 });
    assert.equal(callResult.ok, true);
    assert.equal(callResult.output, "42");
  } finally {
    client.close();
    await unlink(serverScript).catch(() => {});
  }
});
