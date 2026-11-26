import { defineTool, ok, fail } from "./registry.ts";
import { resolvePath } from "./read.ts";
import { runDiagnostics, formatDiagnostics } from "../diagnostics/runner.ts";

export const diagnosticsTool = defineTool({
  name: "diagnostics",
  description:
    "Check for language errors, type errors, and syntax diagnostics in a file or the whole workspace. " +
    "Use after editing code to confirm type safety and discover compile errors without running full tests.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional file path to inspect diagnostics for. If omitted, checks the entire workspace.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const targetPath = typeof args.path === "string" ? resolvePath(args.path, ctx.cwd) : undefined;

    try {
      const result = await runDiagnostics({
        cwd: ctx.cwd,
        file: targetPath,
        signal: ctx.signal,
      });

      const formatted = formatDiagnostics(result.diagnostics);
      if (result.ok) {
        return ok(formatted, result.summary);
      } else {
        return {
          ok: false,
          output: formatted,
          summary: result.summary,
        };
      }
    } catch (err) {
      return fail(`diagnostics execution failed: ${(err as Error).message}`);
    }
  },
});
