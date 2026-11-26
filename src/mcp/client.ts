import { StdioTransport } from "./transport.ts";
import type { McpServerConfig, McpToolCallResult, McpToolSchema } from "./types.ts";

export class McpClient {
  public readonly name: string;
  private readonly config: McpServerConfig;
  private transport: StdioTransport;
  private initialized = false;

  constructor(
    name: string,
    config: McpServerConfig,
    cwd?: string,
  ) {
    this.name = name;
    this.config = config;
    this.transport = new StdioTransport({
      command: config.command,
      args: config.args,
      cwd,
      env: config.env,
    });
  }

  async connect(timeoutMs = 15000): Promise<void> {
    if (this.initialized) return;

    this.transport.start();

    // Standard MCP handshake
    await this.transport.sendRequest(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "smartflow-harness",
          version: "0.1.0",
        },
      },
      timeoutMs,
    );

    this.transport.sendNotification("notifications/initialized");
    this.initialized = true;
  }

  async listTools(timeoutMs = 10000): Promise<McpToolSchema[]> {
    if (!this.initialized) await this.connect();

    const res = (await this.transport.sendRequest("tools/list", {}, timeoutMs)) as {
      tools?: McpToolSchema[];
    };

    return res.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 60000,
  ): Promise<{ ok: boolean; output: string; summary?: string }> {
    if (!this.initialized) await this.connect();

    try {
      const res = (await this.transport.sendRequest(
        "tools/call",
        { name, arguments: args },
        timeoutMs,
      )) as McpToolCallResult;

      const isError = res.isError === true;
      const texts: string[] = [];

      if (Array.isArray(res.content)) {
        for (const item of res.content) {
          if (item.type === "text" && item.text) {
            texts.push(item.text);
          } else if (item.text) {
            texts.push(item.text);
          }
        }
      }

      const output = texts.join("\n") || (isError ? "MCP tool reported an error without text" : "ok");
      return {
        ok: !isError,
        output,
        summary: `${this.name} ${name} ${isError ? "failed" : "ok"}`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `MCP tool call "${name}" failed: ${(err as Error).message}`,
        summary: `${this.name} ${name} error`,
      };
    }
  }

  close(): void {
    this.transport.close();
    this.initialized = false;
  }
}
