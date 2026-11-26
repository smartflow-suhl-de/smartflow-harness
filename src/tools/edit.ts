import { readFile, writeFile } from "node:fs/promises";
import { defineTool, fail, ok, requireString } from "./registry.ts";
import { resolvePath } from "./read.ts";

/**
 * Exact-substring editing, in two stages:
 *   1. byte-exact unique match (what frontier models are good at)
 *   2. whitespace-tolerant unique match (indentation drift, tabs vs spaces)
 *
 * Never line-number based: models drift on line numbers far more than on
 * surrounding context. When nothing matches, fail loudly with context instead
 * of guessing.
 */
export const editTool = defineTool({
  name: "edit",
  description:
    "Replace an exact string in a file. old_string must be unique in the file " +
    "unless replace_all is true; include a few lines of surrounding context to make it unique. " +
    "Read the file first.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const path = resolvePath(requireString(args, "path"), ctx.cwd);
    const oldString = requireString(args, "old_string");
    const newString = String(args.new_string ?? "");
    const replaceAll = args.replace_all === true;

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      return fail(`cannot read ${path}: ${(err as Error).message}`);
    }

    if (oldString === newString) return fail("old_string and new_string are identical");

    const result = applyEdit(text, oldString, newString, replaceAll);
    if (!result.ok) return fail(result.error);

    try {
      await writeFile(path, result.text, "utf8");
    } catch (err) {
      return fail(`cannot write ${path}: ${(err as Error).message}`);
    }

    return ok(
      `edited ${path}: ${result.strategy}, ${result.count} replacement${result.count === 1 ? "" : "s"}`,
      `edited ${path}`,
    );
  },
});

type EditOutcome =
  | { ok: true; text: string; count: number; strategy: "exact" | "whitespace" }
  | { ok: false; error: string };

export function applyEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditOutcome {
  const exactCount = countOccurrences(text, oldString);
  if (exactCount === 1 || (replaceAll && exactCount > 0)) {
    return {
      ok: true,
      text: replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString),
      count: replaceAll ? exactCount : 1,
      strategy: "exact",
    };
  }
  if (exactCount > 1) {
    return {
      ok: false,
      error:
        `old_string matches ${exactCount} times. Add surrounding context to make it unique ` +
        `or pass replace_all: true.`,
    };
  }

  // Stage 2: whitespace-tolerant match, still requiring uniqueness.
  const flexible = new RegExp(toFlexiblePattern(oldString), "g");
  const matches = [...text.matchAll(flexible)];
  if (matches.length === 1) {
    const match = matches[0]!;
    const index = match.index ?? 0;
    const replaced = text.slice(0, index) + newString + text.slice(index + match[0].length);
    return { ok: true, text: replaced, count: 1, strategy: "whitespace" };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `old_string matches ${matches.length} times when ignoring whitespace. ` +
        `Add more context or pass replace_all: true.`,
    };
  }

  return {
    ok: false,
    error: `old_string not found in the file. Read the file again and copy the exact text, including indentation.`,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function toFlexiblePattern(s: string): string {
  return s
    .split("\n")
    .map((line) => `\\s*${line.trim().split(/\s+/).filter(Boolean).map(escapeRegex).join("\\s+")}`)
    .join("\\s*\\n\\s*");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}