import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptBuffer } from "../src/ui/buffer.ts";
import { CompletionMenu } from "../src/ui/completion.ts";
import { createListCompleter } from "../src/ui/commands.ts";
import {
  ollamaCapabilities,
  ollamaCapabilitiesMany,
  ollamaRoot,
  RECOMMENDED_MODELS,
} from "../src/provider/ollama.ts";

test("ollamaRoot strips only a /v1 suffix", () => {
  assert.equal(ollamaRoot("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
  assert.equal(ollamaRoot("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(ollamaRoot("https://api.openai.com/v1"), "https://api.openai.com");
  assert.equal(ollamaRoot("https://llm.example.com/custom/v1"), undefined);
  assert.equal(ollamaRoot("not a url"), undefined);
});

async function ollamaStub(handler: (body: { model?: string }) => { status: number; capabilities?: string[] }) {
  const requests: Array<{ model?: string }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: string };
      requests.push(body);
      const out = handler(body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ capabilities: out.capabilities ?? [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("capabilities are read from native /api/show", async () => {
  const s = await ollamaStub(() => ({ status: 200, capabilities: ["completion", "tools"] }));
  try {
    const caps = await ollamaCapabilities({ baseUrl: s.url, model: "qwen3:4b" });
    assert.deepEqual(caps, { tools: true, vision: false, thinking: false });
    assert.equal(s.requests[0]!.model, "qwen3:4b");
  } finally {
    await s.close();
  }
});

test("a missing model yields undefined, not an error", async () => {
  const s = await ollamaStub(() => ({ status: 404 }));
  try {
    assert.equal(await ollamaCapabilities({ baseUrl: s.url, model: "nope" }), undefined);
  } finally {
    await s.close();
  }
});

test("non-Ollama URLs are never queried", async () => {
  const s = await ollamaStub(() => ({ status: 200, capabilities: ["tools"] }));
  try {
    const caps = await ollamaCapabilities({ baseUrl: "https://api.openai.com/v1/", model: "m" });
    assert.equal(caps, undefined);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test("capabilities for many models are fetched concurrently and capped", async () => {
  const s = await ollamaStub((body) => ({
    status: 200,
    capabilities: body.model === "gemma" ? ["completion", "vision"] : ["completion", "tools"],
  }));
  try {
    const map = await ollamaCapabilitiesMany({
      baseUrl: s.url,
      models: ["qwen", "gemma", "llama"],
    });
    assert.equal(map.get("qwen")?.tools, true);
    assert.equal(map.get("gemma")?.tools, false);
    assert.equal(map.get("llama")?.tools, true);

    await ollamaCapabilitiesMany({
      baseUrl: s.url,
      models: Array.from({ length: 50 }, (_, i) => `m${i}`),
      limit: 10,
    });
    assert.equal(s.requests.length, 3 + 10, "the cap limits lookups");
  } finally {
    await s.close();
  }
});

test("recommended models are ordered by size and all claim tools", () => {
  assert.ok(RECOMMENDED_MODELS.length >= 3);
  assert.equal(RECOMMENDED_MODELS[0]!.model, "qwen3:0.6b");
  for (const entry of RECOMMENDED_MODELS) {
    assert.match(entry.size, /MB|GB/);
    assert.ok(entry.note.length > 0);
  }
});

test("the model completer marks tool support and keeps unknown endpoints quiet", () => {
  const support = new Map([["gemma", false], ["qwen", true]]);
  const completer = createListCompleter(
    () => ["gemma", "qwen", "other"],
    (model) => (support.has(model) ? (support.get(model) ? "tools" : "no tools") : undefined),
  );
  const items = completer.complete("", 0);
  assert.equal(items.find((i) => i.value === "gemma")?.hint, "no tools");
  assert.equal(items.find((i) => i.value === "qwen")?.hint, "tools");
  assert.equal(items.find((i) => i.value === "other")?.hint, undefined);
});

test("an empty model list does not break the picker", () => {
  const completer = createListCompleter(() => []);
  assert.deepEqual(completer.complete("qwen", 4), []);
});

test("the menu shows the no-tools hint next to a model", () => {
  const buffer = new PromptBuffer();
  const menu = new CompletionMenu(
    buffer,
    createListCompleter(() => ["gemma", "qwen"], (m) => (m === "gemma" ? "no tools" : "tools")),
  );
  menu.tab(false);
  assert.equal(menu.isOpen, true);
  assert.equal(menu.items[0]!.hint, "no tools");
});

test("a tool call written as text is recognised", async () => {
  const { looksLikeToolCallText } = await import("../src/provider/ollama.ts");
  assert.equal(
    looksLikeToolCallText('{"name": "bash", "arguments": {"command": "echo hallo"}}'),
    true,
  );
  assert.equal(
    looksLikeToolCallText('```json\n{"name": "bash", "arguments": {}}\n```'),
    true,
  );
  assert.equal(looksLikeToolCallText("I will run bash now."), false);
  assert.equal(looksLikeToolCallText('{"name": "bash"}'), false);
  assert.equal(looksLikeToolCallText('{"arguments": {}}'), false);
  assert.equal(looksLikeToolCallText("use {\"arguments\": 1} in prose"), false);
});

test("models whose tools only exist in the name are flagged in the picker", async () => {
  const { TOOLS_IN_NAME_ONLY } = await import("../src/provider/ollama.ts");
  const completer = createListCompleter(
    () => ["qwen2.5-coder:1.5b", "qwen3:0.6b"],
    (model) => (TOOLS_IN_NAME_ONLY.includes(model) ? "tool calls as text" : "tools"),
  );
  const items = completer.complete("", 0);
  assert.equal(items[0]!.hint, "tool calls as text");
  assert.equal(items[1]!.hint, "tools");
});
