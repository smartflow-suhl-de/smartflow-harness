import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAiCompatibleProvider } from "../src/provider/openai.ts";

async function api(handler: (body: Record<string, unknown>) => { status: number; body: string }) {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push(parsed);
      const out = handler(parsed);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
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

const tool = {
  name: "bash",
  description: "run",
  readOnly: false,
  parameters: { type: "object" as const, properties: {}, required: [] },
};

test("retries without tools when the model rejects them, and says so once", async () => {
  const s = await api((body) =>
    Array.isArray(body.tools)
      ? { status: 400, body: JSON.stringify({ error: { message: "does not support tools" } }) }
      : {
          status: 200,
          body: JSON.stringify({
            choices: [{ message: { role: "assistant", content: "hallo" }, finish_reason: "stop" }],
          }),
        },
  );
  try {
    const notices: string[] = [];
    const provider = new OpenAiCompatibleProvider({
      model: "gemma",
      baseUrl: s.url,
      onNotice: (message) => notices.push(message),
    });

    const turn = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
      signal: new AbortController().signal,
    });

    assert.equal(turn.text, "hallo");
    assert.equal(s.requests.length, 2);
    assert.ok(Array.isArray(s.requests[0]!.tools), "first attempt offers tools");
    assert.equal(s.requests[1]!.tools, undefined, "retry sends no tools");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /does not support tool calls/);

    // A second turn must not try tools again.
    await provider.complete({
      messages: [{ role: "user", content: "again" }],
      tools: [tool],
      signal: new AbortController().signal,
    });
    assert.equal(s.requests.length, 3);
    assert.equal(s.requests[2]!.tools, undefined);
    assert.equal(notices.length, 1, "the notice is not repeated");
  } finally {
    await s.close();
  }
});

test("other 400 errors are not retried as a tool fallback", async () => {
  const s = await api(() => ({ status: 400, body: JSON.stringify({ error: { message: "bad request" } }) }));
  try {
    const notices: string[] = [];
    const provider = new OpenAiCompatibleProvider({
      model: "m",
      baseUrl: s.url,
      maxRetries: 0,
      onNotice: (message) => notices.push(message),
    });
    await assert.rejects(() =>
      provider.complete({
        messages: [{ role: "user", content: "hi" }],
        tools: [tool],
        signal: new AbortController().signal,
      }),
    );
    assert.equal(notices.length, 0);
  } finally {
    await s.close();
  }
});

test("a 404 model error carries status, body and model", async () => {
  const s = await api(() => ({
    status: 404,
    body: JSON.stringify({ error: { message: "model 'nope' not found" } }),
  }));
  try {
    const provider = new OpenAiCompatibleProvider({ model: "nope", baseUrl: s.url, maxRetries: 0 });
    await assert.rejects(
      () =>
        provider.complete({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      (err: unknown) => {
        const e = err as { status?: number; model?: string; body?: string };
        assert.equal(e.status, 404);
        assert.equal(e.model, "nope");
        assert.match(e.body ?? "", /not found/);
        return true;
      },
    );
  } finally {
    await s.close();
  }
});
test("disableTools omits tools from the first request", async () => {
  const s = await api(() => ({
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { role: "assistant", content: "hallo" }, finish_reason: "stop" }],
    }),
  }));
  try {
    const provider = new OpenAiCompatibleProvider({ model: "m", baseUrl: s.url, disableTools: true });
    await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
      signal: new AbortController().signal,
    });
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0]!.tools, undefined);
    assert.equal(s.requests[0]!.tool_choice, undefined);
  } finally {
    await s.close();
  }
});

test("disableTools() also applies to the next request", async () => {
  const s = await api(() => ({
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
  }));
  try {
    const provider = new OpenAiCompatibleProvider({ model: "m", baseUrl: s.url });
    await provider.complete({ messages: [{ role: "user", content: "a" }], tools: [tool], signal: new AbortController().signal });
    assert.ok(Array.isArray(s.requests[0]!.tools));
    provider.disableTools();
    await provider.complete({ messages: [{ role: "user", content: "b" }], tools: [tool], signal: new AbortController().signal });
    assert.equal(s.requests[1]!.tools, undefined);
  } finally {
    await s.close();
  }
});
