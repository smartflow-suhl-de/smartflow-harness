/**
 * Editable single- or multi-line buffer with a cursor.
 *
 * Kept free of terminal concerns so the key handling can be unit-tested.
 * Indices are UTF-16 offsets; that matches how we slice the string and is
 * good enough for a terminal line editor.
 */
export class PromptBuffer {
  value = "";
  cursor = 0;

  set(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  /** Replace [start, end) and put the cursor after the replacement. */
  replaceRange(start: number, end: number, text: string): void {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.cursor = start + text.length;
  }

  backspace(): boolean {
    if (this.cursor === 0) return false;
    this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
    this.cursor--;
    return true;
  }

  deleteForward(): boolean {
    if (this.cursor >= this.value.length) return false;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
    return true;
  }

  left(): boolean {
    if (this.cursor === 0) return false;
    this.cursor--;
    return true;
  }

  right(): boolean {
    if (this.cursor >= this.value.length) return false;
    this.cursor++;
    return true;
  }

  start(): void {
    this.cursor = 0;
  }

  end(): void {
    this.cursor = this.value.length;
  }

  /** Move to the start of the previous word (shell Alt+B / Ctrl+Left). */
  wordLeft(): void {
    let i = this.cursor;
    while (i > 0 && isSpace(this.value[i - 1]!)) i--;
    while (i > 0 && !isSpace(this.value[i - 1]!)) i--;
    this.cursor = i;
  }

  wordRight(): void {
    let i = this.cursor;
    const n = this.value.length;
    while (i < n && isSpace(this.value[i]!)) i++;
    while (i < n && !isSpace(this.value[i]!)) i++;
    this.cursor = i;
  }

  /** Delete from the cursor back to the previous word boundary. */
  deleteWordBack(): boolean {
    const from = this.cursor;
    this.wordLeft();
    if (this.cursor === from) return false;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(from);
    return true;
  }

  deleteWordForward(): boolean {
    const from = this.cursor;
    this.wordRight();
    if (this.cursor === from) return false;
    this.value = this.value.slice(0, from) + this.value.slice(this.cursor);
    this.cursor = from;
    return true;
  }

  /** Ctrl+U: remove everything left of the cursor, return what was cut. */
  killToStart(): string {
    const killed = this.value.slice(0, this.cursor);
    this.value = this.value.slice(this.cursor);
    this.cursor = 0;
    return killed;
  }

  /** Ctrl+K: remove everything right of the cursor. */
  killToEnd(): string {
    const killed = this.value.slice(this.cursor);
    this.value = this.value.slice(0, this.cursor);
    return killed;
  }

  /**
   * Ctrl+W deletes the word before the cursor but keeps the whitespace before
   * it, which matches what shells and editors do.
   */
  deleteWordBackKeepSpace(): boolean {
    const from = this.cursor;
    let i = from;
    while (i > 0 && isSpace(this.value[i - 1]!)) i--;
    while (i > 0 && !isSpace(this.value[i - 1]!)) i--;
    if (i === from) return false;
    this.value = this.value.slice(0, i) + this.value.slice(from);
    this.cursor = i;
    return true;
  }

  get isEmpty(): boolean {
    return this.value.trim().length === 0;
  }
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}
