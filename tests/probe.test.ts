import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { probeProvider } from "../src/provider/probe.ts";

async function serve(
  handler: (req: { method?: string; url?: string; headers: NodeJS.Dict<string | string[]>; body: string }) => {
    status: number;
    body: string;
  },
): Promise<{ url: string; close: () => Promise<void>; requests: Array<{ url?: string; body: string }> }> {
  const requests: Array<{ url?: string; body: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, body });
      const out = handler({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("probe succeeds via /models and returns model ids", async () => {
  const s = await serve(() => ({
    status: 200,
    body: JSON.stringify({ data: [{ id: "qwen3-coder" }, { id: "llama-3.3" }] }),
  }));
  try {
    const result = await probeProvider({ name: "x", baseUrl: s.url, model: "m", apiKey: "k" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ["qwen3-coder", "llama-3.3"]);
    assert.equal(s.requests[0]!.url, "/models");
  } finally {
    await s.close();
  }
});

test("probe reports a rejected key", async () => {
  const s = await serve(() => ({ status: 401, body: "unauthorized" }));
  try {
    const result = await probeProvider({ name: "x", baseUrl: s.url, model: "m", apiKey: "bad" });
    assert.equal(result.ok, false);
    assert.match(result.message, /key rejected/);
  } finally {
    await s.close();
  }
});

test("probe falls back to a one-token completion when /models is missing", async () => {
  const s = await serve((req) =>
    req.url === "/models"
      ? { status: 404, body: "no" }
      : { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) },
  );
  try {
    const result = await probeProvider({ name: "x", baseUrl: s.url, model: "m", apiKey: "k" });
    assert.equal(result.ok, true);
    assert.equal(s.requests.length, 2);
    assert.match(s.requests[1]!.url ?? "", /chat\/completions$/);
    const body = JSON.parse(s.requests[1]!.body) as { max_tokens?: number; messages?: unknown[] };
    assert.equal(body.max_tokens, 1);
  } finally {
    await s.close();
  }
});

test("probe reports an unknown model as a clear message", async () => {
  const s = await serve((req) =>
    req.url === "/models"
      ? { status: 404, body: "no" }
      : { status: 404, body: JSON.stringify({ error: "model not found" }) },
  );
  try {
    const result = await probeProvider({ name: "x", baseUrl: s.url, model: "nope", apiKey: "k" });
    assert.equal(result.ok, false);
    assert.match(result.message, /nope.*not found/);
  } finally {
    await s.close();
  }
});

test("probe never throws on an unreachable endpoint", async () => {
  const result = await probeProvider({
    name: "dead",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "m",
    apiKey: "k",
  }, 500);
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, "string");
});
