import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readConfigFiles, saveProjectConfig } from "./config/config.ts";
import { connect, type ConnectIO } from "./ui/connect.ts";
import { createListCompleter } from "./ui/commands.ts";
import type { Ui } from "./ui/ui.ts";

export interface InitOptions {
  cwd: string;
  ui: Ui;
  /** Preselected provider, e.g. `harness init --provider ollama`. */
  provider?: string;
  env?: NodeJS.ProcessEnv;
}

interface Detected {
  name: string;
  commands: Array<[label: string, command: string]>;
}

/**
 * `harness init` — make a repository ready for the harness.
 *
 * Writes the project `harness.json` and an `AGENTS.md` tailored to the detected
 * stack, reusing the same prompts as `/connect`. Never overwrites an existing
 * `AGENTS.md`, and never leaves a half-written config behind.
 */
export async function runInit(opts: InitOptions): Promise<boolean> {
  const { ui, cwd } = opts;
  const env = opts.env ?? process.env;
  const detected = await detect(cwd);

  ui.addItem("notice", `init · ${cwd}`);
  if (!(await exists(join(cwd, ".git")))) {
    ui.addItem("notice", "not a git repository — continuing anyway");
  }

  const existing = await readConfigFiles(cwd);
  const projectFile = existing.sources.includes(join(cwd, "harness.json"));
  if (projectFile) {
    ui.addItem("notice", "harness.json exists — updating only the fields you pick");
  }

  const io = connectIO(ui);
  const ok = await connect({
    config: {
      file: existing.file,
      provider: {
        name: opts.provider ?? existing.file.provider ?? "openai",
        contextWindow: 128_000,
      },
    },
    cwd,
    io,
    args: opts.provider ? [opts.provider] : [],
    env,
    target: "project",
  });
  if (!ok) {
    ui.addItem("notice", "init cancelled — nothing written");
    return false;
  }

  const mode = await askMode(ui);
  await saveProjectConfig(cwd, { mode });

  const agentsPath = join(cwd, "AGENTS.md");
  if (await exists(agentsPath)) {
    ui.addItem("notice", "AGENTS.md exists — kept as it is");
  } else {
    await writeFile(agentsPath, renderAgents(detected), "utf8");
    ui.addItem("notice", `wrote ${agentsPath}`);
  }

  const ignore = await addToGitignore(cwd);
  if (ignore) ui.addItem("notice", "added .harness/ to .gitignore");

  ui.addItem("notice", `ready · ${detected.name} · mode ${mode}`);
  ui.addItem("notice", "start with: harness   ·   provider setup: /connect");
  return true;
}

function connectIO(ui: Ui): ConnectIO {
  return {
    question: async (question) => {
      const answer = await ui.ask(question, { tone: "question" });
      return answer.type === "value" ? answer.value : undefined;
    },
    secret: async (question) => {
      const answer = await ui.ask(question, { tone: "question", mask: true });
      return answer.type === "value" ? answer.value : undefined;
    },
    write: (line) => {
      for (const text of line.split("\n")) {
        if (text.trim()) ui.addItem("notice", text);
      }
    },
  };
}

async function askMode(ui: Ui): Promise<"plan" | "default" | "yolo"> {
  const modes = ["default", "plan", "yolo"];
  const answer = await ui.ask("permission mode [default]: ", {
    tone: "question",
    completer: createListCompleter(() => modes, (mode) => {
      if (mode === "plan") return "read-only";
      if (mode === "yolo") return "no prompts";
      return "ask before writes outside the workspace";
    }),
    placeholder: modes.join(", "),
  });
  if (answer.type === "cancel") return "default";
  const value = answer.value.trim();
  return value === "plan" || value === "yolo" ? value : "default";
}

async function detect(cwd: string): Promise<Detected> {
  const name = basename(cwd);
  const commands: Array<[string, string]> = [];

  const pkg = await readJson(join(cwd, "package.json"));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const label of ["build", "test", "typecheck", "lint", "format"]) {
      const script = scripts[label];
      if (typeof script === "string") {
        commands.push([label, `${manager(pkg)} run ${label}`]);
      }
    }
  }

  if (await exists(join(cwd, "pyproject.toml"))) {
    commands.push(["test", "pytest"], ["typecheck", "mypy ."]);
  }
  if (await exists(join(cwd, "Cargo.toml"))) {
    commands.push(["build", "cargo build"], ["test", "cargo test"]);
  }
  if (await exists(join(cwd, "go.mod"))) {
    commands.push(["build", "go build ./..."], ["test", "go test ./..."]);
  }

  const packageName = typeof pkg?.name === "string" ? pkg.name : name;
  return { name: packageName, commands };
}

function manager(pkg: Record<string, unknown>): string {
  const manager = (pkg.packageManager as string | undefined)?.split("@")[0];
  if (manager) return manager;
  return "npm";
}

async function addToGitignore(cwd: string): Promise<boolean> {
  const path = join(cwd, ".gitignore");
  const entry = ".harness/";
  let text = "";
  try {
    text = await readFile(path, "utf8");
    if (text.split("\n").some((line) => line.trim() === entry)) return false;
    const separator = text.endsWith("\n") ? "" : "\n";
    await appendFile(path, `${separator}\n# harness sessions\n${entry}\n`, "utf8");
    return true;
  } catch {
    // No .gitignore yet: create one rather than leaving sessions untracked.
    await writeFile(path, `# harness sessions\n${entry}\n`, "utf8");
    return true;
  }
}

function renderAgents(detected: Detected): string {
  const commands = detected.commands.length
    ? detected.commands.map(([label, command]) => `- ${label}: \`${command}\``).join("\n")
    : "- (add the commands this project uses)";

  return `# ${detected.name} — project instructions

## Commands

${commands}

## Rules

- Read a file before you edit it.
- Make the smallest change that solves the task; no unrelated refactors.
- Run the tests or the build after a change, and report the real output.
- Never claim something works without evidence. Say what you ran.
- Keep numbered steps only when the order matters.

## Layout

- (describe the important directories here)
`;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}