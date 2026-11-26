import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AcpServer } from "../src/acp/server.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Provider } from "../src/provider/provider.ts";

function createMockProvider(response = "ACP mock response"): Provider {
  return {
    name: "mock",
    model: "mock-model",
    complete: async () => ({
      text: response,
      toolCalls: [],
      stopReason: "stop",
    }),
  } as unknown as Provider;
}

test("AcpServer handles initialize request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const server = new AcpServer({
    input,
    output,
    provider: createMockProvider(),
    baseTools: new ToolRegistry(),
    defaultCwd: process.cwd(),
    systemPrompt: "test",
  });

  server.start();

  const responses: any[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });

  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "zed" } },
    }) + "\n",
  );

  await new Promise((r) => setTimeout(r, 50));
  server.stop();

  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.protocolVersion, 1);
  assert.equal(responses[0].result.serverInfo.name, "harness");
  assert.equal(responses[0].result.capabilities.prompts, true);
});

test("AcpServer handles session lifecycle: create, prompt, streaming update, destroy", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const server = new AcpServer({
    input,
    output,
    provider: createMockProvider("Hello from ACP!"),
    baseTools: new ToolRegistry(),
    defaultCwd: process.cwd(),
    systemPrompt: "test prompt",
  });

  server.start();

  const messages: any[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });

  // 1. Create Session
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "session/create",
      params: { mode: "plan" },
    }) + "\n",
  );

  await new Promise((r) => setTimeout(r, 50));
  const createResp = messages.find((m) => m.id === 10);
  assert.ok(createResp?.result?.sessionId);
  const sessionId = createResp.result.sessionId;

  // 2. Prompt Session
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: { sessionId, prompt: "Perform analysis" },
    }) + "\n",
  );

  await new Promise((r) => setTimeout(r, 100));

  // Verify notifications (streaming updates)
  const updates = messages.filter((m) => m.method === "session/update");
  assert.ok(updates.length > 0);
  assert.equal(updates[0].params.sessionId, sessionId);

  // Verify prompt response
  const promptResp = messages.find((m) => m.id === 11);
  assert.ok(promptResp);
  assert.equal(promptResp.result.stopReason, "stop");

  // 3. Destroy Session
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "session/destroy",
      params: { sessionId },
    }) + "\n",
  );

  await new Promise((r) => setTimeout(r, 50));
  const destroyResp = messages.find((m) => m.id === 12);
  assert.ok(destroyResp?.result?.ok);

  server.stop();
});

test("AcpServer handles errors: invalid JSON, unknown method, missing session", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const server = new AcpServer({
    input,
    output,
    provider: createMockProvider(),
    baseTools: new ToolRegistry(),
    defaultCwd: process.cwd(),
    systemPrompt: "test",
  });

  server.start();

  const messages: any[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });

  // Invalid JSON
  input.write("{ invalid json \n");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(messages[0].error.code, -32700);

  // Unknown method
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "unknown/method",
    }) + "\n",
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(messages[1].id, 99);
  assert.equal(messages[1].error.code, -32601);

  // Missing session in prompt
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 100,
      method: "session/prompt",
      params: { sessionId: "non-existent-id", prompt: "hi" },
    }) + "\n",
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(messages[2].id, 100);
  assert.equal(messages[2].error.code, -32602);

  server.stop();
});
