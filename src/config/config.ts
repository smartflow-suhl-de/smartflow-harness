import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mode, Rule } from "../safety/permissions.ts";
import { resolveProvider, type ResolvedProvider } from "./providers.ts";

/**
 * One provider profile. Every field is optional so a profile can override just
 * one thing from a built-in preset.
 */
export interface ProviderEntry {
  baseUrl?: string;
  model?: string;
  /** Inline key. Prefer apiKeyEnv: a committed config then holds no secret. */
  apiKey?: string;
  /** Environment variable that holds the key. Defaults per built-in. */
  apiKeyEnv?: string;
  contextWindow?: number;
  headers?: Record<string, string>;
  /** Free-form label, shown in `harness providers`. */
  description?: string;
}

export interface ConfigFile {
  /** Name of the profile to use by default, e.g. "openrouter". */
  provider?: string;
  /** Named provider profiles. Any OpenAI-compatible endpoint works. */
  providers?: Record<string, ProviderEntry>;
  /** Legacy flat fields, still honoured for the default OpenAI profile. */
  model?: string;
  baseUrl?: string;
  contextWindow?: number;
  mode?: Mode;
  rules?: Rule[];
  maxSteps?: number;
  systemPrompt?: string;
}

export interface Config {
  provider: ResolvedProvider;
  mode: Mode;
  rules: Rule[];
  maxSteps: number;
  systemPrompt: string;
  /** Which config files were read, for `harness config`. */
  sources: string[];
  /** The merged config file contents (user + project). */
  file: ConfigFile;
}

/** Config sources, lowest precedence first. */
export async function configPaths(cwd: string): Promise<string[]> {
  const user = join(homedir(), ".config", "harness", "harness.json");
  return [user, join(cwd, "harness.json")];
}

/**
 * Precedence: env > project harness.json > user harness.json > defaults.
 * `providers` maps are merged shallowly (project profile wins whole).
 */
export async function readConfigFiles(cwd: string): Promise<{ file: ConfigFile; sources: string[] }> {
  const sources: string[] = [];
  const merged: ConfigFile = {};
  const providers: Record<string, ProviderEntry> = {};

  for (const path of await configPaths(cwd)) {
    const parsed = await readJson(path);
    if (!parsed) continue;
    sources.push(path);
    Object.assign(merged, stripKeys(parsed, ["providers"]));
    mergeProviders(providers, parsed.providers ?? {});
  }

  if (Object.keys(providers).length > 0) merged.providers = providers;
  return { file: merged, sources };
}

export async function loadConfig(
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; provider?: string } = {},
): Promise<Config> {
  const env = opts.env ?? process.env;
  const { file, sources } = await readConfigFiles(cwd);

  const provider = resolveProvider({ file, env, ...(opts.provider ? { providerName: opts.provider } : {}) });

  return {
    provider,
    mode: (env.HARNESS_MODE as Mode | undefined) ?? file.mode ?? "default",
    rules: file.rules ?? [],
    maxSteps: numberFromEnv(env.HARNESS_MAX_STEPS) ?? file.maxSteps ?? 60,
    systemPrompt: file.systemPrompt ?? "",
    sources,
    file,
  };
}

async function readJson(path: string): Promise<ConfigFile | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as ConfigFile;
  } catch {
    return undefined;
  }
}

function stripKeys(obj: ConfigFile, keys: string[]): ConfigFile {
  const copy = { ...obj } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as ConfigFile;
}

/**
 * Profiles merge field by field across files, so a user-level profile can hold
 * the base URL and key env while the project only names the model.
 */
function mergeProviders(into: Record<string, ProviderEntry>, from: Record<string, ProviderEntry>): void {
  for (const [name, entry] of Object.entries(from)) {
    const existing = into[name];
    into[name] = {
      ...existing,
      ...entry,
      ...(existing?.headers || entry?.headers
        ? { headers: { ...existing?.headers, ...entry?.headers } }
        : {}),
    };
  }
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}