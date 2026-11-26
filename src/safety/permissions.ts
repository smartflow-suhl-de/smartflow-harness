import { isAbsolute, relative, resolve } from "node:path";

/**
 * Permission model.
 *
 * Three modes, following the convergence described in the harness research
 * (Gemini CLI's PLAN/DEFAULT/YOLO, Codex's approval modes):
 *
 *   plan     read-only tools only
 *   default  read-only + writes inside the workspace; everything else asks
 *   yolo     everything is allowed except a small hardline floor
 *
 * Rules are data, not code, and the *last* matching rule wins. That makes
 * config predictable and orders "allow git *" before "deny git push".
 */

export type Mode = "plan" | "default" | "yolo";
export type Action = "allow" | "deny" | "ask";

export interface Rule {
  /** Tool name, or "*" for any tool. */
  tool: string;
  /** Regex against the bash command or the first path-like argument. */
  pattern?: string;
  action: Action;
}

export interface PermissionRequest {
  tool: string;
  args: Record<string, unknown>;
  readOnly: boolean;
}

export interface PermissionDecision {
  action: Action;
  reason: string;
}

/** Patterns that stay blocked even in yolo mode. */
export const HARDLINE: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+\/(?:\s|$)/, reason: "recursive delete of /" },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "format filesystem" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)/, reason: "raw disk write" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "host power state" },
];

const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

export class PermissionEngine {
  mode: Mode;
  private readonly rules: Rule[];
  private readonly cwd: string;

  constructor(opts: { mode: Mode; rules?: Rule[]; cwd: string }) {
    this.mode = opts.mode;
    this.rules = opts.rules ?? [];
    this.cwd = opts.cwd;
  }

  decide(req: PermissionRequest): PermissionDecision {
    const subject = subjectOf(req);

    for (const hard of HARDLINE) {
      if (hard.pattern.test(subject)) {
        return { action: "deny", reason: `hardline: ${hard.reason}` };
      }
    }

    if (this.mode === "yolo") return { action: "allow", reason: "yolo mode" };
    if (this.mode === "plan") {
      return req.readOnly
        ? { action: "allow", reason: "plan mode allows read-only tools" }
        : { action: "deny", reason: "plan mode blocks mutating tools" };
    }

    // default mode: explicit rules win, last match first.
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]!;
      if (rule.tool !== "*" && rule.tool !== req.tool) continue;
      if (rule.pattern && !safeRegex(rule.pattern).test(subject)) continue;
      return { action: rule.action, reason: `rule ${i + 1}: ${rule.tool} ${rule.pattern ?? "*"}` };
    }

    if (req.readOnly) return { action: "allow", reason: "read-only tool" };

    if (WRITE_TOOLS.has(req.tool)) {
      const path = firstPath(req.args);
      if (path && isInside(path, this.cwd)) {
        return { action: "allow", reason: "write inside workspace" };
      }
      return { action: "ask", reason: "write outside workspace" };
    }

    return { action: "ask", reason: "no rule matched" };
  }
}

function subjectOf(req: PermissionRequest): string {
  if (req.tool === "bash") return String(req.args.command ?? "");
  return String(firstPath(req.args) ?? "");
}

export function firstPath(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "filePath", "pattern"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export function isInside(path: string, cwd: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return /$^/;
  }
}