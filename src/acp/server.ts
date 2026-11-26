import type { Readable, Writable } from "node:stream";
import type { Provider } from "../provider/provider.ts";
import { runAgent } from "../core/loop.ts";
import { Session } from "../core/session.ts";
import type { AgentEvent } from "../core/types.ts";
import { PermissionEngine, type Mode } from "../safety/permissions.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type {
  AcpInitializeResult,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.ts";

export interface AcpServerOptions {
  input: Readable;
  output: Writable;
  provider: Provider;
  baseTools: ToolRegistry;
  defaultCwd: string;
  systemPrompt: string;
  maxSteps?: number;
  diagnostics?: boolean;
  /** Security audit log, shared with the CLI. */
  audit?: import("../safety/audit.ts").AuditLog;
}

interface ManagedSession {
  session: Session;
  cwd: string;
  mode: Mode;
  permissions: PermissionEngine;
  abortController?: AbortController;
}

/**
 * In-process Agent Client Protocol (ACP) JSON-RPC 2.0 Server over stdio / streams.
 */
export class AcpServer {
  private readonly opts: AcpServerOptions;
  private readonly sessions: Map<string, ManagedSession>;
  private buffer: string;
  private running: boolean;
  private readonly onDataHandler: (chunk: Buffer | string) => void;

  constructor(opts: AcpServerOptions) {
    this.opts = opts;
    this.sessions = new Map();
    this.buffer = "";
    this.running = false;
    this.onDataHandler = (chunk) => this.handleData(chunk);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.input.on("data", this.onDataHandler);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.opts.input.removeListener("data", this.onDataHandler);
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
    }
    this.sessions.clear();
  }

  private handleData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendResponse(null, undefined, {
        code: -32700,
        message: "Parse error: invalid JSON",
      });
      return;
    }

    if ("method" in msg && typeof msg.method === "string") {
      if ("id" in msg && msg.id !== undefined) {
        void this.handleRequest(msg as JsonRpcRequest);
      } else {
        this.handleNotification(msg as JsonRpcNotification);
      }
    }
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const { id, method, params = {} } = req;

    switch (method) {
      case "initialize": {
        const result: AcpInitializeResult = {
          protocolVersion: 1,
          serverInfo: {
            name: "harness",
            version: "0.1.0",
          },
          capabilities: {
            prompts: true,
            cancel: true,
            streaming: true,
          },
        };
        this.sendResponse(id, result);
        break;
      }

      case "session/create":
      case "session/new": {
        const cwd = typeof params.cwd === "string" ? params.cwd : this.opts.defaultCwd;
        const mode = (params.mode as Mode) || "default";

        const session = Session.createEphemeral({
          cwd,
          title: "acp-session",
        });

        const permissions = new PermissionEngine({
          mode,
          cwd,
        });

        this.sessions.set(session.meta.id, {
          session,
          cwd,
          mode,
          permissions,
        });

        this.sendResponse(id, { sessionId: session.meta.id });
        break;
      }

      case "session/prompt": {
        const sessionId = String(params.sessionId ?? "");
        const prompt = String(params.prompt ?? "");

        const managed = this.sessions.get(sessionId);
        if (!managed) {
          this.sendResponse(id, undefined, {
            code: -32602,
            message: `Session "${sessionId}" not found`,
          });
          return;
        }

        if (!prompt) {
          this.sendResponse(id, undefined, {
            code: -32602,
            message: 'Missing "prompt" parameter',
          });
          return;
        }

        await managed.session.append({ role: "user", content: prompt });
        const abortController = new AbortController();
        managed.abortController = abortController;

        try {
          const onEvent = (event: AgentEvent) => {
            this.sendNotification("session/update", {
              sessionId,
              event,
            });
          };

          const result = await runAgent({
            session: managed.session,
            provider: this.opts.provider,
            tools: this.opts.baseTools,
            permissions: managed.permissions,
            systemPrompt: this.opts.systemPrompt,
            cwd: managed.cwd,
            signal: abortController.signal,
            onEvent,
            maxSteps: this.opts.maxSteps,
            diagnostics: this.opts.diagnostics,
            audit: this.opts.audit,
          });

          this.sendResponse(id, {
            stopReason: result.reason,
            usage: result.usage,
          });
        } catch (err) {
          this.sendResponse(id, undefined, {
            code: -32603,
            message: `Agent loop execution failed: ${(err as Error).message}`,
          });
        } finally {
          managed.abortController = undefined;
        }
        break;
      }

      case "session/cancel": {
        const sessionId = String(params.sessionId ?? "");
        const managed = this.sessions.get(sessionId);
        if (managed?.abortController) {
          managed.abortController.abort();
        }
        this.sendResponse(id, { cancelled: Boolean(managed) });
        break;
      }

      case "session/destroy":
      case "session/close": {
        const sessionId = String(params.sessionId ?? "");
        const managed = this.sessions.get(sessionId);
        if (managed?.abortController) {
          managed.abortController.abort();
        }
        this.sessions.delete(sessionId);
        this.sendResponse(id, { ok: true });
        break;
      }

      default:
        this.sendResponse(id, undefined, {
          code: -32601,
          message: `Method not found: ${method}`,
        });
        break;
    }
  }

  private handleNotification(notif: JsonRpcNotification): void {
    if (notif.method === "session/cancel") {
      const sessionId = String(notif.params?.sessionId ?? "");
      const managed = this.sessions.get(sessionId);
      managed?.abortController?.abort();
    }
  }

  sendResponse(
    id: string | number | null,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    const resp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
    };
    if (error) {
      resp.error = error;
    } else {
      resp.result = result;
    }
    this.writeLine(JSON.stringify(resp));
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    const notif: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writeLine(JSON.stringify(notif));
  }

  private writeLine(line: string): void {
    this.opts.output.write(line + "\n");
  }
}
