import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptBuffer } from "../src/ui/buffer.ts";
import { CompletionMenu } from "../src/ui/completion.ts";
import type { Completer } from "../src/ui/completion.ts";

const commands: Completer = {
  complete(buffer, cursor) {
    const typed = buffer.slice(0, cursor);
    const all = ["/connect ", "/compact ", "/session ", "/exit "];
    return all.filter((item) => item.startsWith(typed)).map((value) => ({ value }));
  },
};

function setup(initial = "") {
  const buffer = new PromptBuffer();
  buffer.set(initial);
  return { buffer, menu: new CompletionMenu(buffer, commands) };
}

test("a unique match is inserted directly without opening the menu", () => {
  const { buffer, menu } = setup("/ses");
  menu.tab(false);
  assert.equal(buffer.value, "/session ");
  assert.equal(menu.isOpen, false);
});

test("several matches open the menu", () => {
  const { menu } = setup("/co");
  menu.tab(false);
  assert.equal(menu.isOpen, true);
  assert.deepEqual(
    menu.items.map((item) => item.value),
    ["/connect ", "/compact "],
  );
});

test("tab cycles and previews the selection", () => {
  const { buffer, menu } = setup("/co");
  menu.tab(false);
  menu.tab(false);
  assert.equal(buffer.value, "/compact ");
  assert.equal(menu.index, 1);
  menu.tab(false);
  assert.equal(buffer.value, "/connect ");
  assert.equal(menu.index, 0);
});

test("shift+tab moves backwards", () => {
  const { buffer, menu } = setup("/co");
  menu.tab(false);
  menu.tab(true);
  assert.equal(buffer.value, "/compact ", "wraps around to the last item");
});

test("escape closes the menu and keeps the buffer", () => {
  const { buffer, menu } = setup("/co");
  menu.tab(false);
  menu.dismiss();
  assert.equal(menu.isOpen, false);
  assert.equal(buffer.value, "/co");
});

test("no completer means no menu", () => {
  const buffer = new PromptBuffer();
  buffer.set("/co");
  const menu = new CompletionMenu(buffer, undefined);
  menu.tab(false);
  assert.equal(menu.isOpen, false);
  assert.equal(buffer.value, "/co");
});

test("completion respects the cursor position", () => {
  const buffer = new PromptBuffer();
  buffer.set("/co and more");
  buffer.cursor = 3;
  const menu = new CompletionMenu(buffer, commands);
  menu.tab(false);
  assert.equal(menu.isOpen, true);
  menu.tab(false);
  assert.equal(buffer.value, "/compact  and more");
});

test("open with no matches does nothing", () => {
  const { buffer, menu } = setup("/zzz");
  menu.tab(false);
  assert.equal(menu.isOpen, false);
  assert.equal(buffer.value, "/zzz");
});