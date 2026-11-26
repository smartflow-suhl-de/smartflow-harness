import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagnostics, formatDiagnostics } from "../src/diagnostics/runner.ts";
import { diagnosticsTool } from "../src/tools/diagnostics.ts";

test("parseDiagnostics parses tsc parentheses format", () => {
  const raw = "src/example.ts(14,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  const diags = parseDiagnostics(raw);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.file, "src/example.ts");
  assert.equal(diags[0]!.line, 14);
  assert.equal(diags[0]!.column, 5);
  assert.equal(diags[0]!.severity, "error");
  assert.equal(diags[0]!.code, "TS2322");
  assert.equal(diags[0]!.message, "Type 'string' is not assignable to type 'number'.");
});

test("parseDiagnostics parses tsc colon format", () => {
  const raw = "src/cli.ts:42:10 - warning TS6133: 'unused' is declared but its value is never read.\n";
  const diags = parseDiagnostics(raw);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.file, "src/cli.ts");
  assert.equal(diags[0]!.line, 42);
  assert.equal(diags[0]!.column, 10);
  assert.equal(diags[0]!.severity, "warning");
  assert.equal(diags[0]!.code, "TS6133");
});

test("formatDiagnostics formats clean results", () => {
  const text = formatDiagnostics([]);
  assert.match(text, /clean/);
});

test("formatDiagnostics lists errors with severity and code", () => {
  const diags = [
    {
      file: "foo.ts",
      line: 10,
      column: 2,
      severity: "error" as const,
      message: "Something broke",
      code: "TS1005",
    },
  ];
  const formatted = formatDiagnostics(diags);
  assert.match(formatted, /Found 1 diagnostic issue/);
  assert.match(formatted, /\[error\] foo\.ts:10:2 - Something broke \(TS1005\)/);
});

test("diagnosticsTool executes and returns a result", async () => {
  const result = await diagnosticsTool.execute({ path: "src/tools/registry.ts" }, {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    authorize: async () => true,
  });

  assert.ok(typeof result.ok === "boolean");
  assert.ok(typeof result.output === "string");
});
