import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyDecoder } from "../src/ui/keys.ts";

function types(keys: ReturnType<KeyDecoder["push"]>): string[] {
  return keys.map((k) => (k.type === "text" || k.type === "paste" ? `${k.type}:${k.value}` : k.type));
}

test("plain text becomes a text key", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("hello")), ["text:hello"]);
});

test("arrow keys decode", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("\u001b[A\u001b[B\u001b[C\u001b[D")), ["up", "down", "right", "left"]);
});

test("application-mode arrows decode too", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("\u001bOA\u001bOB")), ["up", "down"]);
});

test("escape sequences split across chunks are reassembled", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("\u001b")), []);
  assert.deepEqual(types(d.push("[")), []);
  assert.deepEqual(types(d.push("A")), ["up"]);
});

test("delete and home/end variants", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("\u001b[3~\u001b[1~\u001b[4~")), ["delete", "home", "end"]);
  assert.deepEqual(types(d.push("\u001b[H\u001b[F")), ["home", "end"]);
});

test("ctrl keys decode, and ctrl+j is not a submit", () => {
  const d = new KeyDecoder();
  assert.deepEqual(
    types(d.push("\u0001\u0005\u0003\u0004\u000b\u0015\u0017\u0019\u000e\u0010\u000c")),
    ["ctrl-a", "ctrl-e", "ctrl-c", "ctrl-d", "ctrl-k", "ctrl-u", "ctrl-w", "ctrl-y", "ctrl-n", "ctrl-p", "ctrl-l"],
  );
  assert.deepEqual(types(d.push("\r")), ["enter"]);
  assert.deepEqual(types(d.push("\n")), ["ctrl-j"]);
});

test("alt+b and alt+f move by word", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("\u001bb\u001bf")), ["alt-b", "alt-f"]);
});

test("ctrl+arrow maps to word movement", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("\u001b[1;5C\u001b[1;5D")), ["alt-f", "alt-b"]);
});

test("tab and shift-tab", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("\t\u001b[Z")), ["tab", "shift-tab"]);
});

test("ctrl+j is the multi-line key, plain newline bytes are separate", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("line1\nline2")), ["text:line1", "ctrl-j", "text:line2"]);
});

test("bracketed paste arrives as one literal block", () => {
  const d = new KeyDecoder();
  const keys = d.push("\u001b[200~line1\nline2\u001b[201~");
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0], { type: "paste", value: "line1\nline2" });
});

test("bracketed paste split across chunks is reassembled", () => {
  const d = new KeyDecoder();
  assert.deepEqual(d.push("\u001b[200~abc"), []);
  assert.deepEqual(d.push("def"), []);
  assert.deepEqual(d.push("\u001b[201~"), [{ type: "paste", value: "abcdef" }]);
});

test("text and controls in one chunk are split correctly", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.push("ab\u0003cd")), ["text:ab", "ctrl-c", "text:cd"]);
});