import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubagent, discoverSubagents, BUILTIN_SUBAGENTS } from "../src/subagents/loader.ts";
import { createSubagentTool } from "../src/subagents/tool.ts";
import { defineTool, ToolRegistry } from "../src/tools/registry.ts";
import type { Provider } from "../src/provider/provider.ts";

test("parseSubagent extracts frontmatter and custom system prompt", () => {
  const content = `---
name: doc-helper
description: Documentation search helper
mode: plan
maxSteps: 10
---
You are a documentation search assistant. Return concise references.
`;

  const agent = parseSubagent(content, "/fake/doc-helper.md", "project");
  assert.ok(agent);
  assert.equal(agent.name, "doc-helper");
  assert.equal(agent.description, "Documentation search helper");
  assert.equal(agent.mode, "plan");
  assert.equal(agent.maxSteps, 10);
  assert.equal(agent.systemPrompt, "You are a documentation search assistant. Return concise references.");
});

test("discoverSubagents includes built-in research and review subagents", async () => {
  const agents = await discoverSubagents(process.cwd());
  assert.ok(agents.some((a) => a.name === "research" && a.origin === "builtin"));
  assert.ok(agents.some((a) => a.name === "review" && a.origin === "builtin"));
});

test("createSubagentTool fails for unknown subagents", async () => {
  const mockProvider = {
    name: "mock",
    model: "mock-model",
    complete: async () => ({ text: "done", toolCalls: [], stopReason: "stop" }),
  } as unknown as Provider;

  const baseTools = new ToolRegistry();
  const subagentTool = createSubagentTool({
    getSubagents: () => BUILTIN_SUBAGENTS,
    provider: mockProvider,
    baseTools,
    cwd: process.cwd(),
  });

  const res = await subagentTool.execute(
    { agent: "non_existent_agent", prompt: "hello" },
    { cwd: process.cwd(), signal: new AbortController().signal, authorize: async () => true },
  );

  assert.equal(res.ok, false);
  assert.match(res.output, /Unknown subagent "non_existent_agent"/);
});

test("createSubagentTool executes in-process and returns assistant answer", async () => {
  let subagentPromptSeen = "";
  const mockProvider = {
    name: "mock",
    model: "mock-model",
    complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
      subagentPromptSeen = req.messages[req.messages.length - 1]!.content;
      return {
        text: "Research report: Found 3 relevant modules.",
        toolCalls: [],
        stopReason: "stop",
      };
    },
  } as unknown as Provider;

  const readTool = defineTool({
    name: "read",
    description: "read a file",
    readOnly: true,
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async () => ({ ok: true, output: "file content" }),
  });

  const baseTools = new ToolRegistry([readTool]);
  const subagentTool = createSubagentTool({
    getSubagents: () => BUILTIN_SUBAGENTS,
    provider: mockProvider,
    baseTools,
    cwd: process.cwd(),
  });

  const res = await subagentTool.execute(
    { agent: "research", prompt: "Investigate module architecture" },
    { cwd: process.cwd(), signal: new AbortController().signal, authorize: async () => true },
  );

  assert.equal(res.ok, true);
  assert.equal(subagentPromptSeen, "Investigate module architecture");
  assert.equal(res.output, "Research report: Found 3 relevant modules.");
});
