import type { ReadStream, WriteStream } from "node:tty";
import { LineEditor, type Completer } from "./editor.ts";
import { KeyDecoder } from "./keys.ts";
import { loadHistory, pushHistory, saveHistory } from "./history.ts";

export interface TerminalOptions {
  input: ReadStream;
  output: WriteStream;
  completer?: Completer;
}

/**
 * Owns stdin for the lifetime of the REPL.
 *
 * Raw mode is enabled only while a line is being edited. While the agent runs,
 * the terminal is restored so Ctrl+C produces a real SIGINT and interrupts the
 * run — the behaviour users expect from a shell.
 */
export class Terminal {
  private readonly decoder = new KeyDecoder();
  private readonly editor: LineEditor;
  private readonly history: string[] = [];
  private active: { resolve: (v: string | undefined) => void; cleanup: () => void } | undefined;
  private readonly onData = (chunk: Buffer | string) => {
    if (!this.active) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.editor.handle(this.decoder.push(text));
  };
  private readonly onResize = () => {
    if (this.active) this.editor.render();
  };

  private readonly opts: TerminalOptions;

  constructor(opts: TerminalOptions) {
    this.opts = opts;
    this.editor = new LineEditor({
      write: (text) => this.opts.output.write(text),
      size: () => ({
        cols: this.opts.output.columns || 80,
        rows: this.opts.output.rows || 24,
      }),
    });

    this.opts.input.on("data", this.onData);
    this.opts.output.on("resize", this.onResize);

    // History is loaded lazily on first use so construction stays synchronous.
    this.historyPromise = loadHistory();
  }

  private readonly historyPromise: ReturnType<typeof loadHistory>;
  private historyLoaded = false;

  private async ensureHistory(): Promise<void> {
    if (this.historyLoaded) return;
    this.historyLoaded = true;
    const entries = await this.historyPromise;
    if (entries.length > 0) this.history.push(...entries);
  }

  /** True when the terminal can render an interactive editor. */
  get interactive(): boolean {
    return Boolean(this.opts.input.isTTY && this.opts.output.isTTY);
  }

  /**
   * Read one line. Returns undefined when the user pressed Ctrl+C — callers
   * decide what that means instead of receiving an exception.
   */
  async readLine(prompt: string, completer?: Completer): Promise<string | undefined> {
    if (!this.interactive) return this.readPipedLine(prompt);

    await this.ensureHistory();

    return new Promise<string | undefined>((resolve) => {
      const enter = () => {
        this.opts.input.setRawMode(true);
        this.opts.input.resume();
        this.opts.output.write("\u001b[?2004h");
      };
      const leave = () => {
        this.opts.output.write("\u001b[?2004l");
        this.opts.input.setRawMode(false);
        this.opts.input.pause();
      };

      this.active = {
        resolve: (value) => {
          leave();
          this.active = undefined;
          resolve(value);
        },
        cleanup: leave,
      };

      enter();
      void this.editor
        .readLine({
          prompt,
          ...(completer ?? this.opts.completer ? { completer: completer ?? this.opts.completer } : {}),
          history: this.history,
        })
        .then((value) => {
          if (value !== undefined && value.trim()) {
            pushHistory(this.history, value);
            void saveHistory(this.history);
          }
          this.active?.resolve(value);
        });
    });
  }

  /** Ask a free-form question: no history, no menu, same editing keys. */
  async ask(prompt: string): Promise<string | undefined> {
    if (!this.interactive) {
      const line = await this.readPipedLine(prompt);
      return line;
    }
    await this.ensureHistory();

    return new Promise<string | undefined>((resolve) => {
      const leave = () => {
        this.opts.output.write("\u001b[?2004l");
        this.opts.input.setRawMode(false);
        this.opts.input.pause();
      };
      this.active = {
        resolve: (value) => {
          leave();
          this.active = undefined;
          resolve(value);
        },
        cleanup: leave,
      };
      this.opts.input.setRawMode(true);
      this.opts.input.resume();
      this.opts.output.write("\u001b[?2004h");
      void this.editor.readLine({ prompt, history: [] }).then((value) => {
        this.active?.resolve(value);
      });
    });
  }

  /** Ask for a secret: the same editor, but input is not echoed. */
  async secret(prompt: string): Promise<string | undefined> {
    if (!this.interactive) return this.readPipedLine(prompt);

    // Masked at the editor level: the characters never reach the terminal.
    if (!this.interactive) return this.readPipedLine(prompt);

    await this.ensureHistory();
    return new Promise<string | undefined>((resolve) => {
      const leave = () => {
        this.opts.output.write("\u001b[?2004l");
        this.opts.input.setRawMode(false);
        this.opts.input.pause();
      };
      this.active = {
        resolve: (value) => {
          leave();
          this.active = undefined;
          resolve(value);
        },
        cleanup: leave,
      };
      this.opts.input.setRawMode(true);
      this.opts.input.resume();
      this.opts.output.write("\u001b[?2004h");
      void this.editor.readLine({ prompt, history: [], mask: true }).then((value) => {
        this.active?.resolve(value);
      });
    });
  }

  /** Non-interactive fallback: one line from a pipe, EOF ends the session. */
  private readPipedLine(prompt: string): Promise<string | undefined> {
    this.opts.output.write(prompt);
    return new Promise<string | undefined>((resolve) => {
      let buffer = "";
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        this.opts.input.off("data", onData);
        resolve(line);
      };
      this.opts.input.on("data", onData);
      this.opts.input.once("end", () => resolve(buffer ? buffer.replace(/\r?\n$/, "") : undefined));
      this.opts.input.once("close", () => resolve(undefined));
      this.opts.input.resume();
    });
  }

  /** Suspend the terminal so a permission prompt or external tool can own it. */
  release(): void {
    this.active?.cleanup();
  }

  dispose(): void {
    this.opts.input.off("data", this.onData);
    this.opts.output.off("resize", this.onResize);
    this.release();
    if (this.opts.input.isTTY) {
      this.opts.input.setRawMode(false);
      this.opts.output.write("\u001b[?2004l");
    }
  }
}