import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { App } from "../src/ui/app.tsx";
import { UiStore } from "../src/ui/store.ts";
import { createCompleter } from "../src/ui/commands.ts";

const status = {
  provider: "test",
  model: "test-model",
  mode: "default",
  connected: true,
  inputTokens: 0,
  outputTokens: 0,
};

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const store = new UiStore(status);
  const app = render(<App store={store} />);
  return { store, app };
}

test("renders the prompt and placeholder", async () => {
  const { store, app } = setup();
  void store.ask("› ", { tone: "prompt", history: [], placeholder: "type here" });
  await wait();
  const frame = app.lastFrame() ?? "";
  assert.match(frame, /›/);
  assert.match(frame, /type here/);
  store.cancel();
  app.unmount();
});

test("typing and enter resolves the ask with the text", async () => {
  const { store, app } = setup();
  const asked = store.ask("› ", { tone: "prompt", history: [] });
  await wait();
  app.stdin.write("hello");
  await wait();
  assert.match(app.lastFrame() ?? "", /hello/);
  app.stdin.write("\r");
  assert.deepEqual(await asked, { type: "value", value: "hello" });
  app.unmount();
});

test("ctrl+c clears a non-empty line, then cancels on the next press", async () => {
  const { store, app } = setup();
  const asked = store.ask("› ", { tone: "prompt", history: [] });
  await wait();
  app.stdin.write("abc");
  await wait();
  app.stdin.write("\u0003");
  await wait();
  assert.doesNotMatch(app.lastFrame() ?? "", /abc/);
  app.stdin.write("\u0003");
  assert.deepEqual(await asked, { type: "cancel" });
  app.unmount();
});

test("ctrl+d cancels on an empty line", async () => {
  const { store, app } = setup();
  const asked = store.ask("› ", { tone: "prompt", history: [] });
  await wait();
  app.stdin.write("\u0004");
  assert.deepEqual(await asked, { type: "cancel" });
  app.unmount();
});

test("tab opens the completion menu with hints", async () => {
  const { store, app } = setup();
  void store.ask("› ", {
    tone: "prompt",
    history: [],
    completer: createCompleter({ providers: () => ["openai", "ollama"] }),
  });
  await wait();
  app.stdin.write("/co");
  await wait();
  app.stdin.write("\t");
  await wait(60);
  const frame = app.lastFrame() ?? "";
  assert.match(frame, /\/connect/);
  assert.match(frame, /\/compact/);
  store.cancel();
  app.unmount();
});

test("tab on a unique command completes it", async () => {
  const { store, app } = setup();
  const asked = store.ask("› ", {
    tone: "prompt",
    history: [],
    completer: createCompleter({ providers: () => [] }),
  });
  await wait();
  app.stdin.write("/ses");
  await wait();
  app.stdin.write("\t");
  await wait();
  app.stdin.write("\r");
  assert.deepEqual(await asked, { type: "value", value: "/session " });
  app.unmount();
});

test("masked input never renders the secret", async () => {
  const { store, app } = setup();
  const asked = store.ask("key: ", { tone: "question", history: [], mask: true });
  await wait();
  app.stdin.write("sk-secret");
  await wait();
  const frame = app.lastFrame() ?? "";
  assert.equal(frame.includes("sk-secret"), false);
  assert.match(frame, /••/);
  app.stdin.write("\r");
  assert.deepEqual(await asked, { type: "value", value: "sk-secret" });
  app.unmount();
});

test("history is recalled with the up arrow", async () => {
  const { store, app } = setup();
  const asked = store.ask("› ", { tone: "prompt", history: ["older message"] });
  await wait();
  app.stdin.write("\u001b[A");
  await wait();
  assert.match(app.lastFrame() ?? "", /older message/);
  app.stdin.write("\r");
  assert.deepEqual(await asked, { type: "value", value: "older message" });
  app.unmount();
});

test("transcript items render above the prompt", async () => {
  const { store, app } = setup();
  store.addItem("user", "fix the tests");
  store.addItem("assistant", "Done.");
  store.addItem("tool", "exit 0", { label: "bash", ok: true });
  store.addItem("error", "something failed");
  await wait(60);
  const frame = app.lastFrame() ?? "";
  assert.match(frame, /fix the tests/);
  assert.match(frame, /Done\./);
  assert.match(frame, /bash/);
  assert.match(frame, /something failed/);
  app.unmount();
});

test("busy state shows a hint and ctrl+c calls the interrupt handler", async () => {
  const { store, app } = setup();
  let interrupted = 0;
  store.onInterrupt(() => interrupted++);
  store.setBusy(true);
  await wait();
  assert.match(app.lastFrame() ?? "", /working/);
  app.stdin.write("\u0003");
  await wait();
  assert.equal(interrupted, 1);
  store.setBusy(false);
  app.unmount();
});

test("status bar shows provider, model and usage", async () => {
  const { store, app } = setup();
  store.updateStatus({ inputTokens: 120, outputTokens: 7 });
  await wait();
  const frame = app.lastFrame() ?? "";
  assert.match(frame, /test-model/);
  assert.match(frame, /↑120/);
  assert.match(frame, /↓7/);
  app.unmount();
});