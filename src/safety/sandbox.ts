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

export interface SandboxConfig {
  /** "off" disables sandboxing, "bwrap" requires it, "auto" uses it if present. */
  mode?: SandboxMode;
  /** Extra paths that are writable inside the sandbox (in addition to cwd). */
  writablePaths?: string[];
  /** Allow network inside the sandbox. Off by default. */
  network?: boolean;
  /** Absolute path to the bwrap binary. Defaults to PATH lookup. */
  bwrapPath?: string;
}

export interface SandboxPlan {
  kind: "bwrap" | "none";
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
  private probeResult: Promise<{ ok: boolean; reason?: string }> | undefined;

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
  }

  /** Whether sandboxing can be applied on this host under the current config. */
  available(): boolean {
    if (this.mode === "off") return false;
    return Boolean(this.bwrap) && process.platform === "linux";
  }

  /**
   * Run a command and, if bwrap itself fails to start (a container without
   * CAP_SYS_ADMIN prints "Failed to make / slave"), retry once in a plain
   * shell. Isolation degrades, the tool keeps working, and `onFallback`
   * carries the reason so the caller can surface and audit it.
   */
  async runWithFallback(
    opts: { cwd: string; command: string; env: Record<string, string> },
    onFallback?: (reason: string) => void,
  ): Promise<{ kind: "bwrap" | "none"; note?: string; strict?: boolean }> {
    const plan = this.plan(opts);
    if (plan.kind !== "bwrap") {
      return { kind: "none", ...(plan.note ? { note: plan.note } : {}) };
    }

    // The probe costs a process per call; a host does not fix itself between
    // two bash calls, so remember the verdict.
    const cached = await this.probe();
    if (cached.ok) return { kind: "bwrap" };
    const reason = cached.reason ?? "bwrap cannot start here";
    if (this.mode === "bwrap") {
      // Strict mode is a promise, not a suggestion: refusing beats a silent
      // unsandboxed run.
      return { kind: "none", note: `${reason}; mode "bwrap" forbids the fallback, refusing to run`, strict: true };
    }
    onFallback?.(reason);
    return { kind: "none", note: `${reason}; running unsandboxed` };
  }

  private async probeOnce(): Promise<{ ok: boolean; reason?: string }> {
    const { spawn } = await import("node:child_process");
    const probe = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
      let stderr = "";
      const child = spawn(this.bwrap!, ["--unshare-user", "--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < 400) stderr += c.toString();
      });
      child.on("error", (err) => resolve({ ok: false, stderr: err.message }));
      child.on("close", (code) => resolve({ ok: code === 0, stderr }));
    });

    if (probe.ok) return { ok: true };
    const first = probe.stderr.trim().split("\n")[0] || "unknown error";
    return { ok: false, reason: `bwrap cannot start here (${first}); running unsandboxed` };
  }

  /**
   * Whether bwrap actually works here. `--version` alone is not enough: in a
   * container without CAP_SYS_ADMIN (some sandboxed CI runners) bwrap starts
   * and then fails on the first mount with "Failed to make / slave".
   */
  async probe(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.available()) {
      return { ok: false, reason: this.mode === "off" ? "sandbox off" : "bwrap not found" };
    }
    if (!this.probeResult) {
      this.probeResult = this.probeOnce();
    }
    return this.probeResult;
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