/**
 * Ollama-specific capability lookup.
 *
 * The OpenAI-compatible endpoint does not say whether a model can call tools;
 * only native `/api/show` does. That is the difference between "pick a model"
 * and "pick a model that can actually act".
 */
export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
}

/** `http://host:port/v1` -> `http://host:port`, or undefined for other URLs. */
export function ollamaRoot(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/") {
      return url.origin;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function ollamaCapabilities(
  opts: { baseUrl: string; model: string; timeoutMs?: number },
): Promise<ModelCapabilities | undefined> {
  const root = ollamaRoot(opts.baseUrl);
  if (!root) return undefined;

  try {
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { capabilities?: string[] };
    const list = data.capabilities ?? [];
    return {
      tools: list.includes("tools"),
      vision: list.includes("vision"),
      thinking: list.includes("thinking"),
    };
  } catch {
    return undefined;
  }
}

/** Capabilities for many models at once, capped to keep the picker snappy. */
export async function ollamaCapabilitiesMany(
  opts: { baseUrl: string; models: string[]; limit?: number; concurrency?: number },
): Promise<Map<string, ModelCapabilities>> {
  const limit = opts.limit ?? 40;
  const concurrency = opts.concurrency ?? 6;
  const queue = opts.models.slice(0, limit);
  const result = new Map<string, ModelCapabilities>();

  let index = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const current = index++;
      if (current >= queue.length) return;
      const model = queue[current]!;
      const capabilities = await ollamaCapabilities({ baseUrl: opts.baseUrl, model });
      if (capabilities) result.set(model, capabilities);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}

/**
 * Small models that actually support tool calls, cheapest first.
 * Sizes are from ollama.com; quality of tool calling rises with size.
 */
export const RECOMMENDED_MODELS: Array<{ model: string; size: string; note: string }> = [
  { model: "qwen3:0.6b", size: "523 MB", note: "smallest that calls tools (verified here)" },
  { model: "qwen3:1.7b", size: "1.4 GB", note: "same family, more headroom" },
  { model: "qwen3:4b", size: "2.5 GB", note: "256K context, best small tool caller" },
];

/**
 * Models that advertise `tools` in Ollama but answer with a JSON blob in the
 * message body for Ollama 0.2x, so they cannot drive the harness. Kept as
 * data so the warning can name them instead of blaming the user.
 */
export const TOOLS_IN_NAME_ONLY = ["qwen2.5-coder:0.5b", "qwen2.5-coder:1.5b"];

export { looksLikeToolCallText } from "./tool-call-text.ts";
