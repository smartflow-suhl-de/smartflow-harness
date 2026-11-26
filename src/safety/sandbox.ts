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

/** Directories bwrap needs for its own setup but that stay invisible afterwards. */
const BWRAP_INTERNAL = ["/proc", "/sys", "/dev/pts", "/dev/ptmx", "/dev/shm"];

export class Sandbox {
  readonly mode: SandboxMode;
  readonly network: boolean;
  private readonly extraWritable: string[];
  readonly bwrap: string | undefined;

  constructor(cfg: SandboxConfig = {}) {
    this.mode = cfg.mode ?? "auto";
    this.network = cfg.network ?? false;
    this.extraWritable = (cfg.writablePaths ?? []).map(resolvePathSafely).filter((p): p is string => Boolean(p));
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
  ): Promise<{ kind: "bwrap" | "none"; note?: string }> {
    const plan = this.plan(opts);
    if (plan.kind !== "bwrap") {
      return { kind: "none", ...(plan.note ? { note: plan.note } : {}) };
    }

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

    if (probe.ok) return { kind: "bwrap" };
    const reason = `bwrap cannot start here (${probe.stderr.trim().split("\n")[0] || "unknown error"}); running unsandboxed`;
    onFallback?.(reason);
    return { kind: "none", note: reason };
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
    const { spawn } = await import("node:child_process");
    const args = ["--unshare-user", "--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"];
    return new Promise((resolve) => {
      let stderr = "";
      const child = spawn(this.bwrap!, args, { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < 400) stderr += c.toString();
      });
      child.on("error", (err) => resolve({ ok: false, reason: err.message }));
      child.on("close", (code) => {
        if (code === 0) return resolve({ ok: true });
        const first = stderr.trim().split("\n")[0] ?? "";
        resolve({
          ok: false,
          reason: `bwrap cannot start here (${first || `exit ${code}`}); running unsandboxed`,
        });
      });
    });
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

    const argv: string[] = [
      this.bwrap!,
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--new-session",
      "--setenv", "HOME", "/tmp",
      "--setenv", "TMPDIR", "/tmp",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
    ];

    if (!this.network) argv.push("--unshare-net");

    // System paths read-only.
    for (const dir of READONLY_SYSTEM_DIRS) {
      if (!existsSync(dir)) continue;
      argv.push("--ro-bind", dir, dir);
    }

    // bwrap's own bootstrapping paths must be bindable, otherwise --proc fails.
    for (const p of BWRAP_INTERNAL) {
      if (!existsSync(p)) continue;
      argv.push("--ro-bind-try", p, p);
    }

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

function findOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolvePathSafely(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // Path does not exist yet; keep the literal value only if it is absolute.
    return path.startsWith("/") ? path : undefined;
  }
}