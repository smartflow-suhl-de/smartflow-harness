import type { ConfigFile, ProviderEntry } from "./config.ts";

/**
 * Built-in provider presets.
 *
 * A preset is just a named default: anything in `harness.json` under
 * `providers.<name>` overrides it field by field. Add your own provider
 * without touching code — that is the point.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderEntry> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    contextWindow: 128_000,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4.6",
    apiKeyEnv: "OPENROUTER_API_KEY",
    contextWindow: 200_000,
    headers: {
      "HTTP-Referer": "https://github.com/local/harness",
      "X-Title": "harness",
    },
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    apiKeyEnv: "GROQ_API_KEY",
    contextWindow: 128_000,
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    apiKeyEnv: "MISTRAL_API_KEY",
    contextWindow: 128_000,
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3-coder",
    contextWindow: 32_768,
  },
  lmstudio: {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    contextWindow: 32_768,
  },
};

export interface ResolvedProvider {
  /** Name as selected by the user, e.g. "openrouter" or "my-gateway". */
  name: string;
  /** True when the name came from the built-in table. */
  builtin: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnv?: string;
  contextWindow: number;
  headers: Record<string, string>;
  /** Environment variable hints shown when the key is missing. */
  keyHint: string;
}

export class ConfigError extends Error {}

/**
 * Resolve the active provider.
 *
 * Precedence, highest first:
 *   1. explicit CLI selection  (`--provider`)
 *   2. HARNESS_* environment overrides (model, base URL, key, window)
 *   3. `providers.<name>` in harness.json
 *   4. built-in preset for that name
 *   5. legacy flat fields (`model`, `baseUrl`) in harness.json
 */
export function resolveProvider(opts: {
  file?: ConfigFile;
  env?: NodeJS.ProcessEnv;
  providerName?: string;
}): ResolvedProvider {
  const env = opts.env ?? process.env;
  const file = opts.file ?? {};
  const providers = file.providers ?? {};

  const selected =
    opts.providerName ??
    env.HARNESS_PROVIDER ??
    file.provider ??
    (file.baseUrl || env.HARNESS_BASE_URL ? "custom" : "openai");

  const entry = providers[selected];
  const builtin = BUILTIN_PROVIDERS[selected];
  const isCustomName = selected === "custom" || (entry !== undefined && builtin === undefined);

  if (!entry && !builtin && !(isCustomName && (file.baseUrl || env.HARNESS_BASE_URL))) {
    throw new ConfigError(
      `Unknown provider "${selected}". ` +
        `Available: ${[...new Set([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(providers)])].join(", ")}. ` +
        `Define it under "providers" in harness.json.`,
    );
  }

  // Legacy flat config: applies only when no named profile was chosen.
  const legacy: ProviderEntry =
    !entry && !builtin && !opts.providerName && !env.HARNESS_PROVIDER
      ? defined({ baseUrl: file.baseUrl, model: file.model, contextWindow: file.contextWindow })
      : {};

  const merged: ProviderEntry = { ...(builtin ?? {}), ...legacy, ...(entry ?? {}) };

  const apiKeyEnv = merged.apiKeyEnv ?? (selected === "openai" ? "OPENAI_API_KEY" : undefined);
  const apiKey =
    env.HARNESS_API_KEY ??
    (merged.apiKeyEnv ? env[merged.apiKeyEnv] : undefined) ??
    env.OPENAI_API_KEY ??
    merged.apiKey ??
    "";

  const baseUrl = env.HARNESS_BASE_URL ?? env.OPENAI_BASE_URL ?? merged.baseUrl;
  if (!baseUrl) {
    throw new ConfigError(
      `Provider "${selected}" has no baseUrl. Set it in harness.json under providers.${selected}.baseUrl ` +
        `or via HARNESS_BASE_URL.`,
    );
  }

  const contextWindow =
    numberFromEnv(env.HARNESS_CONTEXT_WINDOW) ?? merged.contextWindow ?? 128_000;

  const name = selected;

  return {
    name,
    builtin: builtin !== undefined && entry === undefined,
    baseUrl,
    model: env.HARNESS_MODEL ?? merged.model ?? "gpt-4.1-mini",
    apiKey,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    contextWindow,
    headers: { ...(merged.headers ?? {}) },
    keyHint: apiKeyEnv ? `$${apiKeyEnv}` : 'harness.json providers.<name>.apiKeyEnv',
  };
}

export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(url);
}

/** Providers the user can pick from, built-ins plus harness.json entries. */
export function listProviders(file?: ConfigFile): Array<{ name: string; origin: "builtin" | "config" }> {
  const names = new Set([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(file?.providers ?? {})]);
  return [...names].sort().map((name) => ({
    name,
    origin: file?.providers?.[name] ? "config" : "builtin",
  }));
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}