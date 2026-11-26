import { createBashTool } from "./bash.ts";
import type { SandboxConfig } from "../safety/sandbox.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import { ToolRegistry } from "./registry.ts";
import { writeTool } from "./write.ts";
import { diffTool, getGitDiff, createUnifiedDiff } from "./diff.ts";
import { diagnosticsTool } from "./diagnostics.ts";
import { searchTools, createToolSearchTool, DEFERRED_THRESHOLD } from "./search.ts";
import { createSubagentTool } from "../subagents/tool.ts";

/**
 * The default tool core plus search, diff, diagnostics and deferred loading helpers.
 */
export function createToolRegistry(opts?: {
  includeSearch?: boolean;
  includeM3Tools?: boolean;
  autoDeferThreshold?: number;
  /** OS sandbox settings for the bash tool. */
  sandbox?: SandboxConfig;
}): ToolRegistry {
  const bashTool = createBashTool(opts?.sandbox);
  const tools = [bashTool, readTool, editTool, writeTool];
  if (opts?.includeSearch !== false) tools.push(globTool, grepTool);
  if (opts?.includeM3Tools !== false) tools.push(diffTool, diagnosticsTool);
  return new ToolRegistry(tools, { autoDeferThreshold: opts?.autoDeferThreshold });
}

export { ToolRegistry, defineTool } from "./registry.ts";
export {
  createBashTool,
  readTool,
  editTool,
  writeTool,
  globTool,
  grepTool,
  diffTool,
  diagnosticsTool,
  getGitDiff,
  createUnifiedDiff,
  searchTools,
  createToolSearchTool,
  DEFERRED_THRESHOLD,
  createSubagentTool,
};
