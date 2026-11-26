import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, ok, requireString } from "./registry.ts";
import { resolvePath } from "./read.ts";

export const writeTool = defineTool({
  name: "write",
  description:
    "Create or overwrite a file with the given content. Prefer edit for changes to existing files: " +
    "overwriting a large file wastes tokens and can lose unrelated edits.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute" },
      content: { type: "string", description: "Complete new file content" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const path = resolvePath(requireString(args, "path"), ctx.cwd);
    const content = requireString(args, "content");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    } catch (err) {
      return { ok: false, output: `cannot write ${path}: ${(err as Error).message}` };
    }
    const lines = content.split("\n").length;
    return ok(`wrote ${path} (${content.length} bytes, ${lines} lines)`, `wrote ${path}`);
  },
});