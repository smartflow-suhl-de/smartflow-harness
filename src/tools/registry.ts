import type { JsonSchema, Tool, ToolResult, ToolSpec } from "../core/types.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  readOnly: boolean;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, ctx: Parameters<Tool["execute"]>[1]): Promise<ToolResult>;
}

export function defineTool(def: ToolDefinition): Tool {
  return {
    spec: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      readOnly: def.readOnly,
    },
    execute: def.execute,
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): this {
    this.tools.set(tool.spec.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Names shown in prompts; useful when tools are filtered by mode. */
  describe(): string {
    return this.specs()
      .map((s) => `- ${s.name} (${s.readOnly ? "read-only" : "mutating"}): ${s.description}`)
      .join("\n");
  }
}

export function ok(output: string, summary?: string): ToolResult {
  return { ok: true, output, summary };
}

export function fail(output: string, summary?: string): ToolResult {
  return { ok: false, output, summary };
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`argument "${key}" must be a number`);
  return n;
}