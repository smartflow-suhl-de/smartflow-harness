import { PromptBuffer } from "./buffer.ts";

export interface Completion {
  /** Text inserted on accept. */
  value: string;
  /** Shown in the menu. Defaults to `value`. */
  label?: string;
  /** Right-aligned description. */
  hint?: string;
}

export interface Completer {
  complete(buffer: string, cursor: number): Completion[];
}

export function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isSpace(value[i - 1]!)) i--;
  return i;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) return "";
  }
  return prefix;
}

/**
 * Tab completion state for one prompt.
 *
 * Behaviour:
 *   tab (closed)  -> unique match inserts, many matches open the menu
 *   tab (open)    -> move the selection and preview the item in the buffer
 *   esc           -> close the menu, keep whatever is in the buffer
 *   typing        -> closes the menu; the buffer is the source of truth
 *
 * Enter is not handled here: whatever the buffer shows is what gets submitted,
 * so Tab-then-Enter submits the previewed item.
 */
export class CompletionMenu {
  isOpen = false;
  items: Completion[] = [];
  index = 0;
  private start = 0;
  private end = 0;

  private readonly buffer: PromptBuffer;
  private readonly completer: Completer | undefined;

  constructor(buffer: PromptBuffer, completer: Completer | undefined) {
    this.buffer = buffer;
    this.completer = completer;
  }

  tab(reverse: boolean): void {
    if (!this.completer) return;
    if (this.isOpen) {
      this.move(reverse ? -1 : 1);
      return;
    }
    this.open();
  }

  open(): void {
    if (!this.completer) return;
    const items = this.completer.complete(this.buffer.value, this.buffer.cursor);
    if (items.length === 0) return;
    if (items.length === 1) {
      this.replaceWord(items[0]!);
      return;
    }

    this.isOpen = true;
    this.items = items;
    this.index = 0;
    this.start = wordStart(this.buffer.value, this.buffer.cursor);
    this.end = this.buffer.cursor;

    // Type the common prefix, so the list narrows as the user keeps typing.
    const current = this.buffer.value.slice(this.start, this.end);
    const prefix = commonPrefix(items.map((item) => item.value));
    if (prefix.length > current.length && prefix.startsWith(current)) {
      this.buffer.replaceRange(this.start, this.end, prefix);
      this.end = this.start + prefix.length;
    }
  }

  move(delta: number): void {
    if (!this.isOpen || this.items.length === 0) return;
    const len = this.items.length;
    this.index = (this.index + delta + len) % len;
    const item = this.items[this.index]!;
    this.buffer.replaceRange(this.start, this.end, item.value);
    this.end = this.start + item.value.length;
  }

  accept(): void {
    if (!this.isOpen) return;
    const item = this.items[this.index];
    if (item) this.replaceWord(item);
    this.dismiss();
  }

  dismiss(): void {
    this.isOpen = false;
    this.items = [];
    this.index = 0;
  }

  /** Reposition around the cursor after an unrelated edit. */
  refresh(): void {
    if (!this.isOpen) return;
    const items = this.completer?.complete(this.buffer.value, this.buffer.cursor) ?? [];
    if (items.length === 0) {
      this.dismiss();
      return;
    }
    this.items = items;
    this.index = Math.min(this.index, items.length - 1);
    this.start = wordStart(this.buffer.value, this.buffer.cursor);
    this.end = this.buffer.cursor;
  }

  private replaceWord(item: Completion): void {
    const start = wordStart(this.buffer.value, this.buffer.cursor);
    this.buffer.replaceRange(start, this.buffer.cursor, item.value);
  }
}