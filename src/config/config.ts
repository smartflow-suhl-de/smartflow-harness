import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
export async function configPaths(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const home = env.HARNESS_HOME ?? join(homedir(), ".config", "harness");
  return [join(home, "harness.json"), join(cwd, "harness.json")];
}

/**
 * Precedence: env > project harness.json > user harness.json > defaults.
 * `providers` maps are merged shallowly (project profile wins whole).
 */
export async function readConfigFiles(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ file: ConfigFile; sources: string[] }> {
  const sources: string[] = [];
  const merged: ConfigFile = {};
  const providers: Record<string, ProviderEntry> = {};

  for (const path of await configPaths(cwd, env)) {
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
  opts: {
    env?: NodeJS.ProcessEnv;
    provider?: string;
    credentials?: Record<string, { apiKey?: string }>;
  } = {},
): Promise<Config> {
  const env = opts.env ?? process.env;
  const { file, sources } = await readConfigFiles(cwd, env);

  const provider = resolveProvider({
    file,
    env,
    ...(opts.provider ? { providerName: opts.provider } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });

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

/**
 * Persist profile changes made by `/connect`. Writes only the user-level file,
 * so a project config stays untouched and keeps winning where it sets fields.
 */
export async function saveUserConfig(
  patch: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = env.HARNESS_HOME ?? join(homedir(), ".config", "harness");
  return mergeIntoConfig(join(dir, "harness.json"), patch);
}

/** Merge a patch into the project file at `<cwd>/harness.json`. */
export async function saveProjectConfig(cwd: string, patch: ConfigFile): Promise<string> {
  return mergeIntoConfig(join(cwd, "harness.json"), patch);
}

/**
 * Persist a model choice where it actually takes effect.
 *
 * If the project file defines this profile, writing to the user file would be
 * silently overridden on the next start, so the project file wins here too.
 */
export async function saveProviderModel(
  name: string,
  model: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const projectPath = join(cwd, "harness.json");
  const project = await readJson(projectPath);
  if (project?.providers?.[name]) {
    return mergeIntoConfig(projectPath, { providers: { [name]: { model } } });
  }
  return saveUserConfig({ providers: { [name]: { model } } }, env);
}

async function mergeIntoConfig(path: string, patch: ConfigFile): Promise<string> {
  const existing = (await readJson(path)) ?? {};

  const providers: Record<string, ProviderEntry> = { ...(existing.providers ?? {}) };
  for (const [name, entry] of Object.entries(patch.providers ?? {})) {
    providers[name] = { ...providers[name], ...entry };
  }

  const next: ConfigFile = { ...existing, ...stripKeys(patch, ["providers"]) };
  if (Object.keys(providers).length > 0) next.providers = providers;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return path;
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