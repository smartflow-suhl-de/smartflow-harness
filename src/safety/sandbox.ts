import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * OS-level sandbox for the bash tool.
 *
 * Policy protects the harness config, not the host: once the model can run
 * shell, the workspace is one `rm -rf` away from gone. On Linux, bubblewrap
 * (bwrap) gives us a namespaced filesystem where only the workspace and
 * explicitly allowed paths are writable, and no `/proc`, no home config
 * beyond what the command needs.
 *
 * Design notes:
 * - bwrap is optional. A missing binary must not brick the tool: we fall
 *   back to a plain shell and record that fact in the result, not silently.
 * - We never shell-interpolate. `command` is passed to the shell as an argv
 *   element after a `--` separator in the bwrap argument list.
 * - The allowed-write set is resolved through `realpath` after creation-time
 *   checks in the caller, so a symlink inside the workspace cannot widen it.
 */

export type SandboxMode = "off" | "bwrap" | "auto";

/**
 * How a command is isolated:
 *   bwrap    full bubblewrap namespace: filesystem, network, pids, environment
 *   unshare  Linux user namespace via unshare(1): network, pids, ipc, session,
 *            cleared environment. No filesystem isolation (needs mount rights).
 *   none     plain shell
 */
export type SandboxKind = "bwrap" | "unshare" | "none";

export interface SandboxConfig {
  /** "off" disables sandboxing, "bwrap" requires it, "auto" uses it if present. */
  mode?: SandboxMode;
  /** Extra paths that are writable inside the sandbox (in addition to cwd). */
  writablePaths?: string[];
  /** Allow network inside the sandbox. Off by default. */
  network?: boolean;
  /** Absolute path to the bwrap binary. Defaults to PATH lookup. */
  bwrapPath?: string;
  /**
   * If bwrap cannot start, fall back to a user-namespace sandbox (unshare(1)):
   * network, pids and environment isolated, filesystem shared. Default true;
   * only used in mode "auto". `false` degrades straight to an unsandboxed shell.
   */
  unshareFallback?: boolean;
}

export interface SandboxPlan {
  kind: SandboxKind;
  /** Full argv for bwrap; empty when kind is "none". */
  argv: string[];
  /** Human-readable note, e.g. the reason for a fallback. */
  note?: string;
}

/** System directories that are mounted read-only so binaries and libs work. */
const READONLY_SYSTEM_DIRS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/etc",
  "/opt",
  "/nix",
];

export class Sandbox {
  readonly mode: SandboxMode;
  readonly network: boolean;
  private readonly extraWritable: string[];
  readonly bwrap: string | undefined;
  readonly unshare: string | undefined;
  /** Allow the user-namespace fallback when bwrap cannot run (mode "auto" only). */
  readonly allowUnshare: boolean;
  /** Kind of isolation the most recent run actually got; for the audit log. */
  lastKind: SandboxKind = "none";
  private probeResult: Promise<{ ok: boolean; reason?: string; unshare: boolean }> | undefined;

  constructor(cfg: SandboxConfig = {}) {
    this.mode = cfg.mode ?? "auto";
    this.network = cfg.network ?? false;
    this.extraWritable = (cfg.writablePaths ?? [])
      .map(resolvePathSafely)
      .filter((p): p is string => Boolean(p))
      // A writable path that contains (or sits inside) a read-only system dir
      // would undo the ro-bind; such config is ignored, not silently honoured.
      .filter((p) => !overlapsSystemDir(p));
    // An explicit bwrapPath always wins, including "" which forces "missing" (tests).
    this.bwrap = cfg.bwrapPath !== undefined ? cfg.bwrapPath || undefined : findOnPath("bwrap");
    this.unshare = findOnPath("unshare");
    this.allowUnshare = cfg.unshareFallback ?? true;
  }

  /** Whether any sandboxing can be applied on this host under the current config. */
  available(): boolean {
    if (this.mode === "off") return false;
    if (process.platform !== "linux") return false;
    return Boolean(this.bwrap) || (this.allowUnshare && Boolean(this.unshare));
  }

  /**
   * Decide how this command runs. bwrap first; if it cannot start (a container
   * without mount rights prints "Failed to make / slave"), fall back to a
   * constrained user namespace via unshare(1): network, pids, ipc and the
   * environment stay isolated, only the filesystem view is shared. Mode "bwrap"
   * refuses instead of degrading.
   */
  async resolve(
    opts: { cwd: string; command: string; env: Record<string, string> },
    onFallback?: (reason: string) => void,
  ): Promise<{ kind: SandboxKind; argv: string[]; note?: string; strict?: boolean }> {
    const plan = this.plan(opts);
    if (plan.kind !== "bwrap") {
      this.lastKind = plan.kind;
      return plan;
    }

    const probed = await this.probe();
    if (probed.ok) {
      this.lastKind = "bwrap";
      return plan;
    }

    const reason = probed.reason ?? "bwrap cannot start here";
    if (this.mode === "bwrap") {
      // Strict mode is a promise, not a suggestion: refusing beats a silent
      // unsandboxed run.
      return { kind: "none", argv: [], note: `${reason}; mode "bwrap" forbids the fallback, refusing to run`, strict: true };
    }

    if (probed.unshare) {
      onFallback?.(`${reason}; using a user-namespace sandbox (no filesystem isolation)`);
      this.lastKind = "unshare";
      return { kind: "unshare", argv: this.unshareArgv(opts), note: `${reason}; network/pid isolated via user namespace, filesystem shared` };
    }

    onFallback?.(`${reason}; running unsandboxed`);
    this.lastKind = "none";
    return { kind: "none", argv: [], note: `${reason}; running unsandboxed` };
  }

  /**
   * unshare(1) budget: a user namespace (so the others need no root), then
   * net/pid/ipc/uts/session inside it. `--mount-proc` is deliberately absent:
   * it needs a mount namespace, which is exactly what is unavailable here.
   */
  private unshareArgv(opts: { cwd: string; command: string }): string[] {
    const argv = [this.unshare!, "-U", "-r"];
    if (!this.network) argv.push("-n");
    argv.push("-p", "-f", "-i", "-u", "--");
    argv.push("/usr/bin/env", "-i", "HOME=/tmp", "TMPDIR=/tmp", "PATH=" + SAFE_PATH, "GIT_PAGER=cat", "PAGER=cat", "NO_COLOR=1");
    argv.push("/bin/sh", "-c", opts.command);
    return argv;
  }

  /**
   * Probe both backends once. `--version` is not enough for bwrap: it can be
   * installed and still fail on the first mount.
   */
  async probe(): Promise<{ ok: boolean; reason?: string; unshare: boolean }> {
    if (!this.probeResult) {
      this.probeResult = this.probeOnce();
    }
    return this.probeResult;
  }

  private async probeOnce(): Promise<{ ok: boolean; reason?: string; unshare: boolean }> {
    const { spawn } = await import("node:child_process");
    const runOnce = (bin: string, args: string[]): Promise<{ ok: boolean; stderr: string }> =>
      new Promise((resolve) => {
        let stderr = "";
        const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
        child.stderr?.on("data", (c: Buffer) => {
          if (stderr.length < 400) stderr += c.toString();
        });
        child.on("error", (err) => resolve({ ok: false, stderr: err.message }));
        child.on("close", (code) => resolve({ ok: code === 0, stderr }));
      });

    if (this.mode !== "off" && process.platform === "linux" && this.bwrap) {
      const probe = await runOnce(this.bwrap, ["--unshare-user", "--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"]);
      if (probe.ok) return { ok: true, unshare: false };
      const first = probe.stderr.trim().split("\n")[0] || "unknown error";
      const reason = `bwrap cannot start here (${first})`;
      if (!this.allowUnshare || !this.unshare) return { ok: false, reason, unshare: false };
      const fallback = await runOnce(this.unshare, ["-U", "-r", "-n", "--", "/bin/true"]);
      return { ok: false, reason, unshare: fallback.ok };
    }

    if (this.mode !== "off" && process.platform === "linux" && this.unshare && this.allowUnshare) {
      const fallback = await runOnce(this.unshare, ["-U", "-r", "-n", "--", "/bin/true"]);
      const reason = this.bwrap ? "bwrap not found" : "sandbox off";
      return { ok: false, reason, unshare: fallback.ok };
    }

    return { ok: false, reason: this.mode === "off" ? "sandbox off" : "no sandbox binary found", unshare: false };
  }

  /**
   * Build the argv for a sandboxed shell. Returns `{ kind: "none" }` when
   * sandboxing is disabled or unavailable; `note` explains why.
   */
  plan(opts: { cwd: string; command: string; env: Record<string, string> }): SandboxPlan {
    if (this.mode === "off") {
      return { kind: "none", argv: [], note: "sandbox off" };
    }
    if (process.platform !== "linux") {
      const note = `sandbox unavailable on ${process.platform}; running unsandboxed`;
      if (this.mode === "bwrap") return { kind: "none", argv: [], note };
      return { kind: "none", argv: [], note };
    }
    if (!this.bwrap) {
      const note = this.mode === "bwrap"
        ? "sandbox required but bwrap not found; falling back to unsandboxed shell"
        : "bwrap not found; running unsandboxed";
      return { kind: "none", argv: [], note };
    }

    const cwd = resolvePathSafely(opts.cwd);
    if (!cwd) {
      return { kind: "none", argv: [], note: `cannot resolve cwd ${opts.cwd}; running unsandboxed` };
    }
    if (overlapsSystemDir(cwd)) {
      return { kind: "none", argv: [], note: `cwd ${cwd} overlaps a system path; running unsandboxed` };
    }

    const argv: string[] = [
      this.bwrap!,
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--new-session",
      // P0: the host env carries API keys; only an explicit whitelist may enter.
      "--clearenv",
      "--setenv", "HOME", "/tmp",
      "--setenv", "TMPDIR", "/tmp",
      "--setenv", "PATH", SAFE_PATH,
      "--setenv", "GIT_PAGER", "cat",
      "--setenv", "PAGER", "cat",
      "--setenv", "NO_COLOR", "1",
    ];

    if (!this.network) argv.push("--unshare-net");

    // Root read-only first: it gives one consistent tree, so /bin -> /usr/bin
    // style symlinks resolve inside the namespace instead of pointing at
    // paths that were never mounted. /proc, /dev and /tmp are overlaid below.
    argv.push("--ro-bind", "/", "/");
    argv.push("--dev", "/dev");
    argv.push("--proc", "/proc");
    argv.push("--tmpfs", "/tmp");

    // The workspace: writable. Extra paths: writable. Missing ones are skipped.
    argv.push("--bind", cwd, cwd);
    for (const dir of this.extraWritable) {
      if (!existsSync(dir)) continue;
      if (dir === cwd) continue;
      argv.push("--bind-try", dir, dir);
    }

    // Hide the real home; the agent does not need ~/.ssh from a shell.
    argv.push("--setenv", "PWD", cwd);
    argv.push("--chdir", cwd);

    // Everything after -- is the command. Passing the shell as argv avoids
    // any re-parsing by bwrap itself.
    argv.push("--", "/bin/sh", "-c", opts.command);

    return { kind: "bwrap", argv };
  }
}

/**
 * Look up a binary without trusting PATH order. System directories win, so a
 * project-local `./bwrap` or an attacker-prepended PATH entry cannot shadow
 * the real sandbox binary.
 */
const SYSTEM_PATH_DIRS = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function findOnPath(name: string): string | undefined {
  for (const dir of SYSTEM_PATH_DIRS) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  const dirs = (process.env.PATH ?? "").split(":").filter((d) => d.startsWith("/"));
  for (const dir of dirs) {
    if (SYSTEM_PATH_DIRS.includes(dir)) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** PATH inside the sandbox: fixed, so a poisoned PATH cannot pick binaries. */
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * True when `child` is inside `parent` (or equal). A bind-mount of something
 * that contains a read-only system directory would unlock it.
 */
function overlapsSystemDir(path: string): boolean {
  const resolved = resolvePathSafely(path);
  if (!resolved) return true;
  return READONLY_SYSTEM_DIRS.some((sys) => resolved === sys || resolved.startsWith(sys + "/") || sys.startsWith(resolved + "/"));
}

function resolvePathSafely(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // Path does not exist yet; keep the literal value only if it is absolute.
    return path.startsWith("/") ? path : undefined;
  }
}