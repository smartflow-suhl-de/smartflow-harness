/**
 * Provider failures, translated into something a user can act on.
 *
 * The raw body is kept for `--config`/debugging, but the message shown in the
 * transcript should say what to do next: pick a model, fix the key, check the
 * URL.
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly body: string;
  readonly provider: string;
  readonly model: string;

  constructor(opts: { status: number; body: string; provider: string; model: string }) {
    super(`${opts.provider} HTTP ${opts.status}: ${truncate(opts.body, 600)}`);
    this.name = "ProviderError";
    this.status = opts.status;
    this.body = opts.body;
    this.provider = opts.provider;
    this.model = opts.model;
  }
}

export interface FriendlyError {
  message: string;
  hint?: string;
  /** True when listing models from the endpoint would help. */
  suggestModels: boolean;
}

export function explainProviderError(err: unknown): FriendlyError {
  const raw = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ProviderError)) {
    return { message: raw, suggestModels: false };
  }

  const detail = extractDetail(err.body);
  const suffix = detail ? ` — ${detail}` : "";

  if (err.status === 401 || err.status === 403) {
    return {
      message: `${err.provider}: authentication failed (HTTP ${err.status})${suffix}`,
      hint: "run /connect to update the key",
      suggestModels: false,
    };
  }

  if (err.status === 404) {
    if (/model/i.test(err.body)) {
      return {
        message: `${err.provider}: model "${err.model}" is not available${suffix}`,
        hint: "run /model to pick one from this endpoint",
        suggestModels: true,
      };
    }
    return {
      message: `${err.provider}: endpoint not found (HTTP 404)${suffix}`,
      hint: "check baseUrl in harness.json (it must end in /v1)",
      suggestModels: false,
    };
  }

  if (err.status === 429) {
    return {
      message: `${err.provider}: rate limited (HTTP 429)${suffix}`,
      hint: "wait a moment or switch provider with /connect",
      suggestModels: false,
    };
  }

  if (err.status === 0) {
    return {
      message: `${err.provider}: cannot reach the endpoint${suffix}`,
      hint: "is the server running? check baseUrl with /connect",
      suggestModels: false,
    };
  }

  if (err.status >= 500) {
    return {
      message: `${err.provider}: server error (HTTP ${err.status})${suffix}`,
      hint: "retry, or check the provider's status",
      suggestModels: false,
    };
  }

  return { message: `${err.provider}: HTTP ${err.status}${suffix}`, suggestModels: false };
}

/** Pull `error.message` out of the common provider payloads. */
function extractDetail(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // Not JSON: use a trimmed snippet instead.
  }
  const text = body.trim();
  return text ? truncate(text, 160) : undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}