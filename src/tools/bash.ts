import { spawn } from "node:child_process";
import { defineTool, ok, requireString } from "./registry.ts";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The one tool you cannot do without: a shell.
 *
 * Everything else (read/write/edit/glob/grep) is an optimization for the
 * model: dedicated tools give better error messages and cost fewer tokens
 * than `cat`, `sed`, and `find` output.
 */
export const bashTool = defineTool({
  name: "bash",
  description:
    "Run a shell command in the workspace. Returns stdout, stderr and the exit code. " +
    "Use for builds, tests, git and anything without a dedicated tool. " +
    "Commands time out after 120s by default; pass timeout_ms for longer jobs.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      cwd: { type: "string", description: "Working directory relative to the workspace" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const command = requireString(args, "command");
    const timeoutMs = Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    const cwd = typeof args.cwd === "string" && args.cwd ? `${ctx.cwd}/${args.cwd}` : ctx.cwd;

    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);

      const onAbort = () => kill();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT * 2) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
      });

      const finish = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);

        const parts: string[] = [];
        if (stdout.trim()) parts.push(truncate(stdout.trim(), MAX_OUTPUT, "head"));
        if (stderr.trim()) parts.push(`[stderr]\n${truncate(stderr.trim(), MAX_OUTPUT / 2, "tail")}`);
        if (timedOut) parts.push(`[timed out after ${timeoutMs}ms]`);
        else if (code !== 0) parts.push(`[exit code ${code}${signal ? `, signal ${signal}` : ""}]`);

        const output = parts.join("\n\n") || "(no output)";
        const failed = code !== 0 || timedOut;
        resolve({
          ok: !failed,
          output,
          summary: timedOut ? "timed out" : `exit ${code ?? "?"}`,
        });
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, output: `failed to start command: ${err.message}`, summary: "spawn error" });
      });
      child.on("close", finish);
    });
  },
});

function truncate(text: string, max: number, keep: "head" | "tail"): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  if (keep === "head") return `${text.slice(0, max)}\n… [truncated ${omitted} chars]`;
  return `… [truncated ${omitted} chars]\n${text.slice(-max)}`;
}