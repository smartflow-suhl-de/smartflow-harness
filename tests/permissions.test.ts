import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionEngine, isInside } from "../src/safety/permissions.ts";

const cwd = "/home/user/project";

test("plan mode allows read-only, denies writes", () => {
  const engine = new PermissionEngine({ mode: "plan", cwd });
  assert.equal(engine.decide({ tool: "read", args: { path: "a.ts" }, readOnly: true }).action, "allow");
  assert.equal(engine.decide({ tool: "bash", args: { command: "ls" }, readOnly: false }).action, "deny");
});

test("default mode allows writes inside the workspace", () => {
  const engine = new PermissionEngine({ mode: "default", cwd });
  assert.equal(engine.decide({ tool: "write", args: { path: "src/a.ts" }, readOnly: false }).action, "allow");
  assert.equal(engine.decide({ tool: "write", args: { path: "/etc/passwd" }, readOnly: false }).action, "ask");
  assert.equal(engine.decide({ tool: "write", args: { path: "../escape.ts" }, readOnly: false }).action, "ask");
});

test("yolo allows but hardline floor still blocks", () => {
  const engine = new PermissionEngine({ mode: "yolo", cwd });
  assert.equal(engine.decide({ tool: "bash", args: { command: "rm -rf build" }, readOnly: false }).action, "allow");
  const bomb = engine.decide({ tool: "bash", args: { command: "rm -rf /" }, readOnly: false });
  assert.equal(bomb.action, "deny");
});

test("explicit rules win, last match first", () => {
  const engine = new PermissionEngine({
    mode: "default",
    cwd,
    rules: [
      { tool: "bash", pattern: "^git ", action: "allow" },
      { tool: "bash", pattern: "^git push", action: "deny" },
    ],
  });
  assert.equal(engine.decide({ tool: "bash", args: { command: "git status" }, readOnly: false }).action, "allow");
  assert.equal(engine.decide({ tool: "bash", args: { command: "git push origin main" }, readOnly: false }).action, "deny");
});

test("isInside handles traversal", () => {
  assert.equal(isInside("src/a.ts", cwd), true);
  assert.equal(isInside("../other/a.ts", cwd), false);
  assert.equal(isInside("/home/user/project/a.ts", cwd), true);
  assert.equal(isInside("/home/user/projectx/a.ts", cwd), false);
});

test("bash tool denies a hardline command through the engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h-"));
  await writeFile(join(dir, "x"), "1");
  const engine = new PermissionEngine({ mode: "yolo", cwd: dir });
  const d = engine.decide({ tool: "bash", args: { command: "mkfs.ext4 /dev/sda1" }, readOnly: false });
  assert.equal(d.action, "deny");
  await rm(dir, { recursive: true, force: true });
});
