#!/usr/bin/env node
import { loadConfig, readConfigFiles } from "./config/config.ts";
import { loadCredentials } from "./config/credentials.ts";
import { connect } from "./ui/connect.ts";
import { ConfigError, isLocalUrl, listProviders, resolveProvider, type ResolvedProvider } from "./config/providers.ts";
import { loadContextFiles } from "./context/files.ts";
import { runAgent } from "./core/loop.ts";
import { buildSystemPrompt } from "./core/prompt.ts";
import { Session } from "./core/session.ts";
import type { AgentEvent } from "./core/types.ts";
import { OpenAiCompatibleProvider } from "./provider/openai.ts";
import { PermissionEngine } from "./safety/permissions.ts";
import { createToolRegistry } from "./tools/index.ts";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";

const VERSION = "0.1.0";
const color = useColor();
const c = {
  dim: (s: string) => color("\u001b[2m", s, "\u001b[22m"),
  bold: (s: string) => color("\u001b[1m", s, "\u001b[22m"),
  cyan: (s: string) => color("\u001b[36m", s, "\u001b[39m"),
  green: (s: string) => color("\u001b[32m", s, "\u001b[39m"),
  red: (s: string) => color("\u001b[31m", s, "\u001b[39m"),
  yellow: (s: string) => color("\u001b[33m", s, "\u001b[39m"),
};

interface Args {
  prompt?: string;
  mode?: "plan" | "default" | "yolo";
  model?: string;
  provider?: string;
  resume?: string;
  cwd: string;
  help: boolean;
  listProviders: boolean;
  showConfig: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const cwd = resolve(args.cwd);

  if (args.listProviders) {
    const { file, sources } = await readConfigFiles(cwd);
    printProviders(cwd, file, sources);
    return;
  }

  const credentials = await loadCredentials();
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(cwd, {
      ...(args.provider ? { provider: args.provider } : {}),
      credentials: credentials.providers,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${c.red("config:")} ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (args.mode) config.mode = args.mode;
  if (args.model) config.provider.model = args.model;

  let active = config.provider;
  // Built lazily: the REPL must start even with no provider connected.
  let provider: OpenAiCompatibleProvider | undefined;
  const getProvider = () => (provider ??= buildProvider(active));
  const isConnected = () => Boolean(active.apiKey) || isLocalUrl(active.baseUrl);

  if (args.showConfig) {
    printConfig(config, cwd);
    return;
  }

  const tools = createToolRegistry();
  const permissions = new PermissionEngine({ mode: config.mode, rules: config.rules, cwd });
  const contextFiles = await loadContextFiles(cwd);
  const systemPrompt = buildSystemPrompt({ cwd, tools, contextFiles, extra: config.systemPrompt });

  const session = args.resume ? await Session.load(resolve(args.resume)) : await Session.create({ cwd });

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  const ask = async (req: { tool: string; args: Record<string, unknown>; reason: string }) => {
    const detail =
      req.tool === "bash"
        ? String(req.args.command ?? "")
        : JSON.stringify(req.args).slice(0, 200);
    const answer = await rl.question(
      `\n${c.yellow("allow?")} ${c.bold(req.tool)} ${c.dim(detail)} ${c.dim(`(${req.reason})`)} [y/N/a=always] `,
    );
    const a = answer.trim().toLowerCase();
    if (a === "a" || a === "always") {
      permissions.mode = "yolo";
      return true;
    }
    return a === "y" || a === "yes";
  };

  const render = (event: AgentEvent) => {
    switch (event.type) {
      case "text":
        stdout.write(event.text.endsWith("\n") ? event.text : `${event.text}\n`);
        break;
      case "tool_start": {
        const detail =
          event.name === "bash"
            ? String(event.args.command ?? "")
            : String(event.args.path ?? event.args.pattern ?? "");
        stdout.write(`${c.dim("→")} ${c.cyan(event.name)} ${c.dim(truncate(detail, 120))}\n`);
        break;
      }
      case "tool_end":
        if (!event.ok) stdout.write(`  ${c.red("✗")} ${c.dim(event.summary ?? "failed")}\n`);
        break;
      case "compacted":
        stdout.write(c.dim(`  [compacted ${event.removedMessages} messages → ${event.summaryTokens} tokens]\n`));
        break;
      case "usage":
        stdout.write(
          c.dim(`  [tokens in ${event.usage.inputTokens} / out ${event.usage.outputTokens}]\n`),
        );
        break;
      case "error":
        stdout.write(`${c.red("error")} ${event.message}\n`);
        break;
      case "done":
        if (event.reason === "max_steps") stdout.write(c.yellow("  [step limit reached]\n"));
        if (event.reason === "stuck") stdout.write(c.yellow("  [stopped: repeated tool calls]\n"));
        break;
    }
  };

  let running = false;
  let abortController: AbortController | undefined;

  process.on("SIGINT", () => {
    if (running && abortController) {
      abortController.abort();
      stdout.write(`\n${c.dim("[interrupted]")}\n`);
      return;
    }
    stdout.write("\n");
    process.exit(0);
  });

  const runTurn = async (input: string) => {
    if (!isConnected()) {
      stdout.write(
        `${c.yellow("not connected")} — run ${c.bold("/connect")} to set up a provider\n`,
      );
      return;
    }
    await session.append({ role: "user", content: input });
    abortController = new AbortController();
    running = true;
    try {
      const result = await runAgent({
        session,
        provider: getProvider(),
        tools,
        permissions,
        systemPrompt,
        cwd,
        signal: abortController.signal,
        onEvent: render,
        ask,
        maxSteps: config.maxSteps,
      });
      if (result.reason === "error") process.exitCode = 1;
    } finally {
      running = false;
      abortController = undefined;
    }
  };

  if (args.prompt) {
    if (!isConnected()) {
      console.error(
        `${c.yellow("not connected:")} provider "${active.name}" has no key.\n` +
          `  Run ${c.bold("harness")} and use ${c.bold("/connect")}, or set ${active.keyHint}.`,
      );
      process.exitCode = 1;
      rl.close();
      return;
    }
    await runTurn(args.prompt);
    rl.close();
    return;
  }

  printBanner(active, permissions.mode, session, isConnected());
  for (;;) {
    let line: string;
    try {
      line = await rl.question(c.green("› "));
    } catch {
      break;
    }
    const input = line.trim();
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;

    if (input.startsWith("/")) {
      const [command, ...rest] = input.slice(1).split(/\s+/);
      if (command === "help") printCommands();
      else if (command === "mode") {
        const mode = rest[0];
        if (mode === "plan" || mode === "default" || mode === "yolo") {
          permissions.mode = mode;
          stdout.write(c.dim(`mode: ${mode}\n`));
        } else stdout.write(c.yellow("usage: /mode plan|default|yolo\n"));
      } else if (command === "connect") {
        const ok = await connect({
          config,
          cwd,
          io: {
            question: (q) => rl.question(q),
            write: (t) => stdout.write(t),
            secret: (q) => askSecret(rl, q),
          },
          args: rest,
        });
        if (ok) {
          config = await loadConfig(cwd, {
            credentials: (await loadCredentials()).providers,
          });
          active = config.provider;
          provider = undefined;
          permissions.mode = config.mode;
          stdout.write(c.dim(`ready: ${active.name} · ${active.model}\n`));
        }
      } else if (command === "session") {
        stdout.write(c.dim(`${session.meta.id}  ${session.path}\n`));
      } else if (command === "compact") {
        stdout.write(c.dim("compaction runs automatically before each turn\n"));
      } else {
        stdout.write(c.yellow(`unknown command: /${command} (try /help)\n`));
      }
      continue;
    }

    await runTurn(input);
  }

  rl.close();
  stdout.write(c.dim(`session: ${session.path}\n`));
}

function printBanner(
  active: ResolvedProvider,
  mode: string,
  session: Session,
  connected: boolean,
): void {
  const status = connected ? c.green("connected") : c.yellow("not connected");
  stdout.write(
    `${c.bold("harness")} ${c.dim(VERSION)}  ${c.dim("provider")} ${active.name}  ${c.dim("model")} ${active.model}  ${c.dim("mode")} ${mode}  ${status}\n`,
  );
  if (!connected) {
    stdout.write(
      `${c.dim(`  no key for "${active.name}". run `)}${c.bold("/connect")}${c.dim(" to set one up · /help for commands")}\n`,
    );
  } else {
    stdout.write(c.dim(`  session ${session.meta.id} · /help for commands · ctrl+c to interrupt`) + "\n");
  }
  stdout.write("\n");
}

/** Read a key without echoing it. Falls back to plain input when not a TTY. */
async function askSecret(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return rl.question(prompt);

  return new Promise<string>((resolvePromise) => {
    stdout.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    let value = "";
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        const ch = String.fromCharCode(byte);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolvePromise(value);
          return;
        }
        if (byte === 3) {
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte < 32) continue;
        value += ch;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
    };
    stdin.on("data", onData);
  });
}

function printCommands(): void {
  stdout.write(
    [
      "/help              show this help",
      "/connect [name|url]  set up a provider: key, endpoint, test, save",
      "/mode plan|default|yolo   switch permission mode",
      "/session           show session id and transcript path",
      "/exit              quit",
      "",
    ].join("\n"),
  );
}

function buildProvider(resolved: ResolvedProvider): OpenAiCompatibleProvider {
  const credential = resolved.apiKey;
  return new OpenAiCompatibleProvider({
    name: resolved.name,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    apiKey: credential,
    contextWindow: resolved.contextWindow,
    headers: resolved.headers,
  });
}

function printProviders(
  cwd: string,
  file: import("./config/config.ts").ConfigFile,
  sources: string[],
): void {
  const active = process.env.HARNESS_PROVIDER ?? file.provider ?? "openai";

  stdout.write(`${c.bold("providers")} ${c.dim(`(${cwd})`)}\n\n`);
  for (const { name, origin } of listProviders(file)) {
    const mark = name === active ? c.green("●") : c.dim("○");
    const tag = origin === "config" ? c.cyan("config") : c.dim("builtin");
    const entry = file.providers?.[name];
    const detail = entry?.baseUrl ?? entry?.model ?? "";
    stdout.write(`  ${mark} ${name.padEnd(14)} ${tag} ${c.dim(detail)}\n`);
  }
  if (sources.length === 0) {
    stdout.write(`\n${c.dim("no harness.json found; using built-in presets only")}\n`);
  } else {
    stdout.write(`\n${c.dim(`sources: ${sources.join(", ")}`)}\n`);
  }
  stdout.write(`\n${c.dim("use with: --provider <name>   or   HARNESS_PROVIDER=<name>")}\n`);
}

function printConfig(config: import("./config/config.ts").Config, cwd: string): void {
  const p = config.provider;
  stdout.write(
    [
      `${c.bold("provider")}  ${p.name}${p.builtin ? c.dim(" (builtin)") : ""}`,
      `${c.bold("baseUrl")}   ${p.baseUrl}`,
      `${c.bold("model")}     ${p.model}`,
      `${c.bold("context")}   ${p.contextWindow} tokens`,
      `${c.bold("apiKey")}    ${keyStatus(p)}`,
      `${c.bold("mode")}      ${config.mode}`,
      `${c.bold("maxSteps")}  ${config.maxSteps}`,
      `${c.bold("rules")}     ${config.rules.length}`,
      ...(Object.keys(p.headers).length
        ? [`${c.bold("headers")}   ${Object.keys(p.headers).join(", ")}`]
        : []),
      `${c.bold("sources")}   ${config.sources.length ? config.sources.join(", ") : c.dim("none")}`,
      `${c.bold("cwd")}       ${cwd}`,
    ].join("\n") + "\n",
  );
}

function keyStatus(p: ResolvedProvider): string {
  switch (p.keySource) {
    case "env":
      return `${c.green("set")} ${c.dim("from HARNESS_API_KEY")}`;
    case "apiKeyEnv":
      return `${c.green("set")} ${c.dim(`from $${p.apiKeyEnv ?? "env"}`)}`;
    case "stored":
      return `${c.green("set")} ${c.dim("from credentials store")}`;
    case "inline":
      return `${c.green("set")} ${c.dim("inline in harness.json")}`;
    case "none":
      return isLocalUrl(p.baseUrl)
        ? c.dim("not needed (local endpoint)")
        : `${c.red("missing")} ${c.dim(`run /connect or set ${p.keyHint}`)}`;
  }
}

function printHelp(): void {
  stdout.write(`harness ${VERSION} — a minimal coding agent

Usage
  harness [prompt] [options]

Options
  --provider <name>            provider profile (see --list-providers)
  --model <name>               model id (overrides the profile)
  --mode <plan|default|yolo>   permission mode (default: default)
  --resume <session.jsonl>     resume a transcript
  --cwd <dir>                  workspace (default: current directory)
  --list-providers             list built-in and configured providers
  --config                     show the resolved configuration
  -h, --help                   show this help

Environment
  HARNESS_PROVIDER        profile name from harness.json (default: openai)
  HARNESS_API_KEY         key for any provider (overrides the profile's env)
  HARNESS_BASE_URL        OpenAI-compatible base URL
  HARNESS_MODEL           model id
  HARNESS_MODE            permission mode
  HARNESS_CONTEXT_WINDOW  context window in tokens

Config
  ~/.config/harness/harness.json   user-level profiles
  ./harness.json                   project profiles (wins)

  {
    "provider": "my-gateway",
    "providers": {
      "my-gateway": {
        "baseUrl": "https://llm.example.com/v1",
        "model": "qwen3-coder",
        "apiKeyEnv": "GATEWAY_KEY",
        "contextWindow": 131072,
        "headers": { "X-Org": "cabroe" }
      }
    }
  }

  Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Groq, Mistral,
  Ollama, vLLM, LM Studio, LiteLLM, gateways). Secrets stay in env: set
  apiKeyEnv, not apiKey.
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cwd: process.cwd(),
    help: false,
    listProviders: false,
    showConfig: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--provider" || arg === "-p") args.provider = argv[++i];
    else if (arg === "--list-providers") args.listProviders = true;
    else if (arg === "--config") args.showConfig = true;
    else if (arg === "--mode") args.mode = argv[++i] as Args["mode"];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--resume") args.resume = argv[++i];
    else if (arg === "--cwd") args.cwd = argv[++i] ?? process.cwd();
    else if (arg === "--plan") args.mode = "plan";
    else if (arg === "--yolo") args.mode = "yolo";
    else if (!arg.startsWith("-")) args.prompt = args.prompt ? `${args.prompt} ${arg}` : arg;
    else throw new Error(`unknown option ${arg}`);
  }
  return args;
}

function useColor(): (open: string, text: string, close: string) => string {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return (_o, text) => text;
  return (open, text, close) => `${open}${text}${close}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

main().catch((err) => {
  console.error(c.red("fatal:"), err instanceof Error ? err.message : err);
  process.exit(1);
});