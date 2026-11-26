import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool, ToolRegistry } from "../src/tools/registry.ts";
import { scoreTool, searchTools } from "../src/tools/search.ts";

function makeDummyTool(name: string, description: string, props: string[] = []) {
  const properties: Record<string, unknown> = {};
  for (const p of props) properties[p] = { type: "string" };

  return defineTool({
    name,
    description,
    readOnly: true,
    parameters: {
      type: "object",
      properties,
    },
    async execute() {
      return { ok: true, output: `executed ${name}` };
    },
  });
}

test("scoreTool ranks exact name matches higher than description matches", () => {
  const toolA = makeDummyTool("deploy_app", "Deploy the application to cloud");
  const toolB = makeDummyTool("cloud_status", "Show status of deployed app");

  const scoreA = scoreTool(toolA, "deploy");
  const scoreB = scoreTool(toolB, "deploy");

  assert.ok(scoreA > scoreB);
  assert.ok(scoreB > 0);
});

test("searchTools returns matching tools ranked by score", () => {
  const t1 = makeDummyTool("git_commit", "Commit changes to git");
  const t2 = makeDummyTool("git_status", "Show working tree status");
  const t3 = makeDummyTool("run_sql", "Execute SQL database queries");

  const results = searchTools([t1, t2, t3], "git status");
  assert.equal(results.length, 2);
  assert.equal(results[0]!.spec.name, "git_status");
  assert.equal(results[1]!.spec.name, "git_commit");
});

test("ToolRegistry auto-defers tools beyond threshold and includes tool_search", async () => {
  const tools = [];
  for (let i = 1; i <= 20; i++) {
    tools.push(makeDummyTool(`tool_${i}`, `Description for tool number ${i}`, [`param_${i}`]));
  }

  const registry = new ToolRegistry(tools, { autoDeferThreshold: 15 });

  assert.equal(registry.allNames().length, 20);
  assert.equal(registry.getDeferredTools().length, 5);

  const specs = registry.specs();
  // 15 active + 1 tool_search
  assert.equal(specs.length, 16);
  assert.ok(specs.some((s) => s.name === "tool_search"));

  // Execute tool_search to discover tool_18
  const searchTool = registry.get("tool_search")!;
  const res = await searchTool.execute(
    { query: "tool_18" },
    { cwd: process.cwd(), signal: new AbortController().signal, authorize: async () => true },
  );

  assert.equal(res.ok, true);
  assert.match(res.output, /tool_18/);

  // Now tool_18 is activated!
  assert.ok(registry.specs().some((s) => s.name === "tool_18"));
});
