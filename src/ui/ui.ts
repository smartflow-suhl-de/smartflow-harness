import type { PromptResult, Status, ItemKind } from "./store.ts";

export interface AskOptions {
  completer?: import("./completion.ts").Completer;
  mask?: boolean;
  history?: string[];
  tone?: "prompt" | "question";
  placeholder?: string;
}

/**
 * Everything the session loop needs from the UI.
 *
 * Two implementations exist: the Ink app for terminals, and a plain line-based
 * fallback for pipes and CI so `harness "task" | ...` keeps working.
 */
export interface Ui {
  ask(text: string, opts?: AskOptions): Promise<PromptResult>;
  addItem(kind: ItemKind, text: string, opts?: { label?: string; ok?: boolean }): void;
  setLive(text: string | null): void;
  setBusy(busy: boolean): void;
  updateStatus(patch: Partial<Status>): void;
  clear(): void;
  onInterrupt(handler: () => void): void;
  dispose(): Promise<void>;
}