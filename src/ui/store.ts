import type { Completer } from "./completion.ts";

export type ItemKind = "user" | "assistant" | "tool" | "error" | "notice" | "info";

export interface TranscriptItem {
  id: number;
  kind: ItemKind;
  text: string;
  /** Tool name or short label. */
  label?: string;
  ok?: boolean;
}

export interface Status {
  provider: string;
  model: string;
  mode: string;
  connected: boolean;
  inputTokens: number;
  outputTokens: number;
}

export type PromptTone = "prompt" | "question";

export interface PromptRequest {
  id: number;
  text: string;
  tone: PromptTone;
  completer?: Completer;
  mask?: boolean;
  history: string[];
  placeholder?: string;
}

export type PromptResult = { type: "value"; value: string } | { type: "cancel" };

export interface UiState {
  items: TranscriptItem[];
  /** A short line for work in progress, e.g. the running tool. */
  live: string | null;
  prompt: PromptRequest | null;
  busy: boolean;
  status: Status;
}

/**
 * External store read by the Ink tree through `useSyncExternalStore`.
 *
 * Keeping it outside React means the agent loop stays imperative: it awaits
 * `ask()` and pushes items, with no hooks involved.
 */
export class UiStore {
  private state: UiState;
  private listeners = new Set<() => void>();
  private pending: ((result: PromptResult) => void) | undefined;
  private seq = 0;
  private interruptHandler: (() => void) | undefined;

  constructor(status: Status) {
    this.state = { items: [], live: null, prompt: null, busy: false, status };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): UiState => this.state;

  private patch(partial: Partial<UiState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  addItem(kind: ItemKind, text: string, opts: { label?: string; ok?: boolean } = {}): void {
    const item: TranscriptItem = { id: ++this.seq, kind, text, ...opts };
    this.patch({ items: [...this.state.items, item] });
  }

  setLive(live: string | null): void {
    if (this.state.live === live) return;
    this.patch({ live });
  }

  setBusy(busy: boolean): void {
    this.patch({ busy });
  }

  updateStatus(partial: Partial<Status>): void {
    this.patch({ status: { ...this.state.status, ...partial } });
  }

  onInterrupt(handler: () => void): void {
    this.interruptHandler = handler;
  }

  /** Called by the UI when Ctrl+C arrives outside a prompt (i.e. during work). */
  interrupt(): void {
    this.interruptHandler?.();
  }

  clearItems(): void {
    this.patch({ items: [] });
  }

  ask(
    text: string,
    opts: { completer?: Completer; mask?: boolean; history?: string[]; tone?: PromptTone; placeholder?: string } = {},
  ): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve) => {
      this.pending = resolve;
      this.patch({
        prompt: {
          id: ++this.seq,
          text,
          tone: opts.tone ?? "question",
          ...(opts.completer ? { completer: opts.completer } : {}),
          ...(opts.mask ? { mask: true } : {}),
          history: opts.history ?? [],
          ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
        },
      });
    });
  }

  submit(value: string): void {
    const pending = this.pending;
    this.pending = undefined;
    this.patch({ prompt: null });
    pending?.({ type: "value", value });
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.patch({ prompt: null });
    pending?.({ type: "cancel" });
  }
}