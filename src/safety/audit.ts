import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Audit log.
 *
 * One NDJSON line per security-relevant event: which tool ran, whether it was
 * allowed, how it ended, and under which sandbox. Arguments are recorded as a
 * hash plus the names of their keys — never their values, because values can
 * hold prompts, tokens or file contents.
 *
 * Writes are best-effort: a logging failure must never break a tool call, but
 * it is reported once through `onError` so a broken log does not go unnoticed.
 */

export type AuditDecision = "allow" | "ask" | "deny" | "declined";

export interface AuditEntry {
  /** ISO timestamp, UTC. */
  ts: string;
  event: "tool_call" | "permission" | "sandbox";
  tool?: string;
  /** SHA-256 of the JSON-serialized arguments; stable, non-reversible. */
  argsHash?: string;
  /** Argument key names, sorted. */
  argsKeys?: string[];
  decision?: AuditDecision;
  reason?: string;
  ok?: boolean;
  summary?: string;
  sandbox?: string;
  /** Command preview for bash, truncated; never full file contents. */
  command?: string;
  /** The call's own duration in milliseconds. */
  ms?: number;
}

export interface AuditLogOptions {
  /** Absolute log path. Defaults to ~/.config/harness/audit.jsonl. */
  path?: string;
  /** Disable logging entirely. */
  disabled?: boolean;
  /** Rotate when the file exceeds this size. Defaults to 10 MiB. */
  maxBytes?: number;
  onError?: (err: Error) => void;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Strip the obvious secret shapes from a command before it reaches the log.
 * This is a safety net, not a parser: anything that looks like a token, a
 * key assignment or a bearer header is replaced, and the preview is short.
 */
export function redactCommand(command: string, max = 200): string {
  const redacted = command
    .replace(/(?:--?[a-z0-9-]*(?:key|token|secret|password|passwd|pwd)[a-z0-9-]*)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=<redacted>")
    .replace(/(?:\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=)(?:"[^"]*"|'[^']*'|\S+)/g, "$1<redacted>")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, (m) => `${m.split(/\s+/)[0]} <redacted>`)
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "<redacted>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "<redacted>");
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

export function hashArgs(args: Record<string, unknown>): string {
  const stable = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

export class AuditLog {
  readonly path: string;
  readonly disabled: boolean;
  private readonly maxBytes: number;
  private readonly onError?: (err: Error) => void;
  private writeChain: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;

  constructor(opts: AuditLogOptions = {}) {
    this.path = opts.path ?? join(homedir(), ".config", "harness", "audit.jsonl");
    this.disabled = opts.disabled ?? false;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onError = opts.onError;
  }

  /** Wait until every queued line is written. Call before process exit. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Append one entry. Resolves when the line is on disk (or was dropped). */
  async record(entry: AuditEntry): Promise<void> {
    if (this.disabled) return;
    const line = JSON.stringify(entry) + "\n";
    this.writeChain = this.writeChain.then(() => this.write(line)).catch((err) => {
      this.onError?.(err as Error);
    });
    return this.writeChain;
  }

  private async write(line: string): Promise<void> {
    await this.ensureFile();
    await this.maybeRotate();
    await appendFile(this.path, line, { mode: 0o600 });
  }

  private async ensureFile(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        await stat(this.path);
        await chmod(this.path, 0o600);
      } catch {
        // Created on first append.
      }
    })();
    return this.ready;
  }

  private async maybeRotate(): Promise<void> {
    try {
      const info = await stat(this.path);
      if (info.size <= this.maxBytes) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await rename(this.path, `${this.path}.${stamp}`);
    } catch {
      // No file yet.
    }
  }
}