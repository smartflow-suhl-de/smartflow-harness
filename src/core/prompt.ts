import { platform, release } from "node:os";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ContextFile } from "../context/files.ts";

export function buildSystemPrompt(opts: {
  cwd: string;
  tools: ToolRegistry;
  contextFiles: ContextFile[];
  extra?: string;
}): string {
  const context = opts.contextFiles.length
    ? `\n\n<context>\n${opts.contextFiles
        .map((f) => `<file path="${f.path}">\n${f.content.trim()}\n</file>`)
        .join("\n\n")}\n</context>`
    : "";

  return `You are a coding agent running in the user's terminal.

Environment
- working directory: ${opts.cwd}
- date: ${new Date().toISOString().slice(0, 10)}
- platform: ${platform()} ${release()}
- node: ${process.version}

How to work
- Inspect before you change: read the relevant files, then edit.
- Prefer the dedicated tools over shell equivalents (read, edit, glob, grep).
- Make the smallest change that solves the task. Do not refactor unrelated code.
- Run tests or the build when the project has them; report the actual output.
- Never claim something works without evidence. If you did not run it, say so.
- Ask one focused question only when you are genuinely blocked; otherwise act.
- Keep responses short. The user sees your text in a terminal.

Tools
${opts.tools.describe()}

If a tool result says permission was denied, do not retry it; adapt or ask.${context}${
    opts.extra ? `\n\n${opts.extra}` : ""
  }`;
}