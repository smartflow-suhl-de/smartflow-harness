import type { Provider } from "../provider/provider.ts";
import { runAgent } from "../core/loop.ts";
import { Session } from "../core/session.ts";
import type { Tool } from "../core/types.ts";
import { PermissionEngine } from "../safety/permissions.ts";
import { defineTool, fail, ok, requireString, ToolRegistry } from "../tools/registry.ts";
import type { SubagentDefinition } from "./types.ts";

export interface SubagentToolOptions {
  getSubagents: () => SubagentDefinition[];
  provider: Provider;
  baseTools: ToolRegistry;
  cwd: string;
}

/**
 * Creates the subagent delegation tool.
 */
export function createSubagentTool(opts: SubagentToolOptions): Tool {
  return defineTool({
    name: "subagent",
    description:
      "Delegate a sub-task or research question to a specialized in-process subagent with an isolated context. " +
      "The subagent executes in its own session without polluting your primary context window.",
    readOnly: false,
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Name of the subagent to invoke (e.g. 'research', 'review')",
        },
        prompt: {
          type: "string",
          description: "Detailed instruction or question for the subagent",
        },
      },
      required: ["agent", "prompt"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const agentName = requireString(args, "agent");
      const prompt = requireString(args, "prompt");

      const subagents = opts.getSubagents();
      const def = subagents.find((a) => a.name === agentName);

      if (!def) {
        return fail(
          `Unknown subagent "${agentName}". Available: ${subagents.map((a) => a.name).join(", ")}`,
        );
      }

      // Filter available tools for child agent (never allow recursive subagent calls)
      const allowedTools: Tool[] = [];
      for (const tool of opts.baseTools.getActiveTools()) {
        if (tool.spec.name === "subagent") continue;
        if (def.mode === "plan" && !tool.spec.readOnly) continue;
        if (def.tools?.allow && !def.tools.allow.includes(tool.spec.name)) continue;
        if (def.tools?.deny && def.tools.deny.includes(tool.spec.name)) continue;
        allowedTools.push(tool);
      }

      const childRegistry = new ToolRegistry(allowedTools);
      const childPermissions = new PermissionEngine({
        mode: def.mode ?? "plan",
        cwd: opts.cwd,
      });

      const childSession = Session.createEphemeral({
        cwd: opts.cwd,
        title: `subagent:${def.name}`,
      });

      await childSession.append({ role: "user", content: prompt });

      try {
        const result = await runAgent({
          session: childSession,
          provider: opts.provider,
          tools: childRegistry,
          permissions: childPermissions,
          systemPrompt: def.systemPrompt,
          cwd: opts.cwd,
          signal: ctx?.signal ?? new AbortController().signal,
          maxSteps: def.maxSteps ?? 20,
        });

        const assistantMessages = childSession.messages.filter((m) => m.role === "assistant" && m.content.trim());
        const lastAnswer = assistantMessages[assistantMessages.length - 1]?.content.trim();

        if (!lastAnswer) {
          return ok(
            `Subagent "${agentName}" finished with reason "${result.reason}" but returned no text.`,
            `subagent ${agentName} (${result.reason})`,
          );
        }

        return ok(
          lastAnswer,
          `subagent ${agentName} completed (${result.reason})`,
        );
      } catch (err) {
        return fail(`subagent "${agentName}" execution failed: ${(err as Error).message}`);
      }
    },
  });
}
