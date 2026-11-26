import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/core/loop.ts";
import { Session } from "../src/core/session.ts";
import { estimateTokens } from "../src/context/compact.ts";
import type { Provider, CompleteRequest } from "../src/provider/provider.ts";
import type { AgentEvent, ProviderTurn } from "../src/core/types.ts";
import { PermissionEngine } from "../src/safety/permissions.ts";
import { createToolRegistry } from "../src/tools/index.ts";

/** Scripted provider: replays turns and records what it was asked. */
class FakeProvider implements Provider {
  readonly name = "fake";
  readonly model = "fake-1";
  contextWindow = 128_000;
  toolsDisabled = false;
  readonly calls: CompleteRequest[] = [];
  private readonly script: ProviderTurn[];

  constructor(script: ProviderTurn[]) {
    this.script = [...script];
  }

  async complete(req: CompleteRequest): Promise<ProviderTurn> {
    this.calls.push(req);
    return this.script.shift() ?? { text: "done", toolCalls: [], stopReason: "stop" };
  }

  disableTools(): void {
    this.toolsDisabled = true;
  }
}

test("loop executes a tool call and stops on plain text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    await writeFile(join(dir, "hello.txt"), "line one\nline two\n");
    const session = await Session.create({ cwd: dir });
    await session.append({ role: "user", content: "read hello.txt" });

    const provider = new FakeProvider([
      {
        text: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "read", args: { path: "hello.txt" }, rawArgs: '{"path":"hello.txt"}' }],
      },
      { text: "It has two lines.", toolCalls: [], stopReason: "stop" },
    ]);

    const events: AgentEvent[] = [];
    const result = await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "default", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      compact: false,
      maxSteps: 5,
    });

    assert.equal(result.reason, "stop");
    const toolMessage = session.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage);
    assert.match(toolMessage!.content, /line one/);
    assert.ok(events.some((e) => e.type === "tool_start" && e.name === "read"));
    assert.ok(events.some((e) => e.type === "done" && e.reason === "stop"));

    // The second provider call must contain the tool result.
    assert.equal(provider.calls.length, 2);
    const second = provider.calls[1]!.messages;
    assert.ok(second.some((m) => m.role === "tool"));
    assert.equal(second[0]!.role, "system");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop denies mutating tools in plan mode without asking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plan-"));
  try {
    const session = await Session.create({ cwd: dir });
    await session.append({ role: "user", content: "write a file" });
    const provider = new FakeProvider([
      {
        text: "",
        stopReason: "tool_calls",
        toolCalls: [
          { id: "c1", name: "write", args: { path: "a.txt", content: "x" }, rawArgs: "{}" },
        ],
      },
      { text: "cannot", toolCalls: [], stopReason: "stop" },
    ]);

    await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "plan", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      compact: false,
      maxSteps: 4,
    });

    const toolMessage = session.messages.find((m) => m.role === "tool");
    assert.match(toolMessage!.content, /denied/i);
    // Plan mode filters tool specs down to read-only tools.
    assert.equal(provider.calls[0]!.tools.some((t) => t.name === "write"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stuck detection stops after repeated identical calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-stuck-"));
  try {
    const session = await Session.create({ cwd: dir });
    await session.append({ role: "user", content: "loop" });
    const same: ProviderTurn = {
      text: "",
      stopReason: "tool_calls",
      toolCalls: [{ id: "c", name: "glob", args: { pattern: "*.ts" }, rawArgs: '{"pattern":"*.ts"}' }],
    };
    const provider = new FakeProvider([same, same, same, same, same]);

    const result = await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "yolo", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      compact: false,
      maxSteps: 10,
    });

    assert.equal(result.reason, "stuck");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction keeps recent messages and stores a summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-compact-"));
  try {
    const session = await Session.create({ cwd: dir });
    for (let i = 0; i < 20; i++) {
      await session.append({ role: "user", content: `message ${i} ${"pad ".repeat(200)}` });
      await session.append({ role: "assistant", content: `answer ${i}` });
    }
    assert.ok(estimateTokens(session.messages) > 500);

    const provider = new FakeProvider([
      { text: "GOAL: test\nDECISIONS: none", toolCalls: [], stopReason: "stop" },
      { text: "final", toolCalls: [], stopReason: "stop" },
    ]);
    provider.contextWindow = 1000;

    await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "default", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      compact: true,
      maxSteps: 2,
    });

    const summary = session.messages.find(
      (m) => m.role === "system" && m.content.startsWith("[compaction summary]"),
    );
    assert.ok(summary, "expected a compaction summary message");
    assert.match(summary!.content, /GOAL: test/);
    assert.ok(session.messages.length < 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tool call written as text turns into a chat-only retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-textcall-"));
  try {
    const session = await Session.create({ cwd: dir });
    await session.append({ role: "user", content: "hallo" });

    const provider = new FakeProvider([
      {
        text: '{"name": "read", "arguments": {"path": "AGENTS.md"}}',
        toolCalls: [],
        stopReason: "stop",
      },
      { text: "Hallo! Wie geht es dir?", toolCalls: [], stopReason: "stop" },
    ]);

    const events: AgentEvent[] = [];
    const result = await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "default", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      compact: false,
      maxSteps: 3,
    });

    assert.equal(result.reason, "stop");
    assert.equal(provider.toolsDisabled, true, "tools are dropped for later turns");
    assert.equal(provider.calls.length, 2, "the turn is retried");
    assert.ok(events.some((event) => event.type === "notice"));
    assert.deepEqual(session.messages.at(-1), {
      role: "assistant",
      content: "Hallo! Wie geht es dir?",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plain text answers are not mistaken for tool calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plain-"));
  try {
    const session = await Session.create({ cwd: dir });
    await session.append({ role: "user", content: "hallo" });
    const provider = new FakeProvider([
      { text: "Hallo! Ich helfe gern.", toolCalls: [], stopReason: "stop" },
    ]);

    await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "default", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      compact: false,
      maxSteps: 3,
    });

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.toolsDisabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("denied tool calls are recorded in the audit log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-deny-"));
  try {
    const session = await Session.create({ cwd: dir });
    await session.append({ role: "user", content: "rm something" });
    const provider = new FakeProvider([
      {
        text: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "x", name: "bash", args: { command: "rm -rf /" }, rawArgs: '{"command":"rm -rf /"}' }],
      },
    ]);

    const { AuditLog } = await import("../src/safety/audit.ts");
    const { readFile } = await import("node:fs/promises");
    const auditPath = join(dir, "audit.jsonl");
    const audit = new AuditLog({ path: auditPath });

    await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "yolo", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      compact: false,
      maxSteps: 2,
      audit,
    });
    await audit.flush();

    const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l!));
    const denied = lines.find((l) => l.decision === "deny");
    assert.ok(denied, "a denied call must appear in the audit log");
    assert.equal(denied.tool, "bash");
    assert.equal(denied.ok, false);
    assert.ok(!JSON.stringify(lines).includes("rm -rf /"), "arguments are hashed, not stored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("declined tool calls are recorded in the audit log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-declined-"));
  try {
    const session = await Session.create({ cwd: dir });
    await session.append({ role: "user", content: "write outside" });
    const provider = new FakeProvider([
      {
        text: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "y", name: "write", args: { path: "/etc/x", content: "z" }, rawArgs: "{}" }],
      },
    ]);
    const { AuditLog } = await import("../src/safety/audit.ts");
    const { readFile } = await import("node:fs/promises");
    const auditPath = join(dir, "audit.jsonl");
    const audit = new AuditLog({ path: auditPath });

    await runAgent({
      session,
      provider,
      tools: createToolRegistry(),
      permissions: new PermissionEngine({ mode: "default", cwd: dir }),
      systemPrompt: "test",
      cwd: dir,
      signal: new AbortController().signal,
      compact: false,
      maxSteps: 2,
      audit,
      ask: async () => false,
    });
    await audit.flush();

    const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l!));
    assert.ok(lines.some((l) => l.decision === "declined"), "a declined call must appear in the audit log");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
