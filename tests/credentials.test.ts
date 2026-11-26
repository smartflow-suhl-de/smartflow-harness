import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteCredential,
  loadCredentials,
  saveCredential,
  credentialsPath,
} from "../src/config/credentials.ts";
import { resolveProvider } from "../src/config/providers.ts";

async function tempHome(): Promise<{ home: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "harness-home-"));
  return {
    home,
    env: { HARNESS_HOME: join(home, "cfg") } as NodeJS.ProcessEnv,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("stored credential round-trips", async () => {
  const t = await tempHome();
  try {
    await saveCredential("gateway", "sk-secret", t.env);
    const store = await loadCredentials(t.env);
    assert.equal(store.providers.gateway?.apiKey, "sk-secret");
  } finally {
    await t.cleanup();
  }
});

test("credentials file is created with mode 600", async () => {
  const t = await tempHome();
  try {
    await saveCredential("gateway", "sk-secret", t.env);
    const info = await stat(credentialsPath(t.env));
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    await t.cleanup();
  }
});

test("missing or corrupt store yields an empty object instead of throwing", async () => {
  const t = await tempHome();
  try {
    assert.deepEqual(await loadCredentials(t.env), { providers: {} });

    const path = credentialsPath(t.env);
    await import("node:fs/promises").then((fs) => fs.mkdir(join(t.home, "cfg"), { recursive: true }));
    await writeFile(path, "{not json");
    assert.deepEqual(await loadCredentials(t.env), { providers: {} });
  } finally {
    await t.cleanup();
  }
});

test("deleteCredential removes only the named entry", async () => {
  const t = await tempHome();
  try {
    await saveCredential("a", "ka", t.env);
    await saveCredential("b", "kb", t.env);
    assert.equal(await deleteCredential("a", t.env), true);
    assert.equal(await deleteCredential("a", t.env), false);
    const store = await loadCredentials(t.env);
    assert.equal(store.providers.a, undefined);
    assert.equal(store.providers.b?.apiKey, "kb");
  } finally {
    await t.cleanup();
  }
});

test("resolveProvider uses a stored key but env still wins", () => {
  const file = { providers: { gateway: { baseUrl: "https://x/v1", model: "m", apiKeyEnv: "GW_KEY" } } };

  const stored = resolveProvider({
    file,
    env: {} as NodeJS.ProcessEnv,
    providerName: "gateway",
    credentials: { gateway: { apiKey: "stored-key" } },
  });
  assert.equal(stored.apiKey, "stored-key");
  assert.equal(stored.keySource, "stored");

  const fromEnv = resolveProvider({
    file,
    env: { GW_KEY: "env-key" } as NodeJS.ProcessEnv,
    providerName: "gateway",
    credentials: { gateway: { apiKey: "stored-key" } },
  });
  assert.equal(fromEnv.apiKey, "env-key");
  assert.equal(fromEnv.keySource, "apiKeyEnv");
});

test("no key anywhere reports keySource none", () => {
  const p = resolveProvider({
    file: { providers: { gateway: { baseUrl: "https://x/v1", model: "m", apiKeyEnv: "GW_KEY" } } },
    env: {} as NodeJS.ProcessEnv,
    providerName: "gateway",
  });
  assert.equal(p.apiKey, "");
  assert.equal(p.keySource, "none");
});
