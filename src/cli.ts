#!/usr/bin/env node
import { loadConfig } from "./config/config.ts";
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
  resume?: string;
  cwd: string;
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const cwd = resolve(args.cwd);
  const config = await loadConfig(cwd);
  if (args.mode) config.mode = args.mode;
  if (args.model) config.model = args.model;

  if (!config.apiKey && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(config.baseUrl)) {
    console.error(
      c.red("No API key.") +
        " Set HARNESS_API_KEY (or OPENAI_API_KEY), or point HARNESS_BASE_URL at a local server.\n" +
        c.dim("Example: export HARNESS_API_KEY=... HARNESS_MODEL=gpt-4.1-mini\n"),
    );
    process.exitCode = 1;
    return;
  }

  const provider = new OpenAiCompatibleProvider({
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    contextWindow: config.contextWindow,
    headers: config.providerHeaders,
  });

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
    await session.append({ role: "user", content: input });
    abortController = new AbortController();
    running = true;
    try {
      const result = await runAgent({
        session,
        provider,
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
    await runTurn(args.prompt);
    rl.close();
    return;
  }

  printBanner(config.model, permissions.mode, session);
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

function printBanner(model: string, mode: string, session: Session): void {
  stdout.write(
    `${c.bold("harness")} ${c.dim(VERSION)}  ${c.dim("model")} ${model}  ${c.dim("mode")} ${mode}\n` +
      `${c.dim(`session ${session.meta.id} · /help for commands · ctrl+c to interrupt`)}\n\n`,
  );
}

function printCommands(): void {
  stdout.write(
    [
      "/help              show this help",
      "/mode plan|default|yolo",
      "/session           show session id and transcript path",
      "/exit              quit",
      "",
    ].join("\n"),
  );
}

function printHelp(): void {
  stdout.write(`harness ${VERSION} — a minimal coding agent

Usage
  harness [prompt] [options]

Options
  --mode <plan|default|yolo>   permission mode (default: default)
  --model <name>               model id
  --resume <session.jsonl>     resume a transcript
  --cwd <dir>                  workspace (default: current directory)
  -h, --help                   show this help

Environment
  HARNESS_API_KEY      API key (falls back to OPENAI_API_KEY)
  HARNESS_BASE_URL     OpenAI-compatible base URL
  HARNESS_MODEL        model id
  HARNESS_MODE         permission mode
  HARNESS_CONTEXT_WINDOW  context window in tokens

Config
  harness.json in the workspace: { "model", "baseUrl", "mode", "rules", "maxSteps" }
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") args.help = true;
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