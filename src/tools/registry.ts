import type { JsonSchema, Tool, ToolResult, ToolSpec } from "../core/types.ts";
import { createToolSearchTool } from "./search.ts";

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
  private readonly active = new Set<string>();
  private readonly deferred = new Set<string>();
  private searchTool?: Tool;

  constructor(tools: Tool[] = [], opts?: { autoDeferThreshold?: number }) {
    for (const tool of tools) this.register(tool);
    if (opts?.autoDeferThreshold && this.tools.size > opts.autoDeferThreshold) {
      this.applyAutoDefer(opts.autoDeferThreshold);
    }
  }

  register(tool: Tool, opts?: { deferred?: boolean }): this {
    this.tools.set(tool.spec.name, tool);
    if (opts?.deferred) {
      this.deferred.add(tool.spec.name);
      this.active.delete(tool.spec.name);
    } else {
      this.active.add(tool.spec.name);
      this.deferred.delete(tool.spec.name);
    }
    return this;
  }

  activate(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.deferred.delete(name);
    this.active.add(name);
    return true;
  }

  isDeferred(name: string): boolean {
    return this.deferred.has(name);
  }

  getDeferredTools(): Tool[] {
    return [...this.deferred].map((name) => this.tools.get(name)!).filter(Boolean);
  }

  getActiveTools(): Tool[] {
    return [...this.active].map((name) => this.tools.get(name)!).filter(Boolean);
  }

  applyAutoDefer(threshold = 15): void {
    const coreNames = new Set(["bash", "read", "write", "edit", "diff", "diagnostics"]);
    let count = 0;
    for (const [name] of this.tools) {
      if (coreNames.has(name)) {
        this.active.add(name);
        this.deferred.delete(name);
        count++;
      } else if (count < threshold) {
        this.active.add(name);
        this.deferred.delete(name);
        count++;
      } else {
        this.deferred.add(name);
        this.active.delete(name);
      }
    }
  }

  get(name: string): Tool | undefined {
    if (name === "tool_search" && this.deferred.size > 0) {
      return (this.searchTool ??= createToolSearchTool(this));
    }
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    const list: ToolSpec[] = [];
    for (const name of this.active) {
      const tool = this.tools.get(name);
      if (tool) list.push(tool.spec);
    }

    if (this.deferred.size > 0) {
      this.searchTool ??= createToolSearchTool(this);
      list.push(this.searchTool.spec);
    }

    return list;
  }

  names(): string[] {
    const names = [...this.active];
    if (this.deferred.size > 0) names.push("tool_search");
    return names;
  }

  allNames(): string[] {
    return [...this.tools.keys()];
  }

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
