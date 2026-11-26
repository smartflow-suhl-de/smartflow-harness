import { spawn, type ChildProcess } from "node:child_process";
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from "./types.ts";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Line-delimited JSON-RPC 2.0 stdio transport.
 */
export class StdioTransport {
  private readonly opts: StdioTransportOptions;
  private child?: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (res: JsonRpcResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(opts: StdioTransportOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.child) return;

    this.child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.handleData(chunk));

    this.child.on("error", (err) => {
      this.rejectAll(new Error(`MCP process error: ${err.message}`));
    });

    this.child.on("exit", (code) => {
      this.rejectAll(new Error(`MCP process exited with code ${code}`));
      this.child = undefined;
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          clearTimeout(handler.timer);
          this.pending.delete(msg.id);
          handler.resolve(msg);
        }
      } catch {
        // Ignore unparseable or non-JSON log lines
      }
    }
  }

  async sendRequest(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("transport is not running or stdin is closed");
    }

    const id = this.nextId++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (res) => {
          if (res.error) {
            reject(new Error(`MCP error ${res.error.code}: ${res.error.message}`));
          } else {
            resolve(res.result);
          }
        },
        reject,
        timer,
      });

      this.child!.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return;

    const notif: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    };

    this.child.stdin.write(JSON.stringify(notif) + "\n");
  }

  private rejectAll(err: Error): void {
    for (const [, handler] of this.pending) {
      clearTimeout(handler.timer);
      handler.reject(err);
    }
    this.pending.clear();
  }

  close(): void {
    if (!this.child) return;
    this.rejectAll(new Error("transport closed"));
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.child = undefined;
  }
}
