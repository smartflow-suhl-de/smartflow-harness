import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type ConnectIO } from "../src/ui/connect.ts";
import { loadConfig } from "../src/config/config.ts";
import { loadCredentials } from "../src/config/credentials.ts";
import { probeProvider } from "../src/provider/probe.ts";

/** Scripted terminal: answers in order, records everything written. */
function fakeIO(answers: string[]): ConnectIO & { output: string[]; prompts: string[] } {
  const queue = [...answers];
  const output: string[] = [];
  const prompts: string[] = [];
  return {
    output,
    prompts,
    async question(prompt: string) {
      prompts.push(prompt);
      return queue.shift();
    },
    async secret(prompt: string) {
      prompts.push(prompt);
      return queue.shift();
    },
    write(text: string) {
      output.push(text);
    },
  };
}

async function fakeApi(opts: { models?: string[]; requireKey?: string; status?: number }) {
  const requests: Array<{ url?: string; auth?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      if (opts.status) {
        res.writeHead(opts.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "denied" }));
        return;
      }
      if (opts.requireKey && req.headers.authorization !== `Bearer ${opts.requireKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad key" }));
        return;
      }
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: (opts.models ?? ["qwen3-coder"]).map((id) => ({ id })) }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
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

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harness-connect-"));
  const home = join(dir, "home");
  return {
    dir,
    env: { HARNESS_HOME: home } as NodeJS.ProcessEnv,
    home,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("connect to a local endpoint needs no key and persists the profile", async () => {
  const api = await fakeApi({ models: ["qwen3-coder", "llama-3.3"] });
  const box = await sandbox();
  try {
    const config = await loadConfig(box.dir, { env: box.env });
    const io = fakeIO([""]); // accept default model

    const ok = await connect({ config, cwd: box.dir, io, args: [api.url, "local"], env: box.env });
    assert.equal(ok, true);

    const saved = JSON.parse(await readFile(join(box.home, "harness.json"), "utf8")) as {
      provider: string;
      providers: Record<string, { baseUrl: string; model: string; apiKeyEnv?: string }>;
    };
    assert.equal(saved.provider, "local");
    assert.equal(saved.providers.local!.baseUrl, api.url);
    assert.equal(saved.providers.local!.model, "qwen3-coder");
    assert.equal(saved.providers.local!.apiKeyEnv, undefined, "local providers store no key env");
    assert.ok(io.output.some((line) => /connected: local · qwen3-coder/.test(line)));
  } finally {
    await api.close();
    await box.cleanup();
  }
});

test("connect collects a key for a remote endpoint and stores it with 0600", async () => {
  const api = await fakeApi({ models: ["gpt-4.1-mini"], requireKey: "sk-live" });
  const box = await sandbox();
  try {
    const config = await loadConfig(box.dir, { env: box.env });
    const io = fakeIO(["sk-live"]);

    const ok = await connect({ config, cwd: box.dir, io, args: [api.url, "gateway"], env: box.env });
    assert.equal(ok, true);

    const creds = await loadCredentials(box.env);
    assert.equal(creds.providers.gateway?.apiKey, "sk-live");

    const saved = JSON.parse(await readFile(join(box.home, "harness.json"), "utf8")) as {
      providers: Record<string, { apiKeyEnv?: string }>;
    };
    assert.equal(saved.providers.gateway?.apiKeyEnv, "GATEWAY_API_KEY");
    // 127.0.0.1 is "local", so the first probe is key-less and gets a 401;
    // the key is then requested and the retry carries it.
    assert.ok(api.requests.some((r) => r.auth === "Bearer sk-live"));

    // A fresh load must now be connected without any env key.
    const reloaded = await loadConfig(box.dir, { env: box.env, credentials: (await loadCredentials(box.env)).providers });
    assert.equal(reloaded.provider.apiKey, "sk-live");
    assert.equal(reloaded.provider.keySource, "stored");
  } finally {
    await api.close();
    await box.cleanup();
  }
});

test("connect aborts cleanly when the user declines after a failed probe", async () => {
  const box = await sandbox();
  try {
    const config = await loadConfig(box.dir, { env: box.env });
    const io = fakeIO(["", "n"]); // model id left empty, decline saving

    const ok = await connect({
      config,
      cwd: box.dir,
      io,
      args: ["http://127.0.0.1:9/v1", "dead"],
      env: box.env,
    });
    assert.equal(ok, false);
    const saved = await readFile(join(box.home, "harness.json"), "utf8").catch(() => undefined);
    assert.equal(saved, undefined);
  } finally {
    await box.cleanup();
  }
});

test("connect reuses a stored key when the user agrees", async () => {
  const api = await fakeApi({ models: ["m"], requireKey: "sk-saved" });
  const box = await sandbox();
  try {
    await import("../src/config/credentials.ts").then((m) => m.saveCredential("gateway", "sk-saved", box.env));
    const config = await loadConfig(box.dir, { env: box.env });
    const io = fakeIO(["y", ""]); // reuse stored key, accept default model

    const ok = await connect({ config, cwd: box.dir, io, args: [api.url, "gateway"], env: box.env });
    assert.equal(ok, true);
    assert.ok(api.requests.some((r) => r.auth === "Bearer sk-saved"));
  } finally {
    await api.close();
    await box.cleanup();
  }
});

test("probe is reachable for a dead endpoint without throwing", async () => {
  const result = await probeProvider(
    { name: "dead", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: "" },
    400,
  );
  assert.equal(result.ok, false);
});

test("ctrl+c at the provider prompt cancels without throwing", async () => {
  const box = await sandbox();
  try {
    const config = await loadConfig(box.dir, { env: box.env });
    // First question (which provider) is cancelled.
    const io = fakeIO([undefined as unknown as string]);

    const ok = await connect({ config, cwd: box.dir, io, args: [], env: box.env });
    assert.equal(ok, false);
    const saved = await readFile(join(box.home, "harness.json"), "utf8").catch(() => undefined);
    assert.equal(saved, undefined, "nothing written after a cancel");
  } finally {
    await box.cleanup();
  }
});

test("ctrl+c at the key prompt cancels without throwing", async () => {
  const api = await fakeApi({ models: ["m"], requireKey: "sk" });
  const box = await sandbox();
  try {
    const config = await loadConfig(box.dir, { env: box.env });
    const io = fakeIO([undefined as unknown as string]); // key prompt cancelled

    const ok = await connect({ config, cwd: box.dir, io, args: [api.url, "gateway"], env: box.env });
    assert.equal(ok, false);
    const creds = await loadCredentials(box.env);
    assert.equal(creds.providers.gateway, undefined);
  } finally {
    await api.close();
    await box.cleanup();
  }
});
