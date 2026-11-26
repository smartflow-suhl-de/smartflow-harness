/**
 * Terminal rendering helpers, kept separate so wrapping is testable without a TTY.
 */

export interface Layout {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
}

/**
 * Wrap `promptText + display` into terminal rows and locate the cursor.
 *
 * `cursorIndex` is a UTF-16 offset into `display`. The simulation matches how
 * a terminal wraps: a character that does not fit starts a new row. Explicit
 * newlines start a new row too.
 */
export function layout(
  promptText: string,
  display: string,
  cursorIndex: number,
  cols: number,
): Layout {
  const width = Math.max(1, cols);
  const rows: string[] = [""];
  let col = 0;
  let cursorRow = 0;
  let cursorCol = 0;

  const put = (ch: string, w: number): void => {
    if (col + w > width) {
      rows.push("");
      col = 0;
    }
    rows[rows.length - 1] += ch;
    col += w;
  };

  for (const ch of promptText) put(ch, charWidth(ch.codePointAt(0)!));

  let index = 0;
  for (const ch of display) {
    if (index === cursorIndex) {
      cursorRow = rows.length - 1;
      cursorCol = col;
    }
    if (ch === "\n") {
      rows.push("");
      col = 0;
    } else {
      put(ch, charWidth(ch.codePointAt(0)!));
    }
    index += ch.length;
  }
  if (index <= cursorIndex) {
    cursorRow = rows.length - 1;
    cursorCol = col;
  }
  // A cursor exactly at the right edge must not be reported past the row.
  if (cursorCol > width) cursorCol = width;

  return { rows, cursorRow, cursorCol };
}

/** Width of a string on a terminal, counting wide CJK/emoji as two columns. */
export function displayWidth(text: string): number {
  let sum = 0;
  for (const ch of text) sum += charWidth(ch.codePointAt(0)!);
  return sum;
}

export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Truncate to `max` columns with an ellipsis, for menu hints. */
export function clip(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (used + w > max - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}