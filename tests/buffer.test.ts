import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptBuffer } from "../src/ui/buffer.ts";

test("insert and cursor movement", () => {
  const b = new PromptBuffer();
  b.insert("hello");
  assert.equal(b.value, "hello");
  assert.equal(b.cursor, 5);
  b.left();
  b.left();
  b.insert("X");
  assert.equal(b.value, "helXlo");
  assert.equal(b.cursor, 4);
});

test("backspace and delete honour the cursor", () => {
  const b = new PromptBuffer();
  b.set("abcd");
  b.start();
  assert.equal(b.backspace(), false, "nothing left of the cursor");
  assert.equal(b.deleteForward(), true);
  assert.equal(b.value, "bcd");
  b.end();
  assert.equal(b.deleteForward(), false);
  assert.equal(b.backspace(), true);
  assert.equal(b.value, "bc");
});

test("word movement stops at word boundaries", () => {
  const b = new PromptBuffer();
  b.set("git commit -m message");
  b.wordLeft();
  assert.equal(b.cursor, 14, "start of the last word");
  b.wordLeft();
  assert.equal(b.cursor, 11, "start of -m");
  b.wordRight();
  assert.equal(b.cursor, 13);
  b.start();
  b.wordRight();
  assert.equal(b.cursor, 3);
});

test("ctrl+w removes the word but keeps the space before it", () => {
  const b = new PromptBuffer();
  b.set("run the tests");
  b.deleteWordBackKeepSpace();
  assert.equal(b.value, "run the ");
  b.deleteWordBackKeepSpace();
  assert.equal(b.value, "run ");
});

test("kill to end returns the tail and leaves the head", () => {
  const b = new PromptBuffer();
  b.set("alpha beta gamma");
  b.wordLeft();
  b.wordLeft();
  const killed = b.killToEnd();
  assert.equal(killed, "beta gamma");
  assert.equal(b.value, "alpha ");
});

test("kill to start returns the head and leaves the tail", () => {
  const b = new PromptBuffer();
  b.set("alpha beta");
  b.wordLeft();
  assert.equal(b.killToStart(), "alpha ");
  assert.equal(b.value, "beta");
  assert.equal(b.cursor, 0);
});

test("multi-line values and word movement across newlines", () => {
  const b = new PromptBuffer();
  b.set("line one\nline two");
  b.wordLeft();
  assert.equal(b.value.slice(b.cursor), "two");
  b.start();
  b.wordRight();
  assert.equal(b.cursor, 4);
});

test("replaceRange replaces the current word", () => {
  const b = new PromptBuffer();
  b.set("/con");
  b.replaceRange(0, 4, "/connect ");
  assert.equal(b.value, "/connect ");
  assert.equal(b.cursor, 9);
});