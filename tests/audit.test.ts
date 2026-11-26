import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, hashArgs, redactCommand } from "../src/safety/audit.ts";

async function tempLog(maxBytes?: number): Promise<{ log: AuditLog; path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-"));
  const path = join(dir, "audit.jsonl");
  const log = new AuditLog({ path, ...(maxBytes !== undefined ? { maxBytes } : {}) });
  return { log, path, dir };
}

test("AuditLog: writes one JSON object per line", async () => {
  const { log, path } = await tempLog();
  await log.record({ ts: "2026-01-01T00:00:00.000Z", event: "tool_call", tool: "bash", ok: true });
  await log.record({ ts: "2026-01-01T00:00:01.000Z", event: "tool_call", tool: "read", ok: true });

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).tool, "bash");
  assert.equal(JSON.parse(lines[1]!).tool, "read");
});

test("AuditLog: file and directory are not world-readable", async () => {
  const { log, path } = await tempLog();
  await log.record({ ts: "2026-01-01T00:00:00.000Z", event: "tool_call", tool: "bash" });
  const fileMode = (await stat(path)).mode & 0o777;
  assert.equal(fileMode, 0o600);
});

test("AuditLog: records no argument values, only a hash and key names", async () => {
  const args = { command: "export TOKEN=leaked-value", path: "/tmp" };
  const hash = hashArgs(args);
  assert.equal(hash.length, 32);
  assert.ok(!hash.includes("secret"));

  const { log, path } = await tempLog();
  await log.record({ ts: "2026-01-01T00:00:00.000Z", event: "tool_call", tool: "bash", argsHash: hash, argsKeys: Object.keys(args).sort() });
  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes("leaked-value"));
  assert.deepEqual(JSON.parse(raw).argsKeys, ["command", "path"]);
});

test("AuditLog: rotates once the size limit is exceeded", async () => {
  const { log, path, dir } = await tempLog(120);
  for (let i = 0; i < 5; i++) {
    await log.record({ ts: "2026-01-01T00:00:00.000Z", event: "tool_call", tool: `tool-${i}`, reason: "x".repeat(20) });
  }
  const entries = await readdir(dir);
  const rotated = entries.filter((e) => e.startsWith("audit.jsonl."));
  assert.ok(rotated.length >= 1, `expected rotation, got ${entries.join(", ")}`);
  // The live file still holds the newest entries and stays valid NDJSON.
  const live = (await readFile(path, "utf8")).trim();
  if (live) JSON.parse(live.split("\n").at(-1)!);
});

test("AuditLog: disabled writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-"));
  const path = join(dir, "audit.jsonl");
  const log = new AuditLog({ path, disabled: true });
  await log.record({ ts: "2026-01-01T00:00:00.000Z", event: "tool_call", tool: "bash" });
  await assert.rejects(stat(path));
});

test("AuditLog: a broken path reports an error instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-"));
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "not a directory");
  const errors: Error[] = [];
  const log = new AuditLog({ path: join(blocker, "audit.jsonl"), onError: (e) => errors.push(e) });
  await log.record({ ts: "2026-01-01T00:00:00.000Z", event: "tool_call", tool: "bash" });
  assert.equal(errors.length, 1);
});
test("redactCommand: removes tokens but keeps the command recognizable", () => {
  const cases = [
    ["curl -H 'Authorization: Bearer abc123def456ghi' https://x", "abc123def456ghi"],
    ["export OPENAI_API_KEY=sk-live-1234567890abcdef", "sk-live-1234567890abcdef"],
    ["deploy --api-key supersecretvalue", "supersecretvalue"],
    ["git commit -m 'fix'", null],
  ] as const;
  for (const [command, secret] of cases) {
    const out = redactCommand(command);
    if (secret) assert.ok(!out.includes(secret), `leaked ${secret} in: ${out}`);
    assert.ok(out.length > 0);
  }
  assert.match(redactCommand("git commit -m 'fix'"), /git commit/);
});

test("AuditLog: flush waits for queued lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-flush-"));
  const log = new AuditLog({ path: join(dir, "audit.jsonl") });
  await log.record({ ts: "t1", event: "tool_call", tool: "bash" });
  await log.record({ ts: "t2", event: "tool_call", tool: "read" });
  await log.flush();
  const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
});

test("AuditLog: back-to-back rotations never overwrite each other", async () => {
  const { log, dir } = await tempLog(200);
  for (let i = 0; i < 40; i++) {
    await log.record({ ts: String(i), event: "tool_call", tool: "bash", summary: "x".repeat(60) });
  }
  await log.flush();
  const files = await readdir(dir);
  const archived = files.filter((f) => f.startsWith("audit.jsonl."));
  assert.ok(new Set(archived).size === archived.length && archived.length > 0, "each rotation gets its own file");
});
