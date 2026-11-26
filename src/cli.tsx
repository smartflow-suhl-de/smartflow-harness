#!/usr/bin/env node
import { loadConfig, readConfigFiles, saveProviderModel } from "./config/config.ts";
import { loadCredentials } from "./config/credentials.ts";
import { connect } from "./ui/connect.ts";
import {
  ConfigError,
  isLocalUrl,
  listProviders,
  type ResolvedProvider,
} from "./config/providers.ts";
import { loadContextFiles } from "./context/files.ts";
import { runAgent } from "./core/loop.ts";
import { buildSystemPrompt } from "./core/prompt.ts";
import { Session } from "./core/session.ts";
import type { AgentEvent } from "./core/types.ts";
import { OpenAiCompatibleProvider } from "./provider/openai.ts";
import { explainProviderError } from "./provider/errors.ts";
import { fetchModels } from "./provider/probe.ts";
import {
  ollamaCapabilities,
  ollamaCapabilitiesMany,
  ollamaRoot,
  RECOMMENDED_MODELS,
  TOOLS_IN_NAME_ONLY,
  type ModelCapabilities,
} from "./provider/ollama.ts";
import { PermissionEngine } from "./safety/permissions.ts";
import { createToolRegistry } from "./tools/index.ts";
import { stdin, stdout } from "node:process";
import { createCompleter, createListCompleter, COMMANDS, KEY_HELP } from "./ui/commands.ts";
import { clearScreen, createInkUi } from "./ui/ink-ui.tsx";
import { createPlainUi } from "./ui/plain-ui.ts";
import { loadHistory, pushHistory, saveHistory } from "./ui/history.ts";
import type { Ui } from "./ui/ui.ts";
import type { Status } from "./ui/store.ts";
import { resolve } from "node:path";
import { runInit } from "./init.ts";

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
  init: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const cwd = resolve(args.cwd);

  if (args.init) {
    if (!stdin.isTTY || !stdout.isTTY) {
      console.error(
        `${c.red("init needs a terminal.")} Run ${c.bold("harness")} and use ${c.bold("/connect")}, ` +
          `or write harness.json by hand.`,
      );
      process.exitCode = 1;
      return;
    }
    const { file } = await readConfigFiles(cwd);
    const ink = createInkUi({
      provider: args.provider ?? file.provider ?? "openai",
      model: "",
      mode: "default",
      connected: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    const done = await runInit({
      cwd,
      ui: ink.ui,
      ...(args.provider ? { provider: args.provider } : {}),
    });
    await ink.unmount();
    if (!done) process.exitCode = 1;
    return;
  }

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

  if (args.showConfig) {
    printConfig(config, cwd);
    return;
  }

  const modelSuggestions: string[] = [];
  let active = config.provider;
  let provider: OpenAiCompatibleProvider | undefined;
  const note = (message: string) => ui.addItem("notice", message);
  const getProvider = () => (provider ??= buildProvider(active, note));
  const isConnected = () => Boolean(active.apiKey) || isLocalUrl(active.baseUrl);

  /** Ask the endpoint which models it has; fills the /model completion list. */
  const refreshModels = async (): Promise<string[]> => {
    if (!isConnected()) return [];
    const result = await fetchModels({
      baseUrl: active.baseUrl,
      apiKey: active.apiKey,
      headers: active.headers,
    });
    if (result.ok && result.models.length > 0) {
      // Tool-capable models first: the whole point of /model is to pick one
      // that can act, not just one that answers.
      if (ollamaRoot(active.baseUrl)) {
        const capabilities = await ollamaCapabilitiesMany({
          baseUrl: active.baseUrl,
          models: result.models,
        });
        for (const [model, entry] of capabilities) toolSupport.set(model, entry);
      }
      const ordered = [...result.models].sort((a, b) => {
        const left = canUseTools(a);
        const right = canUseTools(b);
        return Number(right === true) - Number(left === true);
      });
      modelSuggestions.splice(0, modelSuggestions.length, ...ordered);
      return ordered;
    }
    return [];
  };

  const setModel = async (id: string): Promise<void> => {
    active = { ...active, model: id };
    provider = buildProvider(active, note);
    ui.updateStatus({ model: id });
    const path = await saveProviderModel(active.name, id, cwd);
    ui.addItem("notice", `model: ${id} · saved in ${path}`);
    void warnIfNoTools(id);
  };

  const tools = createToolRegistry();
  const permissions = new PermissionEngine({ mode: config.mode, rules: config.rules, cwd });
  const contextFiles = await loadContextFiles(cwd);
  const systemPrompt = buildSystemPrompt({ cwd, tools, contextFiles, extra: config.systemPrompt });
  const session = args.resume ? await Session.load(resolve(args.resume)) : await Session.create({ cwd });

  const completer = createCompleter({
    providers: () => listProviders(config.file).map((p) => p.name),
    models: () => modelSuggestions,
  });
  const toolSupport = new Map<string, ModelCapabilities>();

  const canUseTools = (model: string): boolean | undefined => toolSupport.get(model)?.tools;

  const recommended = (): string =>
    RECOMMENDED_MODELS.slice(0, 3)
      .map((entry) => `${entry.model} (${entry.size})`)
      .join(", ");

  /** Warn when the active model cannot call tools, pointing at cheap ones. */
  const warnIfNoTools = async (model: string): Promise<void> => {
    const capabilities = await ollamaCapabilities({ baseUrl: active.baseUrl, model });
    if (!capabilities) return; // not Ollama, or an older server
    toolSupport.set(model, capabilities);

    if (capabilities.tools && !TOOLS_IN_NAME_ONLY.includes(model)) return;

    const reason = capabilities.tools
      ? `"${model}" advertises tools but returns the call as text`
      : `"${model}" cannot call tools`;
    ui.addItem("notice", `${reason}. Small tool-capable models: ${recommended()}`);
  };

  const modelCompleter = createListCompleter(
    () => modelSuggestions,
    (model) => {
      if (TOOLS_IN_NAME_ONLY.includes(model)) return "tool calls as text";
      const tools = canUseTools(model);
      if (tools === undefined) return undefined;
      return tools ? "tools" : "no tools";
    },
  );

  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  const ink = interactive ? createInkUi(statusOf(active, permissions.mode, isConnected())) : undefined;
  const ui: Ui = ink?.ui ?? createPlainUi();

  const history = await loadHistory();

  let abortController: AbortController | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  ui.onInterrupt(() => abortController?.abort());

  const permissionPrompt = async (req: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  }): Promise<boolean> => {
    const detail =
      req.tool === "bash"
        ? String(req.args.command ?? "")
        : JSON.stringify(req.args).slice(0, 200);
    const answer = await ui.ask(
      `allow ${req.tool}? ${detail} (${req.reason}) [y/N/a=always] `,
      { tone: "question" },
    );
    if (answer.type === "cancel") return false;
    const value = answer.value.trim().toLowerCase();
    if (value === "a" || value === "always") {
      permissions.mode = "yolo";
      return true;
    }
    return value === "y" || value === "yes";
  };

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "text":
        if (event.text.trim()) ui.addItem("assistant", event.text.trim());
        break;
      case "tool_start": {
        const detail =
          event.name === "bash"
            ? String(event.args.command ?? "")
            : String(event.args.path ?? event.args.pattern ?? "");
        ui.setLive(`${event.name} ${truncate(detail, 120)}`);
        break;
      }
      case "tool_end":
        ui.setLive(null);
        ui.addItem("tool", event.summary ?? "", { label: event.name, ok: event.ok });
        break;
      case "compacted":
        ui.addItem(
          "notice",
          `compacted ${event.removedMessages} messages → ${event.summaryTokens} tokens`,
        );
        break;
      case "usage":
        inputTokens += event.usage.inputTokens;
        outputTokens += event.usage.outputTokens;
        ui.updateStatus({ inputTokens, outputTokens });
        break;
      case "notice":
        ui.addItem("notice", event.message);
        break;
      case "error": {
        const friendly = explainProviderError(event.cause ?? event.message);
        ui.addItem("error", friendly.message);
        if (friendly.hint) ui.addItem("notice", friendly.hint);
        if (friendly.suggestModels) {
          void refreshModels().then((models) => {
            if (models.length > 0) {
              ui.addItem("notice", `available: ${models.slice(0, 8).join(", ")}${models.length > 8 ? ", …" : ""}`);
            }
          });
        }
        break;
      }
      case "done":
        if (event.reason === "max_steps") ui.addItem("notice", "step limit reached");
        if (event.reason === "stuck") ui.addItem("notice", "stopped: repeated tool calls");
        break;
    }
  };

  const runTurn = async (input: string): Promise<"stop" | "max_steps" | "stuck" | "aborted" | "error"> => {
    if (!isConnected()) {
      ui.addItem("notice", "not connected — run /connect to set up a provider");
      return "stop";
    }
    ui.addItem("user", input);
    await session.append({ role: "user", content: input });

    abortController = new AbortController();
    ui.setBusy(true);
    try {
      const result = await runAgent({
        session,
        provider: getProvider(),
        tools,
        permissions,
        systemPrompt,
        cwd,
        signal: abortController.signal,
        onEvent,
        ask: permissionPrompt,
        maxSteps: config.maxSteps,
      });
      if (result.reason === "aborted") ui.addItem("notice", "interrupted");
      // A failed turn must not change the process exit code: Ctrl+C later
      // would then look like a crash to wrappers such as `npm run dev`.
      return result.reason;
    } finally {
      abortController = undefined;
      ui.setBusy(false);
      ui.setLive(null);
    }
  };

  const banner = (): void => {
    ui.addItem(
      "notice",
      `harness ${VERSION} · ${active.name} · ${active.model} · ${permissions.mode} · ${
        isConnected() ? "connected" : "not connected"
      }`,
    );
    if (!isConnected()) {
      ui.addItem("notice", `no key for "${active.name}" — /connect to set one up · /help for commands`);
    } else {
      ui.addItem("notice", `session ${session.meta.id} · /help for commands`);
    }
  };

  if (args.prompt) {
    if (!isConnected()) {
      ui.addItem(
        "error",
        `provider "${active.name}" has no key. Run /connect or set ${active.keyHint}.`,
      );
      process.exitCode = 1;
      await ui.dispose();
      return;
    }
    const reason = await runTurn(args.prompt);
    if (reason === "error") process.exitCode = 1;
    await ui.dispose();
    return;
  }

  banner();
  if (isConnected()) void warnIfNoTools(active.model);

  for (;;) {
    const result = await ui.ask("› ", {
      tone: "prompt",
      history,
      completer,
      placeholder: isConnected() ? "message, or /help" : "not connected — /connect",
    });
    if (result.type === "cancel") break;

    const input = result.value.trim();
    if (!input) continue;

    if (input !== "/exit" && input !== "/quit") {
      pushHistory(history, result.value);
      void saveHistory(history);
    }

    if (input === "/exit" || input === "/quit") break;

    if (input.startsWith("/")) {
      const [command, ...rest] = input.slice(1).split(/\s+/);

      if (command === "help") {
        printCommands(ui);
      } else if (command === "mode") {
        const mode = rest[0];
        if (mode === "plan" || mode === "default" || mode === "yolo") {
          permissions.mode = mode;
          ui.updateStatus({ mode });
          ui.addItem("notice", `mode: ${mode}`);
        } else {
          ui.addItem("error", "usage: /mode plan|default|yolo");
        }
      } else if (command === "connect") {
        ui.setBusy(true);
        try {
          const ok = await connect({
            config,
            cwd,
            io: {
              question: async (question) => {
                const answer = await ui.ask(question, { tone: "question" });
                return answer.type === "value" ? answer.value : undefined;
              },
              secret: async (question) => {
                const answer = await ui.ask(question, { tone: "question", mask: true });
                return answer.type === "value" ? answer.value : undefined;
              },
              write: lineWriter(ui),
            },
            args: rest,
            onModels: (models) => {
              modelSuggestions.splice(0, modelSuggestions.length, ...models);
            },
          });
          if (ok) {
            config = await loadConfig(cwd, {
              credentials: (await loadCredentials()).providers,
            });
            active = config.provider;
            provider = undefined;
            void note;
            permissions.mode = config.mode;
            ui.updateStatus({
              provider: active.name,
              model: active.model,
              mode: permissions.mode,
              connected: isConnected(),
            });
            ui.addItem("notice", `ready: ${active.name} · ${active.model}`);
            void warnIfNoTools(active.model);
          }
        } finally {
          ui.setBusy(false);
        }
      } else if (command === "session") {
        ui.addItem("notice", `${session.meta.id}  ${session.path}`);
      } else if (command === "model") {
        if (rest[0]) {
          await setModel(rest[0]);
          continue;
        }

        ui.addItem("notice", `${active.name} · ${active.model}`);
        ui.setBusy(true);
        const models = await refreshModels();
        ui.setBusy(false);

        if (models.length === 0) {
          ui.addItem("notice", "this endpoint does not list models; use /model <id>");
          continue;
        }
        const answer = await ui.ask("model: ", {
          tone: "question",
          completer: modelCompleter,
          placeholder: `${models.length} available · tab to pick`,
        });
        if (answer.type === "cancel") continue;
        const chosen = answer.value.trim();
        if (!chosen) continue;
        if (!models.includes(chosen)) {
          ui.addItem("notice", `"${chosen}" was not in the list — using it anyway`);
        }
        await setModel(chosen);
      } else if (command === "clear") {
        clearScreen();
        ui.clear();
        banner();
  if (isConnected()) void warnIfNoTools(active.model);
      } else if (command === "compact") {
        const { maybeCompact } = await import("./context/compact.ts");
        ui.setBusy(true);
        try {
          const compacted = await maybeCompact({
            messages: session.messages,
            provider: getProvider(),
            signal: new AbortController().signal,
            threshold: 0,
          });
          if (compacted.compacted) {
            session.replaceMessages(compacted.messages);
            ui.addItem(
              "notice",
              `compacted ${compacted.removedMessages} messages → ${compacted.summaryTokens} tokens`,
            );
          } else {
            ui.addItem("notice", "nothing to compact");
          }
        } finally {
          ui.setBusy(false);
        }
      } else {
        ui.addItem("error", `unknown command: /${command} (try /help)`);
      }
      continue;
    }

    await runTurn(input);
  }

  await ui.dispose();
  if (!interactive) stdout.write(`session: ${session.path}\n`);
  else process.stdout.write(c.dim(`session: ${session.path}\n`));
}

function statusOf(active: ResolvedProvider, mode: string, connected: boolean): Status {
  return {
    provider: active.name,
    model: active.model,
    mode,
    connected,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Buffer connect()'s partial writes into whole transcript lines. */
function lineWriter(ui: Ui): (text: string) => void {
  let buffer = "";
  return (text: string) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) ui.addItem("notice", line);
    }
  };
}

function printCommands(ui: Ui): void {
  const width = Math.max(...COMMANDS.map((command) => `/${command.name} ${command.args ?? ""}`.trim().length));
  ui.addItem("info", "commands");
  for (const command of COMMANDS) {
    const left = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
    ui.addItem("notice", `  ${left.padEnd(width + 2)} ${command.description}`);
  }
  ui.addItem("info", "keys");
  for (const [keys, description] of KEY_HELP) {
    ui.addItem("notice", `  ${keys.padEnd(26)} ${description}`);
  }
}

function buildProvider(
  resolved: ResolvedProvider,
  onNotice?: (message: string) => void,
): OpenAiCompatibleProvider {
  const credential = resolved.apiKey;
  return new OpenAiCompatibleProvider({
    name: resolved.name,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    apiKey: credential,
    contextWindow: resolved.contextWindow,
    headers: resolved.headers,
    ...(onNotice ? { onNotice } : {}),
    // These models advertise tools but only write them as text; skipping the
    // first bad answer is better than showing a JSON blob to the user.
    ...(TOOLS_IN_NAME_ONLY.includes(resolved.model) ? { disableTools: true } : {}),
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
  harness                        interactive session
  harness init [--provider name]  write harness.json and AGENTS.md here
  harness "prompt" [options]      one task, then exit

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
    init: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "init" && i === 0) args.init = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
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