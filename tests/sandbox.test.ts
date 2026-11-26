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
  const result = await sandbox.resolve(
    { cwd: tmpdir(), command: "echo hi", env: {} },
    (reason) => reports.push(reason),
  );
  if (process.platform !== "linux") return;
  // Either the user-namespace sandbox takes over, or, without unshare on the
  // host, the command degrades to a plain shell — both with a stated reason.
  assert.ok(result.kind === "unshare" || result.kind === "none");
  assert.match(result.note ?? "", /bwrap cannot start here/);
  assert.equal(reports.length, 1);
});

test("Sandbox: strict mode refuses instead of running unsandboxed", async () => {
  const fake = join(await mkdtemp(join(tmpdir(), "harness-fake-bwrap2-")), "bwrap");
  await writeFile(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const sandbox = new Sandbox({ mode: "bwrap", bwrapPath: fake });
  if (process.platform !== "linux") return;
  const result = await sandbox.resolve({ cwd: tmpdir(), command: "echo hi", env: {} });
  assert.equal(result.kind, "none");
  assert.equal(result.strict, true);
  assert.match(result.note ?? "", /forbids the fallback/);
});

test("Sandbox: the probe runs once, not once per command", async () => {
  // count executions of the fake bwrap via its own log file
  const dir = await mkdtemp(join(tmpdir(), "harness-count-bwrap-"));
  const fake = join(dir, "bwrap");
  await writeFile(fake, `#!/bin/sh\necho x >> ${join(dir, "calls")}\nexit 1\n`, { mode: 0o755 });
  const sandbox = new Sandbox({ mode: "auto", bwrapPath: fake });
  if (process.platform !== "linux") return;
  await sandbox.resolve({ cwd: tmpdir(), command: "echo 1", env: {} });
  await sandbox.resolve({ cwd: tmpdir(), command: "echo 2", env: {} });
  await sandbox.resolve({ cwd: tmpdir(), command: "echo 3", env: {} });
  const { readFile } = await import("node:fs/promises");
  const callsLogged = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").length;
  assert.equal(callsLogged, 1, "bwrap must be probed once per Sandbox instance");
});

test("Sandbox: secrets from the host env are cleared inside the sandbox", () => {
  const sandbox = new Sandbox({ mode: "auto" });
  const plan = sandbox.plan({ cwd: tmpdir(), command: "echo $OPENAI_API_KEY", env: { OPENAI_API_KEY: "sk-secret" } });
  if (plan.kind !== "bwrap") return;
  assert.ok(plan.argv.includes("--clearenv"), "must not inherit the host environment");
  assert.ok(!plan.argv.join(" ").includes("sk-secret"), "no host secret may appear in argv");
  assert.ok(plan.argv.includes(SAFE_PATH_ARG), "PATH is fixed inside the sandbox");
});

const SAFE_PATH_ARG = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

test("Sandbox: writable paths overlapping system dirs are ignored", () => {
  const sandbox = new Sandbox({ mode: "auto", writablePaths: ["/usr", "/usr/local/x"] });
  const plan = sandbox.plan({ cwd: tmpdir(), command: "true", env: {} });
  if (plan.kind !== "bwrap") return;
  const binds = plan.argv.filter((v) => v === "--bind-try").length;
  assert.equal(binds, 0, "a path inside a read-only system dir must never be bound writable");
});

test("Sandbox: when bwrap cannot start, the user-namespace sandbox takes over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-unshare-fallback-"));
  const fake = join(dir, "bwrap");
  await writeFile(fake, "#!/bin/sh\necho 'bwrap: Failed to make / slave: Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });
  const sandbox = new Sandbox({ mode: "auto", bwrapPath: fake });
  if (process.platform !== "linux" || !sandbox.unshare) return;

  const notes: string[] = [];
  const plan = await sandbox.resolve({ cwd: dir, command: "echo hi", env: {} }, (r) => notes.push(r));
  assert.equal(plan.kind, "unshare");
  assert.deepEqual(plan.argv.slice(0, 3), [sandbox.unshare, "-U", "-r"]);
  assert.ok(plan.argv.includes("-n"), "network is isolated by default");
  assert.ok(plan.argv.includes("-p"), "pid namespace");
  // The environment is replaced, not inherited: no host secret can leak in.
  assert.ok(plan.argv.some((a) => a.endsWith("/env")) && plan.argv.includes("-i"));
  assert.equal(notes.length, 1);
});

test("Sandbox: unshareFallback=false degrades to a plain shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-no-unshare-"));
  const fake = join(dir, "bwrap");
  await writeFile(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const sandbox = new Sandbox({ mode: "auto", bwrapPath: fake, unshareFallback: false });
  if (process.platform !== "linux") return;
  const plan = await sandbox.resolve({ cwd: dir, command: "echo hi", env: {} });
  assert.equal(plan.kind, "none");
  assert.match(plan.note ?? "", /running unsandboxed/);
});

test("Sandbox live: the user-namespace sandbox really isolates network and env", async () => {
  const sandbox = new Sandbox({ mode: "auto", bwrapPath: "" });
  if (process.platform !== "linux" || !sandbox.unshare) return;
  const plan = await sandbox.resolve({ cwd: tmpdir(), command: "echo hi", env: {} }, () => {});
  if (plan.kind !== "unshare") return;

  const { spawnSync } = await import("node:child_process");
  const script = "n=$(awk \"NR>2 && \\$1 !~ /lo:/\" /proc/net/dev | wc -l); echo net=$n; echo pid=$$; echo secret=${OPENAI_API_KEY:-none}";
  const run = spawnSync(plan.argv[0]!, [...plan.argv.slice(1, -3), "/bin/sh", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, OPENAI_API_KEY: "sk-REAL-SECRET" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /net=0/, "no network interface besides loopback");
  assert.match(run.stdout, /pid=1/, "own pid namespace");
  assert.doesNotMatch(run.stdout, /sk-REAL-SECRET/, "host environment must not reach the sandbox");
});
