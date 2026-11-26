/**
 * Core message and tool types.
 *
 * These are deliberately provider-agnostic: providers translate them into
 * their own wire format (see src/provider/openai.ts).
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Empty object when the model sent invalid JSON. */
  args: Record<string, unknown>;
  /** Raw argument string, kept for diagnostics and error messages. */
  rawArgs: string;
}

export interface Message {
  role: Role;
  content: string;
  /** assistant only */
  toolCalls?: ToolCall[];
  /** tool only */
  toolCallId?: string;
  toolName?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage?: Usage;
  /** Raw provider response, for logging/debugging. */
  raw?: unknown;
}

/** A JSON-schema subset; enough for tool parameters. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** True when the tool cannot modify state (files, processes, network). */
  readOnly: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. Truncate aggressively: it costs context. */
  output: string;
  /** Short human-facing summary for the CLI (not sent to the model). */
  summary?: string;
}

export interface Tool {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** Ask the user / policy layer whether this call may run. */
  authorize(call: { tool: string; args: Record<string, unknown>; readOnly: boolean }): Promise<boolean>;
}

export type AgentEvent =
  | { type: "turn_start"; step: number }
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown>; id: string }
  | { type: "tool_end"; name: string; id: string; ok: boolean; summary?: string }
  | { type: "usage"; usage: Usage }
  | { type: "compacted"; removedMessages: number; summaryTokens: number }
  | { type: "error"; message: string; cause?: unknown }
  | { type: "done"; reason: "stop" | "max_steps" | "stuck" | "aborted" | "error" };

export type EventSink = (event: AgentEvent) => void;