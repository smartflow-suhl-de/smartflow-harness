import type { AgentEvent } from "../core/types.ts";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface AcpServerInfo {
  name: string;
  version: string;
}

export interface AcpCapabilities {
  prompts?: boolean;
  cancel?: boolean;
  streaming?: boolean;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  serverInfo: AcpServerInfo;
  capabilities: AcpCapabilities;
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  event: AgentEvent;
}
