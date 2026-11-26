import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mode, Rule } from "../safety/permissions.ts";

export interface Config {
  model: string;
  baseUrl: string;
  /** Read from env only; never store secrets in harness.json. */
  apiKey: string;
  contextWindow: number;
  mode: Mode;
  rules: Rule[];
  maxSteps: number;
  /** Extra CLI args appended to the provider request, e.g. {"reasoning_effort": "high"} */
  providerHeaders: Record<string, string>;
  systemPrompt: string;
}

interface ConfigFile {
  model?: string;
  baseUrl?: string;
  contextWindow?: number;
  mode?: Mode;
  rules?: Rule[];
  maxSteps?: number;
  providerHeaders?: Record<string, string>;
  systemPrompt?: string;
}

const DEFAULTS: Config = {
  model: "gpt-4.1-mini",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  contextWindow: 128_000,
  mode: "default",
  rules: [],
  maxSteps: 60,
  providerHeaders: {},
  systemPrompt: "",
};

/**
 * Config precedence: CLI flags > env > harness.json > defaults.
 * Secrets come from env only, so a repo can commit its config safely.
 */
export async function loadConfig(cwd: string, env = process.env): Promise<Config> {
  const file = await readConfigFile(join(cwd, "harness.json"));
  const config: Config = {
    ...DEFAULTS,
    ...definedOnly(file ?? {}),
    model: env.HARNESS_MODEL ?? file?.model ?? DEFAULTS.model,
    baseUrl: env.HARNESS_BASE_URL ?? env.OPENAI_BASE_URL ?? file?.baseUrl ?? DEFAULTS.baseUrl,
    apiKey: env.HARNESS_API_KEY ?? env.OPENAI_API_KEY ?? "",
    mode: (env.HARNESS_MODE as Mode | undefined) ?? file?.mode ?? DEFAULTS.mode,
    contextWindow: numberFromEnv(env.HARNESS_CONTEXT_WINDOW) ?? file?.contextWindow ?? DEFAULTS.contextWindow,
    maxSteps: numberFromEnv(env.HARNESS_MAX_STEPS) ?? file?.maxSteps ?? DEFAULTS.maxSteps,
    providerHeaders: file?.providerHeaders ?? {},
  };
  return config;
}

async function readConfigFile(path: string): Promise<ConfigFile | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as ConfigFile;
  } catch {
    return undefined;
  }
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}