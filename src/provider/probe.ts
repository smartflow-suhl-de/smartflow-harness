/**
 * Cheap connectivity check used by `/connect` before committing a profile.
 *
 * Tries GET /models first (free on most gateways). If that is not supported,
 * falls back to a one-token completion. Never throws: the caller decides
 * whether a failed probe is fatal.
 */
export interface ProbeTarget {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface ProbeResult {
  ok: boolean;
  /** Short, human-readable outcome for the CLI. */
  message: string;
  /** Model ids reported by /models, when available. */
  models?: string[];
}

export async function probeProvider(target: ProbeTarget, timeoutMs = 15_000): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
    ...target.headers,
  };
  const base = target.baseUrl.replace(/\/+$/, "");

  const list = await request(`${base}/models`, { method: "GET", headers }, timeoutMs);
  if (list.status === 200) {
    const models = extractModels(list.body);
    return {
      ok: true,
      message: models.length
        ? `connected · ${models.length} models`
        : "connected",
      ...(models.length ? { models } : {}),
    };
  }
  if (list.status === 401 || list.status === 403) {
    return { ok: false, message: `key rejected (HTTP ${list.status})` };
  }

  const chat = await request(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
      }),
    },
    timeoutMs,
  );

  if (chat.status === 200) return { ok: true, message: "connected" };
  if (chat.status === 401 || chat.status === 403) {
    return { ok: false, message: `key rejected (HTTP ${chat.status})` };
  }
  if (chat.status === 404) {
    return { ok: false, message: `model "${target.model}" not found (HTTP 404)` };
  }
  return { ok: false, message: `endpoint answered HTTP ${chat.status}: ${truncate(chat.body, 160)}` };
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: (err as Error).message };
  }
}

function extractModels(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    if (Array.isArray(parsed.data)) {
      return parsed.data.map((m) => m.id).filter((id): id is string => typeof id === "string");
    }
    if (Array.isArray(parsed.models)) {
      return parsed.models.map((m) => m.name).filter((id): id is string => typeof id === "string");
    }
  } catch {
    // Not JSON (some proxies); treat as "connected, no list".
  }
  return [];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}