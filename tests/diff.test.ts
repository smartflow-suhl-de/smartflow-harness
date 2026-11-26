import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDiffLines, createUnifiedDiff, diffTool } from "../src/tools/diff.ts";

test("computeDiffLines detects additions, deletions and unchanged lines", () => {
  const oldLines = ["line 1", "line 2", "line 3"];
  const newLines = ["line 1", "line 2 modified", "line 3", "line 4"];

  const diff = computeDiffLines(oldLines, newLines);
  assert.ok(diff.some((d) => d.type === "same" && d.line === "line 1"));
  assert.ok(diff.some((d) => d.type === "del" && d.line === "line 2"));
  assert.ok(diff.some((d) => d.type === "add" && d.line === "line 2 modified"));
  assert.ok(diff.some((d) => d.type === "add" && d.line === "line 4"));
});

test("createUnifiedDiff returns empty string when texts are identical", () => {
  const text = "function test() {\n  return 42;\n}\n";
  const diff = createUnifiedDiff("a.ts", "b.ts", text, text);
  assert.equal(diff, "");
});

test("createUnifiedDiff formats unified diff header and hunks correctly", () => {
  const oldText = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
  const newText = "const a = 1;\nconst b = 99;\nconst c = 3;\n";

  const diff = createUnifiedDiff("test.ts", "test.ts", oldText, newText, 1);
  assert.ok(diff.startsWith("--- test.ts\n+++ test.ts\n"));
  assert.ok(diff.includes("@@ -1,3 +1,3 @@"));
  assert.ok(diff.includes(" const a = 1;"));
  assert.ok(diff.includes("-const b = 2;"));
  assert.ok(diff.includes("+const b = 99;"));
  assert.ok(diff.includes(" const c = 3;"));
});

test("diffTool reports changes or clean workspace", async () => {
  const result = await diffTool.execute({}, {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    authorize: async () => true,
  });

  assert.equal(result.ok, true);
  assert.ok(typeof result.output === "string");
});
