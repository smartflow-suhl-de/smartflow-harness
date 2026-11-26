import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { defineTool, ok, optionalNumber, requireString } from "./registry.ts";

const MAX_LINES = 2000;

/** Read with line numbers so the model can talk about positions reliably. */
export const readTool = defineTool({
  name: "read",
  description:
    "Read a text file and return it with line numbers. " +
    "Use offset and limit for large files; output is capped at 2000 lines. " +
    "Always read a file before editing it.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute" },
      offset: { type: "number", description: "1-based first line (default 1)" },
      limit: { type: "number", description: "Number of lines (default 2000)" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const path = resolvePath(requireString(args, "path"), ctx.cwd);
    const offset = Math.max(1, optionalNumber(args, "offset") ?? 1);
    const limit = Math.min(MAX_LINES, Math.max(1, optionalNumber(args, "limit") ?? MAX_LINES));

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      return { ok: false, output: `cannot read ${path}: ${(err as Error).message}` };
    }

    if (text.includes("\u0000")) {
      return { ok: false, output: `${path} looks binary; use bash (e.g. file, xxd) instead` };
    }

    const lines = text.split("\n");
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    if (selected.length === 0) {
      return ok(`(${path} has ${lines.length} lines; offset ${offset} is past the end)`);
    }

    const width = String(offset + selected.length - 1).length;
    const body = selected
      .map((line, i) => `${String(offset + i).padStart(width, " ")}\t${line}`)
      .join("\n");

    const more =
      offset - 1 + selected.length < lines.length
        ? `\n… (${lines.length - (offset - 1 + selected.length)} more lines; use offset)`
        : "";

    return ok(`${body}${more}`, `${selected.length} lines`);
  },
});

export function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}