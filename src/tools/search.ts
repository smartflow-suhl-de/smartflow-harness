import type { Tool } from "../core/types.ts";
import { defineTool, ok, requireString } from "./registry.ts";
import type { ToolRegistry } from "./registry.ts";

export const DEFERRED_THRESHOLD = 15;

/**
 * Calculates a BM25-like token relevance score for a tool against a query.
 */
export function scoreTool(tool: Tool, query: string): number {
  const queryTokens = query
    .toLowerCase()
    .split(/[\s,._-]+/)
    .filter((t) => t.length > 1);

  if (queryTokens.length === 0) return 0;

  const name = tool.spec.name.toLowerCase();
  const desc = tool.spec.description.toLowerCase();
  const props = Object.keys(tool.spec.parameters.properties ?? {}).map((p) => p.toLowerCase());

  let score = 0;

  for (const token of queryTokens) {
    // Exact or partial name match (highest weight)
    if (name === token) score += 20;
    else if (name.includes(token)) score += 10;

    // Word match in description
    if (desc.includes(token)) score += 3;

    // Match in parameter names
    for (const prop of props) {
      if (prop === token) score += 5;
      else if (prop.includes(token)) score += 2;
    }
  }

  return score;
}

/**
 * Searches tools by relevance.
 */
export function searchTools(tools: Tool[], query: string, limit = 5): Tool[] {
  const scored = tools
    .map((tool) => ({ tool, score: scoreTool(tool, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.tool);
}

/**
 * Factory for the tool_search meta-tool.
 */
export function createToolSearchTool(registry: ToolRegistry): Tool {
  return defineTool({
    name: "tool_search",
    description:
      "Search for available deferred tools by keywords or capability description. " +
      "Matching tools will be loaded and become directly callable in subsequent turns.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Capability or action to search for, e.g. 'git commit', 'fetch data', 'math'",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args) {
      const query = requireString(args, "query");
      const deferredTools = registry.getDeferredTools();

      if (deferredTools.length === 0) {
        return ok("All available tools are already active and loaded in the toolset.", "no deferred tools");
      }

      const matches = searchTools(deferredTools, query, 5);

      if (matches.length === 0) {
        return ok(
          `No matching tools found for "${query}". Available deferred tool names: ` +
            deferredTools.map((t) => t.spec.name).slice(0, 10).join(", ") +
            (deferredTools.length > 10 ? ", ..." : ""),
          "no matches",
        );
      }

      // Automatically activate matched tools into the active set
      for (const tool of matches) {
        registry.activate(tool.spec.name);
      }

      const lines = [
        `Found and loaded ${matches.length} tool${matches.length === 1 ? "" : "s"}:`,
        ...matches.map((t) => `  - ${t.spec.name}: ${t.spec.description}`),
        "",
        "These tools are now active and ready to be called in your next turn.",
      ];

      return ok(lines.join("\n"), `loaded ${matches.length} tools`);
    },
  });
}
