import { PromptBuffer } from "./buffer.ts";
import type { Key } from "./keys.ts";
import { clip, layout } from "./render.ts";

export interface Completion {
  /** Text inserted on accept. */
  value: string;
  /** Shown in the menu. Defaults to `value`. */
  label?: string;
  /** Right-aligned description. */
  hint?: string;
  /** Replace the whole buffer instead of the current word. */
  replaceAll?: boolean;
}

export interface Completer {
  /** Completions for the current buffer and cursor position. */
  complete(buffer: string, cursor: number): Completion[];
}

export interface ReadLineOptions {
  prompt: string;
  completer?: Completer;
  history: string[];
  /** Render bullets instead of the typed characters (secrets). */
  mask?: boolean;
}

export interface EditorDeps {
  write(text: string): void;
  /** Current terminal height/width; re-read on every render. */
  size(): { cols: number; rows: number };
}

const SGR = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  inverse: "\u001b[7m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  grey: "\u001b[90m",
};

/**
 * A small line editor: cursor movement, word keys, history, completion menu,
 * multi-line input and bracketed paste. Written against a plain byte stream so
 * it works in any terminal, including the VS Code and JetBrains panes.
 */
export class LineEditor {
  private buffer = new PromptBuffer();
  private historyIndex = -1;
  private draft = "";
  private menuItems: Completion[] = [];
  private menuIndex = 0;
  private menuOpen = false;
  /** Column of the word start that completion should replace. */
  private wordStart = 0;
  private rowsRendered = 0;
  /** Row (0-based, within the block) the cursor sat on after the last render. */
  private cursorRowLast = 0;
  private killRing = "";
  private completer: Completer | undefined;
  private history: string[] = [];
  private promptText = "";
  private mask = false;

  private readonly deps: EditorDeps;

  constructor(deps: EditorDeps) {
    this.deps = deps;
  }

  readLine(opts: ReadLineOptions): Promise<string | undefined> {
    this.done = false;
    this.buffer = new PromptBuffer();
    this.historyIndex = -1;
    this.draft = "";
    this.menuItems = [];
    this.menuIndex = 0;
    this.menuOpen = false;
    this.killRing = "";
    this.rowsRendered = 0;
    this.cursorRowLast = 0;
    this.promptText = opts.prompt;
    this.mask = opts.mask === true;
    this.completer = this.mask ? undefined : opts.completer;
    this.history = opts.history;

    this.render();

    return new Promise<string | undefined>((resolve) => {
      this.resolve = resolve;
    });
  }

  private resolve: ((value: string | undefined) => void) | undefined;

  handle(keys: Key[]): void {
    for (const key of keys) {
      if (this.done) return;
      this.handleKey(key);
    }
    if (!this.done) this.render();
  }

  private done = false;

  private handleKey(key: Key): void {
    // The completion menu captures navigation keys while open.
    if (this.menuOpen && this.menuNavigation(key)) return;

    switch (key.type) {
      case "enter":
        this.submit();
        return;
      case "ctrl-c":
        this.cancel();
        return;
      case "ctrl-d":
        if (this.buffer.isEmpty) this.cancel();
        else this.buffer.deleteForward();
        return;
      case "text":
        this.buffer.insert(key.value);
        this.dismissMenu();
        return;
      case "paste":
        this.buffer.insert(key.value);
        return;
      case "backspace":
        if (this.buffer.isEmpty) return;
        this.buffer.backspace();
        return;
      case "delete":
        this.buffer.deleteForward();
        return;
      case "left":
        this.buffer.left();
        return;
      case "right":
        this.buffer.right();
        return;
      case "alt-b":
        this.buffer.wordLeft();
        return;
      case "alt-f":
        this.buffer.wordRight();
        return;
      case "ctrl-a":
      case "home":
        this.buffer.start();
        return;
      case "ctrl-e":
      case "end":
        this.buffer.end();
        return;
      case "ctrl-b":
        this.buffer.left();
        return;
      case "ctrl-f":
        this.buffer.right();
        return;
      case "ctrl-k":
        this.killRing = this.buffer.killToEnd();
        return;
      case "ctrl-u":
        this.killRing = this.buffer.killToStart();
        return;
      case "ctrl-w":
        this.buffer.deleteWordBackKeepSpace();
        return;
      case "ctrl-y":
        if (this.killRing) this.buffer.insert(this.killRing);
        return;
      case "ctrl-p":
        this.historyPrev();
        return;
      case "ctrl-n":
        this.historyNext();
        return;
      case "up":
        this.historyPrev();
        return;
      case "down":
        this.historyNext();
        return;
      case "tab":
        this.complete(false);
        return;
      case "shift-tab":
        this.complete(true);
        return;
      case "ctrl-j":
        this.buffer.insert("\n");
        return;
      case "ctrl-l":
        this.deps.write("\u001b[2J\u001b[H");
        this.rowsRendered = 0;
        return;
      case "escape":
        this.dismissMenu();
        return;
      default:
        return;
    }
  }

  private menuNavigation(key: Key): boolean {
    switch (key.type) {
      case "up":
        this.menuIndex = (this.menuIndex - 1 + this.menuItems.length) % this.menuItems.length;
        return true;
      case "down":
        this.menuIndex = (this.menuIndex + 1) % this.menuItems.length;
        return true;
      case "tab":
        this.menuIndex = (this.menuIndex + 1) % this.menuItems.length;
        return true;
      case "shift-tab":
        this.menuIndex = (this.menuIndex - 1 + this.menuItems.length) % this.menuItems.length;
        return true;
      case "enter":
        this.acceptCompletion();
        return true;
      case "escape":
        this.dismissMenu();
        return true;
      default:
        return false;
    }
  }

  private complete(reverse: boolean): void {
    if (!this.completer || this.mask) return;

    if (this.menuOpen) {
      const len = this.menuItems.length;
      this.menuIndex = (this.menuIndex + (reverse ? -1 : 1) + len) % len;
      return;
    }

    const items = this.completer.complete(this.buffer.value, this.buffer.cursor);
    if (items.length === 0) return;

    if (items.length === 1) {
      this.applyCompletion(items[0]!);
      return;
    }

    // Menu mode: replace the current word with the common prefix first, so
    // typing continues to narrow the list.
    this.menuItems = items;
    this.menuIndex = 0;
    this.menuOpen = true;
    this.wordStart = currentWordStart(this.buffer.value, this.buffer.cursor);

    const prefix = commonPrefix(items.map((i) => insertText(i)));
    if (prefix.length > 0) {
      const current = this.buffer.value.slice(this.wordStart, this.buffer.cursor);
      if (prefix.startsWith(current) && prefix !== current) {
        this.buffer.replaceRange(this.wordStart, this.buffer.cursor, prefix);
        // Keep the list, but do not re-render the prefix each keystroke.
        this.menuItems = items.filter((i) =>
          insertText(i).startsWith(this.buffer.value.slice(this.wordStart, this.buffer.cursor)),
        );
        if (this.menuItems.length === 1) {
          this.applyCompletion(this.menuItems[0]!);
          return;
        }
      }
    }
  }

  private acceptCompletion(): void {
    const item = this.menuItems[this.menuIndex];
    if (item) this.applyCompletion(item);
  }

  private applyCompletion(item: Completion): void {
    if (item.replaceAll) {
      this.buffer.set(item.value);
    } else {
      const start =
        this.menuOpen && this.menuItems.includes(item)
          ? this.wordStart
          : currentWordStart(this.buffer.value, this.buffer.cursor);
      this.buffer.replaceRange(start, this.buffer.cursor, item.value);
    }
    this.dismissMenu();
  }

  private dismissMenu(): void {
    this.menuOpen = false;
    this.menuItems = [];
    this.menuIndex = 0;
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.draft = this.buffer.value;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this.buffer.set(this.history[this.historyIndex]!);
  }

  private historyNext(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.buffer.set(this.history[this.historyIndex]!);
    } else {
      this.historyIndex = -1;
      this.buffer.set(this.draft);
    }
  }

  private submit(): void {
    if (this.menuOpen) {
      // Enter accepts the highlighted completion rather than submitting.
      this.acceptCompletion();
      return;
    }
    this.done = true;
    const value = this.buffer.value;
    this.deps.write("\r\n");
    this.resolve?.(value);
  }

  /** Ctrl+C: clear the line, or abort when it is already empty. */
  private cancel(): void {
    this.done = true;
    this.deps.write("^C\r\n");
    this.render();
    this.resolve?.(undefined);
  }

  render(): void {
    if (this.done) return;
    const { cols, rows } = this.deps.size();
    // Masking replaces each code point with a bullet, so the cursor is counted
    // in code points too.
    const value = this.mask ? "•".repeat([...this.buffer.value].length) : this.buffer.value;
    const cursor = this.mask
      ? [...this.buffer.value.slice(0, this.buffer.cursor)].length
      : this.buffer.cursor;
    const lay = layout(this.promptText, value, cursor, cols);

    let out = "";
    if (this.rowsRendered > 0) {
      // Return to the first row of the block we drew last time, then clear it.
      if (this.cursorRowLast > 0) out += `\u001b[${this.cursorRowLast}A`;
      out += "\r\u001b[0J";
    }
    out += `${SGR.reset}${lay.rows.join("\r\n")}`;

    let totalRows = lay.rows.length;

    if (this.menuOpen && this.menuItems.length > 0) {
      const visible = Math.min(this.menuItems.length, Math.max(3, Math.min(8, rows - lay.rows.length - 2)));
      const start = Math.min(
        Math.max(0, this.menuIndex - visible + 1),
        Math.max(0, this.menuItems.length - visible),
      );
      const slice = this.menuItems.slice(start, start + visible);
      const labelWidth = Math.min(
        32,
        Math.max(...slice.map((i) => (i.label ?? i.value).length), 4),
      );

      for (let n = 0; n < slice.length; n++) {
        const item = slice[n]!;
        const selected = start + n === this.menuIndex;
        const label = clip(item.label ?? item.value, labelWidth).padEnd(labelWidth, " ");
        const hint = item.hint ? ` ${clip(item.hint, Math.max(8, cols - labelWidth - 6))}` : "";
        out += "\r\n";
        out += selected
          ? `${SGR.inverse}${label}${SGR.reset}${SGR.grey}${hint}${SGR.reset}`
          : `${SGR.grey}${label}${hint}${SGR.reset}`;
        totalRows++;
      }
      if (start > 0 || start + visible < this.menuItems.length) {
        out += "\r\n" + `${SGR.dim}${start + 1}-${start + visible}/${this.menuItems.length} · ↑↓ move · ⏎ pick · esc close${SGR.reset}`;
        totalRows++;
      }
    }

    // Move the cursor back up to the edited line.
    const rowsBelow = totalRows - lay.cursorRow - 1;
    if (rowsBelow > 0) out += `\u001b[${rowsBelow}A`;
    out += "\r";
    // A cursor at the exact right edge would wrap; keep it on the last column.
    const targetCol = Math.min(lay.cursorCol, Math.max(0, cols - 1));
    if (targetCol > 0) out += `\u001b[${targetCol}C`;

    this.rowsRendered = totalRows;
    this.cursorRowLast = lay.cursorRow;
    this.deps.write(out);
  }
}

function currentWordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isSpace(value[i - 1]!)) i--;
  return i;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function insertText(item: Completion): string {
  return item.value;
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