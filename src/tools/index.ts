import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import { ToolRegistry } from "./registry.ts";
import { writeTool } from "./write.ts";
import { diffTool, getGitDiff, createUnifiedDiff } from "./diff.ts";
import { diagnosticsTool } from "./diagnostics.ts";

/**
 * The default tool core plus search, diff, and diagnostics helpers.
 */
export function createToolRegistry(opts?: { includeSearch?: boolean; includeM3Tools?: boolean }): ToolRegistry {
  const tools = [bashTool, readTool, editTool, writeTool];
  if (opts?.includeSearch !== false) tools.push(globTool, grepTool);
  if (opts?.includeM3Tools !== false) tools.push(diffTool, diagnosticsTool);
  return new ToolRegistry(tools);
}

export { ToolRegistry, defineTool } from "./registry.ts";
export {
  bashTool,
  readTool,
  editTool,
  writeTool,
  globTool,
  grepTool,
  diffTool,
  diagnosticsTool,
  getGitDiff,
  createUnifiedDiff,
};
