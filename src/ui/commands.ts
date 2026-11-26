import type { Completion, Completer } from "./editor.ts";

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

/** Slash commands, discovered from one table so the menu cannot drift. */
export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "show commands and key bindings" },
  { name: "connect", args: "[name|url]", description: "set up a provider: key, endpoint, test, save" },
  { name: "model", args: "[id]", description: "show or change the model" },
  { name: "mode", args: "[plan|default|yolo]", description: "switch permission mode" },
  { name: "session", description: "show session id and transcript path" },
  { name: "compact", description: "force context compaction now" },
  { name: "clear", description: "clear the screen" },
  { name: "exit", description: "quit" },
];

/** Completion for provider names, filled in by the CLI at startup. */
export interface ProviderNamesSource {
  (): string[];
}

export function createCompleter(opts: { providers: ProviderNamesSource; models?: () => string[] }): Completer {
  return {
    complete(buffer: string, cursor: number): Completion[] {
      const before = buffer.slice(0, cursor);

      // Only the first token can be a command.
      if (!before.startsWith("/")) return [];
      const parts = before.split(/\s+/);

      if (parts.length === 1) {
        const typed = parts[0] ?? "/";
        return COMMANDS.filter((c) => `/${c.name}`.startsWith(typed)).map((c) => ({
          value: `/${c.name} `,
          label: `/${c.name}`,
          hint: c.args ? `${c.args} · ${c.description}` : c.description,
        }));
      }

      const command = (parts[0] ?? "").slice(1);
      const last = parts[parts.length - 1] ?? "";

      if (command === "connect") {
        return opts.providers()
          .filter((name) => name.startsWith(last))
          .map((name) => ({ value: `${name} `, label: name, hint: "provider" }));
      }
      if (command === "mode") {
        return ["plan", "default", "yolo"]
          .filter((m) => m.startsWith(last))
          .map((m) => ({ value: `${m} `, label: m, hint: MODE_HINTS[m] ?? "" }));
      }
      if (command === "model" && opts.models) {
        return opts.models()
          .filter((m) => m.startsWith(last))
          .map((m) => ({ value: `${m} `, label: m }));
      }
      return [];
    },
  };
}

const MODE_HINTS: Record<string, string> = {
  plan: "read-only, no changes",
  default: "ask before writes outside the workspace",
  yolo: "no prompts, hardline floor stays",
};

/** One-line help for the key bindings, used by /help. */
export const KEY_HELP: Array<[string, string]> = [
  ["tab / shift+tab", "complete, cycle the menu"],
  ["↑ / ↓", "history (or move in the menu)"],
  ["← / → , ctrl+b / ctrl+f", "move the cursor"],
  ["alt+b / alt+f", "move by word"],
  ["ctrl+a / ctrl+e, home / end", "start / end of line"],
  ["ctrl+u / ctrl+k", "delete to start / end"],
  ["ctrl+w", "delete the word before the cursor"],
  ["ctrl+y", "yank the last killed text"],
  ["ctrl+l", "clear the screen"],
  ["ctrl+c", "clear the line; on an empty line: quit"],
  ["ctrl+d", "quit on an empty line"],
  ["ctrl+j", "new line (multi-line prompt)"],
];