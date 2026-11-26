/**
 * Decode terminal input chunks into key events.
 *
 * Chunks are arbitrary: a single read can contain half an escape sequence, or
 * a pasted paragraph. The decoder keeps a pending remainder between calls so
 * arrow keys keep working under load.
 */
export type Key =
  | { type: "text"; value: string }
  | { type: "paste"; value: string }
  | { type: "enter" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-l" }
  | { type: "ctrl-a" }
  | { type: "ctrl-e" }
  | { type: "ctrl-b" }
  | { type: "ctrl-f" }
  | { type: "ctrl-k" }
  | { type: "ctrl-u" }
  | { type: "ctrl-w" }
  | { type: "ctrl-y" }
  | { type: "ctrl-n" }
  | { type: "ctrl-p" }
  | { type: "ctrl-j" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "shift-tab" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "page-up" }
  | { type: "page-down" }
  | { type: "ctrl-j" }
  | { type: "alt-b" }
  | { type: "alt-f" }
  | { type: "unknown"; raw: string };

/** Ambiguous escape prefix: keep it until the next chunk arrives. */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

const PREFIXES = ["\u001b", "\u001b[", "\u001bO", "\u001b[1;", "\u001b[3", "\u001b[5", "\u001b[6", "\u001b[1", "\u001b[9", "\u001b[2", "\u001b[20"];

export class KeyDecoder {
  private pending = "";
  private pasting = false;
  private pasteBuffer = "";

  push(chunk: string): Key[] {
    const input = this.pending + chunk;
    this.pending = "";

    // Bracketed paste: everything between the markers is literal text.
    if (this.pasting) {
      const end = input.indexOf(PASTE_END);
      if (end === -1) {
        this.pasteBuffer += input;
        return [];
      }
      this.pasteBuffer += input.slice(0, end);
      const value = this.pasteBuffer;
      this.pasteBuffer = "";
      this.pasting = false;
      const rest = input.slice(end + PASTE_END.length);
      return [{ type: "paste", value }, ...this.push(rest)];
    }

    const start = input.indexOf(PASTE_START);
    if (start !== -1) {
      const before = input.slice(0, start);
      const after = input.slice(start + PASTE_START.length);
      const keys = before ? this.push(before) : [];
      this.pasting = true;
      this.pasteBuffer = "";
      return [...keys, ...this.push(after)];
    }

    const keys: Key[] = [];

    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;

      if (ch === "\u001b") {
        const rest = input.slice(i);
        const decoded = this.decodeEscape(rest);
        if (decoded === "incomplete") {
          this.pending = rest;
          break;
        }
        keys.push(decoded.key);
        i += decoded.length;
        continue;
      }

      const parsed = decodeControl(ch, input.slice(i, i + 1));
      if (parsed) {
        keys.push(parsed);
        i += 1;
        continue;
      }

      // Plain run of printable characters, up to the next control byte.
      let j = i;
      let text = "";
      while (j < input.length) {
        const c = input[j]!;
        const code = c.charCodeAt(0);
        if (c === "\u001b" || code < 32 || code === 127) break;
        text += c;
        j++;
      }
      if (text) keys.push({ type: "text", value: text });
      i = j;
    }

    return keys;
  }

  private decodeEscape(input: string): { key: Key; length: number } | "incomplete" {
    // Alt+letter (ESC followed by one char).
    if (input.length >= 2 && !isEscapeContinuation(input[1]!)) {
      const ch = input[1]!;
      if (ch === "b" || ch === "B") return { key: { type: "alt-b" }, length: 2 };
      if (ch === "f" || ch === "F") return { key: { type: "alt-f" }, length: 2 };
      if (ch === "\u007f") return { key: { type: "unknown", raw: input.slice(0, 2) }, length: 2 };
      return { key: { type: "unknown", raw: input.slice(0, 2) }, length: 2 };
    }

    const sequences: Array<[string, Key]> = [
      ["\u001b[A", { type: "up" }],
      ["\u001b[B", { type: "down" }],
      ["\u001b[C", { type: "right" }],
      ["\u001b[D", { type: "left" }],
      ["\u001b[H", { type: "home" }],
      ["\u001b[F", { type: "end" }],
      ["\u001bOA", { type: "up" }],
      ["\u001bOB", { type: "down" }],
      ["\u001bOC", { type: "right" }],
      ["\u001bOD", { type: "left" }],
      ["\u001bOH", { type: "home" }],
      ["\u001bOF", { type: "end" }],
      ["\u001b[1~", { type: "home" }],
      ["\u001b[2~", { type: "unknown", raw: "\u001b[2~" }],
      ["\u001b[3~", { type: "delete" }],
      ["\u001b[4~", { type: "end" }],
      ["\u001b[5~", { type: "page-up" }],
      ["\u001b[6~", { type: "page-down" }],
      ["\u001b[7~", { type: "home" }],
      ["\u001b[8~", { type: "end" }],
      ["\u001b[Z", { type: "shift-tab" }],
      ["\u001b[1;5C", { type: "alt-f" }], // Ctrl+Right
      ["\u001b[1;5D", { type: "alt-b" }], // Ctrl+Left
      ["\u001b[1;3C", { type: "alt-f" }], // Alt+Right
      ["\u001b[1;3D", { type: "alt-b" }], // Alt+Left
    ];

    for (const [seq, key] of sequences) {
      if (input.startsWith(seq)) return { key, length: seq.length };
    }

    // A sequence that could still be extended: wait for the next chunk.
    if (PREFIXES.some((p) => input === p || (input.startsWith(p) && p.startsWith(input)))) {
      return "incomplete";
    }
    if (input.length === 1) return "incomplete";

    return { key: { type: "escape" }, length: 1 };
  }
}

function isEscapeContinuation(ch: string): boolean {
  return ch === "[" || ch === "O";
}

function decodeControl(ch: string, raw: string): Key | undefined {
  switch (ch) {
    case "\r":
      return { type: "enter" };
    case "\n":
      return { type: "ctrl-j" };
    case "\t":
      return { type: "tab" };
    case "\u007f":
    case "\b":
      return { type: "backspace" };
    case "\u0003":
      return { type: "ctrl-c" };
    case "\u0004":
      return { type: "ctrl-d" };
    case "\u000c":
      return { type: "ctrl-l" };
    case "\u0001":
      return { type: "ctrl-a" };
    case "\u0005":
      return { type: "ctrl-e" };
    case "\u0002":
      return { type: "ctrl-b" };
    case "\u0006":
      return { type: "ctrl-f" };
    case "\u000b":
      return { type: "ctrl-k" };
    case "\u0015":
      return { type: "ctrl-u" };
    case "\u0017":
      return { type: "ctrl-w" };
    case "\u0019":
      return { type: "ctrl-y" };
    case "\u000e":
      return { type: "ctrl-n" };
    case "\u0010":
      return { type: "ctrl-p" };
    default:
      return undefined;
  }
}