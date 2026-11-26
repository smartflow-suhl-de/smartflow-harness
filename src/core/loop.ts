import type { Provider } from "../provider/provider.ts";
import { looksLikeToolCallText } from "../provider/tool-call-text.ts";
import { maybeCompact } from "../context/compact.ts";
import type { PermissionEngine } from "../safety/permissions.ts";
import { hashArgs, redactCommand, type AuditLog } from "../safety/audit.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { Session } from "./session.ts";
import type { AgentEvent, EventSink, Message, ToolCall, ToolSpec, Usage } from "./types.ts";

export interface AskPermission {
  (req: { tool: string; args: Record<string, unknown>; reason: string }): Promise<boolean>;
}

export interface RunOptions {
  session: Session;
  provider: Provider;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  systemPrompt: string;
  cwd: string;
  signal: AbortSignal;
  onEvent?: EventSink;
  ask?: AskPermission;
  maxSteps?: number;
  compact?: boolean;
  /** Whether to run post-edit diagnostics on code files (default false). */
  diagnostics?: boolean;
  /** Security audit log. Disabled when omitted. */
  audit?: AuditLog;
}

export interface RunResult {
  reason: "stop" | "max_steps" | "stuck" | "aborted" | "error";
  usage: Usage;
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/**
 * The loop. Deliberately linear:
 *
 *   prompt -> model -> tool calls -> results -> model -> ... -> no tool calls
 *
 * Every extra behaviour (compaction, permission policy, stuck detection) is a
 * small function called from this body, not a class hierarchy.
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const emit = opts.onEvent ?? (() => {});
  const maxSteps = opts.maxSteps ?? 60;
  const usage: Usage = { ...EMPTY_USAGE };
  let reason: RunResult["reason"] = "max_steps";
  let lastSignature = "";
  let repeated = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal.aborted) return { reason: "aborted", usage };
    emit({ type: "turn_start", step });

    if (opts.compact !== false) {
      try {
        const result = await maybeCompact({
          messages: opts.session.messages,
          provider: opts.provider,
          signal: opts.signal,
        });
        if (result.compacted) {
          opts.session.replaceMessages(result.messages);
          emit({
            type: "compacted",
            removedMessages: result.removedMessages,
            summaryTokens: result.summaryTokens,
          });
        }
      } catch (err) {
        // Compaction is best-effort: a failed summary must not kill the run.
        emit({ type: "error", message: `compaction failed: ${(err as Error).message}`, cause: err });
      }
    }

    const toolsForTurn = (): ToolSpec[] =>
      opts.permissions.mode === "plan"
        ? opts.tools.specs().filter((s) => s.readOnly)
        : opts.tools.specs();

    const askModel = () =>
      opts.provider.complete({
        messages: buildPrompt(opts.session.messages, opts.systemPrompt),
        tools: toolsForTurn(),
        signal: opts.signal,
      });

    const account = (turn: Awaited<ReturnType<typeof askModel>>): void => {
      if (!turn.usage) return;
      usage.inputTokens += turn.usage.inputTokens;
      usage.outputTokens += turn.usage.outputTokens;
      emit({ type: "usage", usage: turn.usage });
    };

    let turn;
    try {
      turn = await askModel();
    } catch (err) {
      if (opts.signal.aborted) return { reason: "aborted", usage };
      emit({ type: "error", message: (err as Error).message, cause: err });
      return { reason: "error", usage };
    }
    account(turn);

    // A model that writes the tool call as text cannot act. Rather than return
    // the JSON blob as an answer, drop tools and ask again for plain text.
    if (turn.toolCalls.length === 0 && looksLikeToolCallText(turn.text) && opts.provider.disableTools) {
      opts.provider.disableTools();
      emit({
        type: "notice",
        message:
          `"${opts.provider.model}" wrote a tool call as text — continuing without tools. ` +
          `Use /model to pick one that calls tools.`,
      });
      try {
        turn = await askModel();
        account(turn);
      } catch (err) {
        if (opts.signal.aborted) return { reason: "aborted", usage };
        emit({ type: "error", message: (err as Error).message, cause: err });
        return { reason: "error", usage };
      }
    }

    if (turn.text) emit({ type: "text", text: turn.text });

    await opts.session.append({
      role: "assistant",
      content: turn.text,
      ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
    });

    if (turn.toolCalls.length === 0) {
      reason = "stop";
      break;
    }

    const signature = turn.toolCalls.map((c) => `${c.name}:${c.rawArgs}`).join("|");
    if (signature === lastSignature && signature !== "") repeated++;
    else repeated = 0;
    lastSignature = signature;

    if (repeated >= 2) {
      emit({ type: "error", message: "same tool calls repeated 3 times; stopping" });
      reason = "stuck";
      break;
    }

    for (const call of turn.toolCalls) {
      const output = await executeCall(call, opts, emit);
      await opts.session.append({
        role: "tool",
        content: output,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  emit({ type: "done", reason });
  return { reason, usage };
}

function buildPrompt(messages: Message[], systemPrompt: string): Message[] {
  const rest = messages.filter((m) => m.role !== "system");
  return [{ role: "system", content: systemPrompt }, ...rest];
}

async function executeCall(
  call: ToolCall,
  opts: RunOptions,
  emit: EventSink,
): Promise<string> {
  emit({ type: "tool_start", name: call.name, args: call.args, id: call.id });

  const tool = opts.tools.get(call.name);
  if (!tool) {
    const msg = `Unknown tool "${call.name}". Available: ${opts.tools.names().join(", ")}`;
    emit({ type: "tool_end", name: call.name, id: call.id, ok: false, summary: "unknown tool" });
    return msg;
  }

  const startedAt = Date.now();
  const argsHash = hashArgs(call.args);
  const argsKeys = Object.keys(call.args).sort();

  const decision = opts.permissions.decide({
    tool: call.name,
    args: call.args,
    readOnly: tool.spec.readOnly,
  });

  let allowed = decision.action === "allow";
  let auditDecision: "allow" | "ask" | "deny" | "declined" =
    decision.action === "deny" ? "deny" : decision.action;
  if (decision.action === "ask") auditDecision = "ask";
  if (decision.action === "deny") {
    emit({ type: "tool_end", name: call.name, id: call.id, ok: false, summary: "denied" });
    return `Permission denied (${decision.reason}). Do not retry the same call; choose another approach or ask the user.`;
  }
  if (decision.action === "ask") {
    allowed = opts.ask
      ? await opts.ask({ tool: call.name, args: call.args, reason: decision.reason })
      : false;
    if (!allowed) auditDecision = "declined";
    if (!allowed) {
      emit({ type: "tool_end", name: call.name, id: call.id, ok: false, summary: "declined" });
      return "The user declined this tool call. Ask what they want instead.";
    }
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });

  const logAudit = (ok: boolean, summary?: string, command?: string): void => {
    void opts.audit?.record({
      ts: new Date().toISOString(),
      event: "tool_call",
      tool: call.name,
      argsHash,
      argsKeys,
      decision: auditDecision,
      reason: decision.reason,
      ok,
      summary,
      command,
      ms: Date.now() - startedAt,
    });
  };

  let sandboxNote: { kind: string; note?: string; command?: string } | undefined;

  try {
    const result = await tool.execute(call.args, {
      cwd: opts.cwd,
      signal: controller.signal,
      sandboxReport: (report) => {
        sandboxNote = report;
        void opts.audit?.record({
          ts: new Date().toISOString(),
          event: "sandbox",
          tool: call.name,
          sandbox: report.kind,
          reason: report.note,
          command: previewCommand(report.command),
        });
      },
      authorize: async (req) => {
        if (req.readOnly) return true;
        const d = opts.permissions.decide(req);
        if (d.action === "allow") return true;
        if (d.action === "deny") return false;
        return opts.ask ? opts.ask({ tool: req.tool, args: req.args, reason: d.reason }) : false;
      },
    });

    if (result.ok && opts.diagnostics && (call.name === "edit" || call.name === "write")) {
      const filePath = typeof call.args.path === "string" ? String(call.args.path) : undefined;
      if (filePath && /\.[jt]sx?$/.test(filePath)) {
        try {
          const { runDiagnostics, formatDiagnostics } = await import("../diagnostics/runner.ts");
          const diagResult = await runDiagnostics({
            cwd: opts.cwd,
            file: filePath,
            signal: controller.signal,
          });
          if (diagResult.diagnostics.length > 0) {
            result.output += `\n\n[Diagnostics after edit]:\n${formatDiagnostics(diagResult.diagnostics)}`;
          }
        } catch {
          // Diagnostics check is best-effort and non-fatal
        }
      }
    }

    emit({ type: "tool_end", name: call.name, id: call.id, ok: result.ok, summary: result.summary });
    logAudit(result.ok, result.summary, sandboxNote?.command);
    return result.output;
  } catch (err) {
    const message = (err as Error).message;
    emit({ type: "tool_end", name: call.name, id: call.id, ok: false, summary: "error" });
    logAudit(false, "error", sandboxNote?.command);
    return `Tool "${call.name}" failed: ${message}`;
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
  }
}

/** Shell commands are recorded redacted and truncated: enough to recognize, not to leak. */
function previewCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  return redactCommand(command);
}

export type { AgentEvent };