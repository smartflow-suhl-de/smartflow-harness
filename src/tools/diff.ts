import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool, ok, fail } from "./registry.ts";
import { resolvePath } from "./read.ts";

const execFileAsync = promisify(execFile);

/**
 * Computes line-based diff hunks between oldText and newText using an LCS table.
 */
export function computeDiffLines(
  oldLines: string[],
  newLines: string[],
): Array<{ type: "same" | "add" | "del"; line: string; oldIndex: number; newIndex: number }> {
  const m = oldLines.length;
  const n = newLines.length;

  // LCS DP table (optimized for typical file edits)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Backtrack to form sequence
  const result: Array<{ type: "same" | "add" | "del"; line: string; oldIndex: number; newIndex: number }> = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "same", line: oldLines[i - 1]!, oldIndex: i, newIndex: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ type: "add", line: newLines[j - 1]!, oldIndex: i, newIndex: j });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      result.unshift({ type: "del", line: oldLines[i - 1]!, oldIndex: i, newIndex: j });
      i--;
    }
  }

  return result;
}

/**
 * Generates a standard unified diff string between oldText and newText.
 * Returns empty string if oldText and newText are identical.
 */
export function createUnifiedDiff(
  oldPath: string,
  newPath: string,
  oldText: string,
  newText: string,
  contextLines = 3,
): string {
  if (oldText === newText) return "";

  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  const diffItems = computeDiffLines(oldLines, newLines);

  // Identify changed indices
  const changedIndices: number[] = [];
  for (let idx = 0; idx < diffItems.length; idx++) {
    if (diffItems[idx]!.type !== "same") {
      changedIndices.push(idx);
    }
  }

  if (changedIndices.length === 0) return "";

  // Group changed indices into hunks with contextLines
  interface HunkRange {
    start: number;
    end: number;
  }
  const hunkRanges: HunkRange[] = [];
  let currentHunk: HunkRange = {
    start: Math.max(0, changedIndices[0]! - contextLines),
    end: Math.min(diffItems.length - 1, changedIndices[0]! + contextLines),
  };

  for (let k = 1; k < changedIndices.length; k++) {
    const nextStart = Math.max(0, changedIndices[k]! - contextLines);
    const nextEnd = Math.min(diffItems.length - 1, changedIndices[k]! + contextLines);

    if (nextStart <= currentHunk.end + 1) {
      currentHunk.end = Math.max(currentHunk.end, nextEnd);
    } else {
      hunkRanges.push(currentHunk);
      currentHunk = { start: nextStart, end: nextEnd };
    }
  }
  hunkRanges.push(currentHunk);

  const header = `--- ${oldPath}\n+++ ${newPath}\n`;
  const hunkStrings: string[] = [];

  for (const range of hunkRanges) {
    const items = diffItems.slice(range.start, range.end + 1);
    let oldStart = 0;
    let oldCount = 0;
    let newStart = 0;
    let newCount = 0;

    for (const item of items) {
      if (item.type === "same") {
        if (oldStart === 0) oldStart = item.oldIndex;
        if (newStart === 0) newStart = item.newIndex;
        oldCount++;
        newCount++;
      } else if (item.type === "del") {
        if (oldStart === 0) oldStart = item.oldIndex;
        oldCount++;
      } else if (item.type === "add") {
        if (newStart === 0) newStart = item.newIndex;
        newCount++;
      }
    }

    if (oldStart === 0) oldStart = 1;
    if (newStart === 0) newStart = 1;

    const hunkHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    const lines = items.map((it) => {
      if (it.type === "same") return ` ${it.line}`;
      if (it.type === "add") return `+${it.line}`;
      return `-${it.line}`;
    });

    hunkStrings.push([hunkHeader, ...lines].join("\n"));
  }

  return header + hunkStrings.join("\n") + "\n";
}

/**
 * Executes git diff in cwd.
 */
export async function getGitDiff(
  cwd: string,
  opts?: { path?: string; staged?: boolean; signal?: AbortSignal },
): Promise<string> {
  const args = ["diff"];
  if (opts?.staged) args.push("--staged");
  if (opts?.path) {
    args.push("--", opts.path);
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      signal: opts?.signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    throw new Error(`git diff failed: ${(err as Error).message}`);
  }
}

/**
 * diffTool: Read-only tool inspecting workspace or file diffs.
 */
export const diffTool = defineTool({
  name: "diff",
  description:
    "Show unstaged or staged git diff in the workspace, or for a specific file. " +
    "Use to inspect recent changes before committing or reviewing.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional relative or absolute file path to diff" },
      staged: { type: "boolean", description: "Show staged changes instead of unstaged (default false)" },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const filePath = typeof args.path === "string" ? resolvePath(args.path, ctx.cwd) : undefined;
    const staged = args.staged === true;

    try {
      const diffOutput = await getGitDiff(ctx.cwd, {
        path: filePath ? filePath.replace(ctx.cwd + "/", "") : undefined,
        staged,
        signal: ctx.signal,
      });

      if (!diffOutput.trim()) {
        const target = filePath ? `for ${args.path}` : "in workspace";
        return ok(`No ${staged ? "staged " : ""}changes found ${target}.`, "no diff");
      }

      const lines = diffOutput.trim().split("\n").length;
      return ok(diffOutput, `diff: ${lines} lines`);
    } catch (err) {
      return fail(`cannot get diff: ${(err as Error).message}`);
    }
  },
});
