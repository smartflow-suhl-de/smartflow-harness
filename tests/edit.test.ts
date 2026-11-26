import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit } from "../src/tools/edit.ts";

test("exact unique replacement", () => {
  const out = applyEdit("const a = 1;\n", "const a = 1;", "const a = 2;", false);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.text, "const a = 2;\n");
    assert.equal(out.strategy, "exact");
  }
});

test("ambiguous match fails without replace_all", () => {
  const out = applyEdit("a\na\n", "a", "b", false);
  assert.equal(out.ok, false);
});

test("replace_all replaces every occurrence", () => {
  const out = applyEdit("a\na\n", "a", "b", true);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.text, "b\nb\n");
});

test("whitespace drift is tolerated", () => {
  const file = "function f() {\n    return 1;\n}\n";
  const out = applyEdit(file, "function f() {\n  return 1;\n}", "function f() {\n  return 2;\n}", false);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.strategy, "whitespace");
    assert.match(out.text, /return 2;/);
  }
});

test("missing string fails with guidance", () => {
  const out = applyEdit("hello\n", "nope", "x", false);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /not found/);
});
