import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { ConfigError, isLocalUrl, listProviders, resolveProvider } from "../src/config/providers.ts";

test("built-in profile resolves with its own env var", () => {
  const p = resolveProvider({
    env: { OPENROUTER_API_KEY: "sk-or" } as NodeJS.ProcessEnv,
    providerName: "openrouter",
  });
  assert.equal(p.name, "openrouter");
  assert.equal(p.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(p.apiKey, "sk-or");
  assert.equal(p.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(p.builtin, true);
});

test("custom provider from harness.json with apiKeyEnv", () => {
  const p = resolveProvider({
    file: {
      providers: {
        gateway: {
          baseUrl: "https://llm.example.com/v1",
          model: "qwen3-coder",
          apiKeyEnv: "GATEWAY_KEY",
          contextWindow: 65536,
          headers: { "X-Org": "cabroe" },
        },
      },
    },
    env: { GATEWAY_KEY: "gw-secret" } as NodeJS.ProcessEnv,
    providerName: "gateway",
  });
  assert.equal(p.baseUrl, "https://llm.example.com/v1");
  assert.equal(p.model, "qwen3-coder");
  assert.equal(p.apiKey, "gw-secret");
  assert.equal(p.contextWindow, 65536);
  assert.deepEqual(p.headers, { "X-Org": "cabroe" });
  assert.equal(p.builtin, false);
});

test("config profile overrides a built-in preset field by field", () => {
  const p = resolveProvider({
    file: { providers: { openrouter: { model: "openai/gpt-5" } } },
    env: {} as NodeJS.ProcessEnv,
    providerName: "openrouter",
  });
  assert.equal(p.model, "openai/gpt-5");
  assert.equal(p.baseUrl, "https://openrouter.ai/api/v1", "preset baseUrl survives");
});

test("env overrides beat the profile", () => {
  const p = resolveProvider({
    file: { providers: { gateway: { baseUrl: "https://a/v1", model: "m1", apiKeyEnv: "K" } } },
    env: { HARNESS_MODEL: "m2", HARNESS_BASE_URL: "https://b/v1", HARNESS_API_KEY: "envkey" } as NodeJS.ProcessEnv,
    providerName: "gateway",
  });
  assert.equal(p.model, "m2");
  assert.equal(p.baseUrl, "https://b/v1");
  assert.equal(p.apiKey, "envkey");
});

test("default provider is openai", () => {
  const p = resolveProvider({ env: {} as NodeJS.ProcessEnv });
  assert.equal(p.name, "openai");
});

test("HARNESS_PROVIDER selects a profile", () => {
  const p = resolveProvider({
    file: { providers: { local: { baseUrl: "http://127.0.0.1:8080/v1", model: "m" } } },
    env: { HARNESS_PROVIDER: "local" } as NodeJS.ProcessEnv,
  });
  assert.equal(p.name, "local");
});

test("unknown provider fails with the available names", () => {
  assert.throws(
    () => resolveProvider({ env: {} as NodeJS.ProcessEnv, providerName: "nope" }),
    (err: unknown) => err instanceof ConfigError && /Unknown provider "nope"/.test(err.message),
  );
});

test("legacy flat model/baseUrl still work for the default provider", () => {
  const p = resolveProvider({
    file: { baseUrl: "https://legacy/v1", model: "old-model" },
    env: {} as NodeJS.ProcessEnv,
  });
  assert.equal(p.baseUrl, "https://legacy/v1");
  assert.equal(p.model, "old-model");
});

test("a profile without baseUrl is a clear error", () => {
  assert.throws(
    () => resolveProvider({ file: { providers: { broken: { model: "x" } } }, env: {}, providerName: "broken" }),
    (err: unknown) => err instanceof ConfigError && /no baseUrl/.test(err.message),
  );
});

test("listProviders merges built-ins and config entries", () => {
  const list = listProviders({ providers: { gateway: { baseUrl: "https://x/v1" } } });
  const names = list.map((p) => p.name);
  assert.ok(names.includes("openai"));
  assert.ok(names.includes("gateway"));
  assert.equal(list.find((p) => p.name === "gateway")!.origin, "config");
  assert.equal(list.find((p) => p.name === "groq")!.origin, "builtin");
});

test("isLocalUrl detects loopback only", () => {
  assert.equal(isLocalUrl("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLocalUrl("http://localhost:11434/v1"), true);
  assert.equal(isLocalUrl("http://[::1]:8080/v1"), true);
  assert.equal(isLocalUrl("https://api.openai.com/v1"), false);
  assert.equal(isLocalUrl("https://localhost.evil.com/v1"), false);
});

test("loadConfig merges user and project files, project wins", async () => {
  const userDir = await mkdtemp(join(tmpdir(), "h-user-"));
  const projectDir = await mkdtemp(join(tmpdir(), "h-proj-"));
  try {
    const home = join(userDir, ".config", "harness");
    await import("node:fs/promises").then((fs) => fs.mkdir(home, { recursive: true }));
    await writeFile(
      join(home, "harness.json"),
      JSON.stringify({
        providers: { shared: { baseUrl: "https://user/v1", model: "user-model" } },
        mode: "plan",
      }),
    );
    await writeFile(
      join(projectDir, "harness.json"),
      JSON.stringify({
        provider: "shared",
        providers: { shared: { model: "project-model", apiKeyEnv: "SHARED_KEY" } },
        maxSteps: 5,
      }),
    );

    // Point HOME at the fake user dir for this test.
    const originalHome = process.env.HOME;
    process.env.HOME = userDir;
    try {
      const config = await loadConfig(projectDir, { env: { SHARED_KEY: "k" } as NodeJS.ProcessEnv });
      assert.equal(config.provider.name, "shared");
      assert.equal(config.provider.baseUrl, "https://user/v1", "user baseUrl survives");
      assert.equal(config.provider.model, "project-model", "project profile wins");
      assert.equal(config.provider.apiKey, "k");
      assert.equal(config.mode, "plan", "user-level mode applies");
      assert.equal(config.maxSteps, 5, "project-level maxSteps applies");
      assert.equal(config.sources.length, 2);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  } finally {
    await rm(userDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("saveProviderModel writes to the project file when it defines the profile", async () => {
  const { mkdtemp, readFile, rm, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const { saveProviderModel } = await import("../src/config/config.ts");

  const dir = await mkdtemp(j(tmpdir(), "h-save-"));
  try {
    const home = j(dir, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      j(dir, "harness.json"),
      JSON.stringify({ providers: { ollama: { baseUrl: "http://x/v1", model: "old" } } }),
    );

    const path = await saveProviderModel("ollama", "new", dir, { HARNESS_HOME: home } as NodeJS.ProcessEnv);
    assert.equal(path, j(dir, "harness.json"));
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, { model: string; baseUrl?: string }>;
    };
    assert.equal(saved.providers.ollama?.model, "new");
    assert.equal(saved.providers.ollama?.baseUrl, "http://x/v1", "other fields are preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveProviderModel falls back to the user file", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const { saveProviderModel } = await import("../src/config/config.ts");

  const dir = await mkdtemp(j(tmpdir(), "h-save2-"));
  try {
    const home = j(dir, "home");
    const path = await saveProviderModel("openrouter", "new-model", dir, {
      HARNESS_HOME: home,
    } as NodeJS.ProcessEnv);
    assert.equal(path, j(home, "harness.json"));
    const saved = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, { model: string }> };
    assert.equal(saved.providers.openrouter?.model, "new-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
