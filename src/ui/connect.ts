import { loadCredentials, saveCredential } from "../config/credentials.ts";
import { saveUserConfig, type Config, type ProviderEntry } from "../config/config.ts";
import { BUILTIN_PROVIDERS, isLocalUrl, listProviders } from "../config/providers.ts";
import { probeProvider } from "../provider/probe.ts";

export interface ConnectIO {
  /** Resolves to undefined when the user cancelled (Ctrl+C). */
  question(prompt: string): Promise<string | undefined>;
  /** Masked input. Falls back to `question` when the terminal cannot hide. */
  secret?(prompt: string): Promise<string | undefined>;
  write(text: string): void;
}

export type ConnectResult = boolean;

/**
 * `/connect` — the one command for provider setup.
 *
 *   /connect                      pick from the list, then answer the prompts
 *   /connect openrouter           use a known profile, ask only what is missing
 *   /connect https://llm.x/v1     add an ad-hoc endpoint
 *
 * Safe to re-run: that is the recovery path after a failed start.
 */
export async function connect(opts: {
  config: Config;
  cwd: string;
  io: ConnectIO;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Called with the model ids discovered from the endpoint. */
  onModels?: (models: string[]) => void;
}): Promise<ConnectResult> {
  const env = opts.env ?? process.env;
  const { io, config } = opts;

  const chosen = await chooseProfile(config, opts.args, io);
  if (!chosen) return false;

  const existing = config.file.providers?.[chosen.name] ?? {};
  const preset = BUILTIN_PROVIDERS[chosen.name];

  const baseUrl = chosen.url ?? existing.baseUrl ?? preset?.baseUrl ?? (await askBaseUrl(io, chosen.name));
  if (!baseUrl) {
    io.write("aborted: no base URL\n");
    return false;
  }

  const local = isLocalUrl(baseUrl);
  const apiKeyEnv = existing.apiKeyEnv ?? defaultKeyEnv(chosen.name);

  // Remote endpoints need a key up front. Local ones are probed without one
  // first: most need none, but a local gateway (LiteLLM, vLLM with auth) can
  // still answer 401, and then we ask.
  let apiKey = "";
  if (!local) {
    apiKey = await resolveKey({ io, env, name: chosen.name, apiKeyEnv });
    if (!apiKey) return false;
  }

  const exploreModel = existing.model ?? preset?.model ?? "";
  io.write(`testing ${chosen.name} at ${baseUrl} … `);
  let probe = await probeProvider({
    name: chosen.name,
    baseUrl,
    model: exploreModel || "probe",
    apiKey,
    headers: existing.headers ?? {},
  });

  if (!probe.ok && local && /key rejected/.test(probe.message)) {
    io.write("key required\n");
    apiKey = await resolveKey({ io, env, name: chosen.name, apiKeyEnv: localKeyEnv(chosen.name, apiKeyEnv) });
    if (!apiKey) return false;
    io.write(`retrying … `);
    probe = await probeProvider({
      name: chosen.name,
      baseUrl,
      model: exploreModel || "probe",
      apiKey,
      headers: existing.headers ?? {},
    });
  }

  io.write(`${probe.ok ? "ok" : "failed"} (${probe.message})\n`);
  if (probe.models && probe.models.length > 0) opts.onModels?.(probe.models);

  if (!probe.ok) {
    const saveAnyway = await confirm(io, "save anyway?", false);
    if (saveAnyway !== true) {
      io.write("cancelled\n");
      return false;
    }
  }

  const model =
    existing.model ??
    preset?.model ??
    (await chooseModel(io, probe.models ?? [], chosen.name));
  if (!model) {
    io.write("aborted: no model\n");
    return false;
  }

  const entry: ProviderEntry = {
    baseUrl,
    model,
    ...(apiKey ? { apiKeyEnv } : {}),
    ...(existing.contextWindow !== undefined ? { contextWindow: existing.contextWindow } : {}),
    ...(existing.headers ? { headers: existing.headers } : {}),
  };

  const path = await saveUserConfig({ provider: chosen.name, providers: { [chosen.name]: entry } }, env);
  if (apiKey) await saveCredential(chosen.name, apiKey, env);

  io.write(
    `connected: ${chosen.name} · ${model} · ${baseUrl}\n` +
      `saved to ${path}${apiKey ? " · key stored in ~/.config/harness/credentials.json" : ""}\n`,
  );
  return true;
}

function localKeyEnv(name: string, fallback: string): string {
  return fallback || defaultKeyEnv(name);
}

/**
 * Pick a model from the endpoint's list. Numbered choice when there are many,
 * a plain suggestion when there is exactly one.
 */
async function askBaseUrl(io: ConnectIO, name: string): Promise<string | undefined> {
  const answer = (
    await io.question(`base URL for "${name}" (OpenAI-compatible, e.g. https://api.example.com/v1): `)
  )?.trim();
  if (!answer) return undefined;
  if (!/^https?:\/\//.test(answer)) {
    io.write("expected an http(s) URL\n");
    return undefined;
  }
  return answer;
}

async function chooseModel(io: ConnectIO, models: string[], name: string): Promise<string | undefined> {
  if (models.length === 0) {
    const answer = (await io.question(`model id for ${name}: `))?.trim();
    return answer || undefined;
  }

  const preferred = models.find((m) => /coder|code|instruct/i.test(m)) ?? models[0]!;
  if (models.length === 1) {
    io.write(`model: ${preferred}\n`);
    return preferred;
  }

  const shown = models.slice(0, 20);
  io.write(`models:\n`);
  shown.forEach((m, i) => io.write(`  ${String(i + 1).padStart(2)}) ${m}${m === preferred ? "  ←" : ""}\n`));
  const answer = (await io.question(`pick a model [1-${shown.length}, default 1]: `))?.trim();
  if (answer === undefined) return undefined;
  if (!answer) return preferred;

  const index = Number(answer) - 1;
  if (Number.isInteger(index) && index >= 0 && index < shown.length) return shown[index]!;
  return answer;
}

interface Chosen {
  name: string;
  url?: string;
}

async function chooseProfile(config: Config, args: string[], io: ConnectIO): Promise<Chosen | undefined> {
  const first = args[0];

  if (first && /^https?:\/\//.test(first)) {
    const name = args[1] ?? "custom";
    return { name, url: first };
  }
  if (first) return { name: first };

  const known = listProviders(config.file).filter((p) => p.name !== "custom");
  const active = config.provider.name;

  io.write(`providers (${active} active):\n`);
  for (const { name, origin } of known) {
    const mark = name === active ? "*" : " ";
    const preset = BUILTIN_PROVIDERS[name];
    const entry = config.file.providers?.[name];
    const hint = entry?.baseUrl ?? preset?.baseUrl ?? "";
    io.write(` ${mark} ${name.padEnd(12)} ${origin === "config" ? "(configured)" : ""} ${hint}\n`);
  }
  const answer = await io.question(`connect to which provider? [${active}] `);
  if (answer === undefined) return undefined;
  return { name: answer.trim() || active };
}


async function resolveKey(opts: {
  io: ConnectIO;
  env: NodeJS.ProcessEnv;
  name: string;
  apiKeyEnv: string;
}): Promise<string> {
  const { io, env, name, apiKeyEnv } = opts;

  const fromEnv = env[apiKeyEnv] ?? env.HARNESS_API_KEY;
  if (fromEnv) {
    io.write(`using key from $${apiKeyEnv}\n`);
    return fromEnv;
  }

  const stored = (await loadCredentials(env)).providers[name]?.apiKey;
  if (stored) {
    const reuse = await confirm(io, "reuse the stored key?", true);
    if (reuse === undefined) return "";
    if (reuse) return stored;
  }

  const prompt = `API key for ${name}: `;
  const answer = io.secret ? await io.secret(prompt) : await io.question(prompt);
  return (answer ?? "").trim();
}


async function confirm(
  io: ConnectIO,
  question: string,
  fallback: boolean,
): Promise<boolean | undefined> {
  const raw = await io.question(`${question} [${fallback ? "Y/n" : "y/N"}] `);
  if (raw === undefined) return undefined;
  const answer = raw.trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

function defaultKeyEnv(name: string): string {
  if (name === "openai") return "OPENAI_API_KEY";
  return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}