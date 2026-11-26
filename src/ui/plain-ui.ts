import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AskOptions, Ui } from "./ui.ts";
import type { ItemKind, PromptResult } from "./store.ts";
import { loadHistory, pushHistory, saveHistory } from "./history.ts";

/**
 * Line-based fallback for non-interactive stdin (pipes, CI).
 *
 * No cursor tricks, no menu: it reads whole lines and writes plain text, so the
 * output stays greppable and `printf '/exit\n' | harness` keeps working.
 */
export function createPlainUi(): Ui {
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  const history: string[] = [];
  let closed = false;
  void loadHistory().then((entries) => history.push(...entries));

  rl.on("close", () => {
    closed = true;
  });

  const prefix: Record<ItemKind, string> = {
    user: "❯ ",
    assistant: "",
    tool: "  ",
    error: "error: ",
    notice: "  ",
    info: "",
  };

  return {
    async ask(text: string, opts: AskOptions = {}): Promise<PromptResult> {
      if (closed) return { type: "cancel" };
      try {
        const value = await rl.question(text);
        if (value.trim()) {
          pushHistory(history, value);
          void saveHistory(history);
        }
        return { type: "value", value };
      } catch {
        return { type: "cancel" };
      }
    },
    addItem(kind: ItemKind, text: string, opts?: { label?: string; ok?: boolean }): void {
      const label = opts?.label ? `${opts.label} ` : "";
      stdout.write(`${prefix[kind]}${label}${text}\n`);
    },
    setLive(text: string | null): void {
      if (text) stdout.write(`  ${text}\n`);
    },
    setBusy(): void {},
    updateStatus(): void {},
    clear(): void {
      stdout.write("\u001b[2J\u001b[3J\u001b[H");
    },
    onInterrupt(): void {},
    async dispose(): Promise<void> {
      rl.close();
    },
  };
}