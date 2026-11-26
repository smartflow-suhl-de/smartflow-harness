import { glob } from "node:fs/promises";
import { defineTool, ok, optionalNumber, requireString } from "./registry.ts";

const MAX_RESULTS = 500;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|\.next|\.cache)(\/|$)/;

export const globTool = defineTool({
  name: "glob",
  description:
    "Find files by glob pattern (e.g. \"src/**/*.ts\"). Sorted by newest first. " +
    "Use this instead of `find` when you know the filename pattern.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the workspace" },
      limit: { type: "number", description: `Max results (default ${MAX_RESULTS})` },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern");
    const limit = Math.min(2000, Math.max(1, optionalNumber(args, "limit") ?? MAX_RESULTS));

    const found: Array<{ path: string; mtime: number }> = [];
    try {
      for await (const entry of glob(pattern, { cwd: ctx.cwd })) {
        const path = String(entry);
        if (IGNORED.test(path)) continue;
        found.push({ path, mtime: 0 });
        if (found.length >= limit * 4) break;
      }
    } catch (err) {
      return { ok: false, output: `glob failed: ${(err as Error).message}` };
    }

    if (found.length === 0) return ok("(no files matched)");

    // Stat lazily for sorting; failures are fine (deleted mid-scan).
    const { stat } = await import("node:fs/promises");
    await Promise.all(
      found.map(async (f) => {
        try {
          f.mtime = (await stat(`${ctx.cwd}/${f.path}`)).mtimeMs;
        } catch {
          /* ignore */
        }
      }),
    );
    found.sort((a, b) => b.mtime - a.mtime);

    const shown = found.slice(0, limit).map((f) => f.path);
    const more = found.length > shown.length ? `\n… (${found.length - shown.length} more)` : "";
    return ok(shown.join("\n") + more, `${shown.length} files`);
  },
});