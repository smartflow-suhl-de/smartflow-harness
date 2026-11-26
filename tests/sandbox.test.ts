import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../src/safety/sandbox.ts";

test("Sandbox: mode off returns a plain shell plan", () => {
  const sandbox = new Sandbox({ mode: "off" });
  const plan = sandbox.plan({ cwd: "/tmp", command: "echo hi", env: {} });
  assert.equal(plan.kind, "none");
  assert.equal(plan.note, "sandbox off");
  assert.deepEqual(plan.argv, []);
});

test("Sandbox: unavailable bwrap falls back with an explicit note", () => {
  const sandbox = new Sandbox({ mode: "bwrap", bwrapPath: "" });
  const plan = sandbox.plan({ cwd: "/tmp", command: "echo hi", env: {} });
  assert.equal(plan.kind, "none");
  assert.match(plan.note ?? "", /bwrap not found/);
});

test("Sandbox: bwrap plan isolates the network, tmpfs and the workspace", () => {
  const sandbox = new Sandbox({ mode: "bwrap", bwrapPath: "/usr/bin/bwrap" });
  const plan = sandbox.plan({ cwd: "/tmp", command: "echo hi", env: {} });
  if (process.platform !== "linux") {
    assert.equal(plan.kind, "none");
    return;
  }
  assert.equal(plan.kind, "bwrap");
  assert.ok(plan.argv.includes("--unshare-net"));
  assert.ok(plan.argv.includes("--die-with-parent"));
  assert.ok(plan.argv.includes("--proc"));
  // The command is passed as a single argv element after `--`, never re-parsed.
  const dashDash = plan.argv.lastIndexOf("--");
  assert.deepEqual(plan.argv.slice(dashDash), ["--", "/bin/sh", "-c", "echo hi"]);
  assert.ok(plan.argv.includes("--unshare-user"), "user namespace avoids needing CAP_SYS_ADMIN");
});

test("Sandbox: probe reports a working or broken bwrap instead of throwing", async () => {
  const sandbox = new Sandbox({ mode: "auto" });
  const result = await sandbox.probe();
  if (!sandbox.available()) {
    assert.equal(result.ok, false);
    return;
  }
  assert.equal(typeof result.ok, "boolean");
  if (!result.ok) assert.ok((result.reason ?? "").length > 0);
});

test("Sandbox: network can be allowed explicitly", () => {
  const sandbox = new Sandbox({ mode: "bwrap", bwrapPath: "/usr/bin/bwrap", network: true });
  const plan = sandbox.plan({ cwd: "/tmp", command: "curl example.com", env: {} });
  if (plan.kind !== "bwrap") return;
  assert.ok(!plan.argv.includes("--unshare-net"));
});

test("Sandbox: the workspace is bound writable, and only once", () => {
  const sandbox = new Sandbox({ mode: "bwrap", bwrapPath: "/usr/bin/bwrap", writablePaths: ["/tmp"] });
  const plan = sandbox.plan({ cwd: "/tmp", command: "true", env: {} });
  if (plan.kind !== "bwrap") return;
  const bindCount = plan.argv.filter((v) => v === "--bind").length;
  assert.equal(bindCount, 1, "workspace is bound exactly once even when also listed as writable");
});
test("Sandbox: a bwrap that cannot start degrades with a reason instead of throwing", async () => {
  // A binary that exists but always fails, like bwrap in a container without
  // CAP_SYS_ADMIN ("Failed to make / slave").
  const fake = join(await mkdtemp(join(tmpdir(), "harness-fake-bwrap-")), "bwrap");
  await writeFile(fake, "#!/bin/sh\necho 'bwrap: Failed to make / slave: Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });

  const sandbox = new Sandbox({ mode: "auto", bwrapPath: fake });
  const reports: string[] = [];
  const result = await sandbox.runWithFallback(
    { cwd: tmpdir(), command: "echo hi", env: {} },
    (reason) => reports.push(reason),
  );
  if (process.platform !== "linux") return;
  assert.equal(result.kind, "none");
  assert.match(result.note ?? "", /bwrap cannot start here/);
  assert.equal(reports.length, 1);
});
