import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.ts";
import type { Ui } from "../src/ui/ui.ts";

function fakeUi(answers: Array<string | undefined>): Ui & { items: string[] } {
  const queue = [...answers];
  const items: string[] = [];
  return {
    items,
    async ask() {
      const next = queue.shift();
      return next === undefined ? { type: "cancel" } : { type: "value", value: next };
    },
    addItem(_kind, text) {
      items.push(text);
    },
    setLive() {},
    setBusy() {},
    updateStatus() {},
    clear() {},
    onInterrupt() {},
    async dispose() {},
  };
}

async function modelsApi(models = ["m1", "m2"]) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: req.url === "/v1/models" ? models.map((id) => ({ id })) : [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "harness-init-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "demo-app",
      scripts: { test: "node --test", build: "tsc", typecheck: "tsc --noEmit" },
      packageManager: "pnpm@10.0.0",
    }),
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("init writes harness.json, AGENTS.md and .gitignore", async () => {
  const api = await modelsApi();
  const box = await project();
  try {
    // provider, base URL, model (default), mode
    const ui = fakeUi(["local", api.url, "", "plan"]);
    const ok = await runInit({ cwd: box.dir, ui });

    assert.equal(ok, true);
    const config = JSON.parse(await readFile(join(box.dir, "harness.json"), "utf8")) as {
      provider: string;
      mode: string;
      providers: Record<string, { baseUrl: string; model: string }>;
    };
    assert.equal(config.provider, "local");
    assert.equal(config.mode, "plan");
    assert.equal(config.providers.local?.baseUrl, api.url);
    assert.equal(config.providers.local?.model, "m1");

    const agents = await readFile(join(box.dir, "AGENTS.md"), "utf8");
    assert.match(agents, /# demo-app/);
    assert.match(agents, /test: `pnpm run test`/);
    assert.match(agents, /typecheck: `pnpm run typecheck`/);

    assert.match(await readFile(join(box.dir, ".gitignore"), "utf8"), /^\.harness\/$/m);
  } finally {
    await api.close();
    await box.cleanup();
  }
});

test("init keeps an existing AGENTS.md and does not duplicate .gitignore", async () => {
  const api = await modelsApi();
  const box = await project();
  try {
    await writeFile(join(box.dir, "AGENTS.md"), "my own rules\n");
    await writeFile(join(box.dir, ".gitignore"), "node_modules/\n.harness/\n");

    const ui = fakeUi(["local", api.url, "", "default"]);
    assert.equal(await runInit({ cwd: box.dir, ui }), true);

    assert.equal(await readFile(join(box.dir, "AGENTS.md"), "utf8"), "my own rules\n");
    const ignore = await readFile(join(box.dir, ".gitignore"), "utf8");
    assert.equal(ignore.split("\n").filter((line) => line.trim() === ".harness/").length, 1);
  } finally {
    await api.close();
    await box.cleanup();
  }
});

test("init cancelled at the provider prompt writes nothing", async () => {
  const box = await project();
  try {
    const ui = fakeUi([undefined]);
    assert.equal(await runInit({ cwd: box.dir, ui }), false);
    const config = await readFile(join(box.dir, "harness.json"), "utf8").catch(() => undefined);
    assert.equal(config, undefined);
    const agents = await readFile(join(box.dir, "AGENTS.md"), "utf8").catch(() => undefined);
    assert.equal(agents, undefined);
  } finally {
    await box.cleanup();
  }
});
