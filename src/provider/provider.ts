import type { Message, ProviderTurn, ToolSpec } from "../core/types.ts";

export interface CompleteRequest {
  messages: Message[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** Ask for a summary-style response (used by compaction). */
  temperature?: number;
}

export interface Provider {
  /** Human-readable name for logs. */
  readonly name: string;
  /** Model context window in tokens; used for compaction thresholds. */
  readonly contextWindow: number;
  readonly model: string;
  complete(req: CompleteRequest): Promise<ProviderTurn>;
  /**
   * Optional: stop sending tool definitions. Implemented by providers that can
   * fall back to chat-only mode for models without working tool calls.
   */
  disableTools?(): void;
}