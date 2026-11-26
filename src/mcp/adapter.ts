import type { JsonSchema, Tool } from "../core/types.ts";
import { defineTool } from "../tools/registry.ts";
import type { McpClient } from "./client.ts";
import type { McpToolSchema } from "./types.ts";

const READ_ONLY_PREFIXES = ["get", "list", "read", "search", "find", "describe", "view", "show", "query"];

export function isMcpToolReadOnly(name: string): boolean {
  const lower = name.toLowerCase();
  return READ_ONLY_PREFIXES.some((prefix) => lower.startsWith(prefix) || lower.includes(`_${prefix}`) || lower.includes(`-${prefix}`));
}

export function mcpToolToTool(serverName: string, mcpTool: McpToolSchema, client: McpClient): Tool {
  const toolName = `${serverName}__${mcpTool.name}`;
  const readOnly = isMcpToolReadOnly(mcpTool.name);

  const parameters: JsonSchema = {
    type: "object",
    properties: mcpTool.inputSchema?.properties ?? {},
    ...(mcpTool.inputSchema?.required ? { required: mcpTool.inputSchema.required } : {}),
  };

  return defineTool({
    name: toolName,
    description: mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverName}`,
    readOnly,
    parameters,
    async execute(args) {
      return client.callTool(mcpTool.name, args);
    },
  });
}

export async function loadMcpTools(client: McpClient): Promise<Tool[]> {
  const schemas = await client.listTools();
  return schemas.map((schema) => mcpToolToTool(client.name, schema, client));
}
