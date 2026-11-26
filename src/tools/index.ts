import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import { ToolRegistry } from "./registry.ts";
import { writeTool } from "./write.ts";

/**
 * The default four-tool core plus search helpers.
 * Add tools only in response to an observed failure mode.
 */
export function createToolRegistry(opts?: { includeSearch?: boolean }): ToolRegistry {
  const tools = [bashTool, readTool, editTool, writeTool];
  if (opts?.includeSearch !== false) tools.push(globTool, grepTool);
  return new ToolRegistry(tools);
}

export { ToolRegistry, defineTool } from "./registry.ts";
export { bashTool, readTool, editTool, writeTool, globTool, grepTool };