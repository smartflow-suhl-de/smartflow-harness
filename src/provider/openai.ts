import type { Message, ProviderTurn, ToolCall, Usage } from "../core/types.ts";
import type { CompleteRequest, Provider } from "./provider.ts";

export interface OpenAiCompatibleOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  /** Extra headers, e.g. for OpenRouter or a local gateway. */
  headers?: Record<string, string>;
  /** Provider label used in logs. */
  name?: string;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Talks the OpenAI Chat Completions protocol, which almost every provider
 * (OpenAI, OpenRouter, Groq, Mistral, Ollama, vLLM, LM Studio, ...) speaks.
 * One adapter, many providers — the cheapest possible portability layer.
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly contextWindow: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly maxOutputTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: OpenAiCompatibleOptions) {
    this.name = opts.name ?? "openai-compatible";
    this.model = opts.model;
    this.contextWindow = opts.contextWindow ?? 128_000;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const key = opts.apiKey ?? "";
    this.apiKey = key;
    this.headers = opts.headers ?? {};
    this.maxOutputTokens = opts.maxOutputTokens ?? 8192;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 180_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async complete(req: CompleteRequest): Promise<ProviderTurn> {
    const body = {
      model: this.model,
      messages: toWire(req.messages),
      tools: req.tools.length
        ? req.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined,
      tool_choice: req.tools.length ? ("auto" as const) : undefined,
      max_tokens: this.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const data = await this.post(body, req.signal);
        return parseResponse(data);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === this.maxRetries) break;
        await sleep(500 * 2 ** attempt, req.signal);
      }
    }
    throw lastError;
  }

  private async post(body: unknown, signal: AbortSignal): Promise<ChatCompletionResponse> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: combined,
    });

    const text = await res.text();
    if (!res.ok) {
      const err = new Error(
        `${this.name} HTTP ${res.status}: ${truncate(text, 600) || res.statusText}`,
      );
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    try {
      return JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new Error(`${this.name} returned invalid JSON: ${truncate(text, 300)}`);
    }
  }
}

function toWire(messages: Message[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      return {
        role: "assistant",
        content: m.content || (calls.length ? null : ""),
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.rawArgs || JSON.stringify(c.args) },
              })),
            }
          : {}),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
    }
    return { role: m.role, content: m.content };
  });
}

function parseResponse(data: ChatCompletionResponse): ProviderTurn {
  if (data.error) throw new Error(`provider error: ${data.error.message ?? "unknown"}`);
  const choice = data.choices?.[0];
  if (!choice) throw new Error("provider returned no choices");

  const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map((c, i) => {
    const rawArgs = c.function?.arguments ?? "{}";
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      // Keep args empty; the tool layer turns this into a readable error.
    }
    return {
      id: c.id ?? `call_${i}_${Date.now()}`,
      name: c.function?.name ?? "",
      args,
      rawArgs,
    };
  });

  const usage: Usage | undefined = data.usage
    ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
    : undefined;

  return {
    text: choice.message?.content ?? "",
    toolCalls,
    stopReason: choice.finish_reason ?? "stop",
    usage,
    raw: data,
  };
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status && (status === 408 || status === 409 || status === 429 || status >= 500)) return true;
  const msg = err instanceof Error ? err.message : "";
  return /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}