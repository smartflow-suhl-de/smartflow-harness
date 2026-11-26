import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, displayWidth, layout } from "../src/ui/render.ts";
import { createCompleter, COMMANDS } from "../src/ui/commands.ts";
import { LineEditor } from "../src/ui/editor.ts";
import type { Key } from "../src/ui/keys.ts";

test("layout tracks the cursor in a single row", () => {
  const l = layout("› ", "abc", 2, 80);
  assert.equal(l.rows.length, 1);
  assert.equal(l.cursorRow, 0);
  assert.equal(l.cursorCol, 4, "prompt width + 2");
});

test("layout wraps at the terminal width", () => {
  const l = layout("", "abcdef", 6, 4);
  assert.deepEqual(l.rows, ["abcd", "ef"]);
  assert.equal(l.cursorRow, 1);
  assert.equal(l.cursorCol, 2);
});

test("layout keeps explicit newlines", () => {
  const l = layout("› ", "a\nb", 3, 80);
  assert.deepEqual(l.rows, ["› a", "b"]);
  assert.equal(l.cursorRow, 1);
  assert.equal(l.cursorCol, 1);
});

test("wide characters count as two columns", () => {
  assert.equal(displayWidth("日本"), 4);
  assert.equal(displayWidth("a日b"), 4);
  const l = layout("", "日本", 2, 80);
  assert.equal(l.cursorCol, 4);
});

test("clip never exceeds the budget", () => {
  assert.equal(displayWidth(clip("abcdef", 4)) <= 4, true);
  assert.equal(clip("abc", 10), "abc");
});

test("slash completion filters commands and shows hints", () => {
  const completer = createCompleter({ providers: () => ["openai", "ollama"] });
  const items = completer.complete("/co", 3);
  const values = items.map((i) => i.value.trim());
  assert.deepEqual(values, ["/connect", "/compact"]);
  assert.ok(items.every((i) => i.hint));
});

test("completion offers every command for a bare slash", () => {
  const completer = createCompleter({ providers: () => [] });
  assert.equal(completer.complete("/", 1).length, COMMANDS.length);
});

test("mode and provider arguments complete", () => {
  const completer = createCompleter({ providers: () => ["openai", "ollama"] });
  assert.deepEqual(
    completer.complete("/mode p", 7).map((i) => i.value.trim()),
    ["plan"],
  );
  assert.deepEqual(
    completer.complete("/connect o", 10).map((i) => i.value.trim()),
    ["openai", "ollama"],
  );
});

test("no completion for free text", () => {
  const completer = createCompleter({ providers: () => [] });
  assert.deepEqual(completer.complete("fix the bug", 11), []);
});

function editor() {
  const written: string[] = [];
  const ed = new LineEditor({
    write: (t) => written.push(t),
    size: () => ({ cols: 80, rows: 24 }),
  });
  return { ed, written };
}

const key = (k: Key) => k;

test("editor submits a line on enter", async () => {
  const { ed } = editor();
  const promise = ed.readLine({ prompt: "> ", history: [] });
  ed.handle([key({ type: "text", value: "hello" }), key({ type: "enter" })]);
  assert.equal(await promise, "hello");
});

test("editor returns undefined on ctrl+c instead of throwing", async () => {
  const { ed } = editor();
  const promise = ed.readLine({ prompt: "> ", history: [] });
  ed.handle([key({ type: "text", value: "abc" }), key({ type: "ctrl-c" })]);
  assert.equal(await promise, undefined);
});

test("ctrl+c on an empty line also resolves undefined", async () => {
  const { ed } = editor();
  const promise = ed.readLine({ prompt: "> ", history: [] });
  ed.handle([key({ type: "ctrl-c" })]);
  assert.equal(await promise, undefined);
});

test("history navigation restores the draft", async () => {
  const { ed } = editor();
  const promise = ed.readLine({ prompt: "> ", history: ["one", "two"] });
  ed.handle([key({ type: "text", value: "draft" })]);
  ed.handle([key({ type: "up" })]);
  ed.handle([key({ type: "up" })]);
  ed.handle([key({ type: "down" })]);
  ed.handle([key({ type: "down" })]);
  ed.handle([key({ type: "enter" })]);
  assert.equal(await promise, "draft");
});

test("tab completes a unique command", async () => {
  const { ed, written } = editor();
  const completer = createCompleter({ providers: () => [] });
  const promise = ed.readLine({ prompt: "> ", history: [], completer });
  ed.handle([key({ type: "text", value: "/ses" })]);
  ed.handle([key({ type: "tab" })]);
  ed.handle([key({ type: "enter" })]);
  assert.equal(await promise, "/session ");
  assert.ok(written.length > 0);
});

test("tab opens a menu, arrows move, enter accepts", async () => {
  const { ed } = editor();
  const completer = createCompleter({ providers: () => [] });
  const promise = ed.readLine({ prompt: "> ", history: [], completer });
  ed.handle([key({ type: "text", value: "/co" })]);
  ed.handle([key({ type: "tab" })]);
  ed.handle([key({ type: "down" })]);
  ed.handle([key({ type: "enter" })]);
  ed.handle([key({ type: "enter" })]);
  assert.equal(await promise, "/compact ");
});

test("multi-line input via ctrl+j", async () => {
  const { ed } = editor();
  const promise = ed.readLine({ prompt: "> ", history: [] });
  ed.handle([key({ type: "text", value: "line1" })]);
  ed.handle([key({ type: "ctrl-j" })]);
  ed.handle([key({ type: "text", value: "line2" })]);
  ed.handle([key({ type: "enter" })]);
  assert.equal(await promise, "line1\nline2");
});

test("word deletion and kill/yank", async () => {
  const { ed } = editor();
  const promise = ed.readLine({ prompt: "> ", history: [] });
  ed.handle([key({ type: "text", value: "one two" })]);
  ed.handle([key({ type: "ctrl-w" })]);
  ed.handle([key({ type: "enter" })]);
  assert.equal(await promise, "one ");
});