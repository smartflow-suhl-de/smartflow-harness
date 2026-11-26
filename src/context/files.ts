import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Names in discovery order. We read our neighbours' conventions, too. */
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];

const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 48_000;

export interface ContextFile {
  path: string;
  content: string;
  scope: "project" | "user";
}

/**
 * Hierarchical, deterministic context discovery — no RAG.
 *
 * From the workspace upward: AGENTS.md / CLAUDE.md / CONTEXT.md in each
 * directory (nearest last, so it wins by recency), plus a user-level file.
 * Every production harness converged on this pattern.
 */
export async function loadContextFiles(cwd: string): Promise<ContextFile[]> {
  const found: ContextFile[] = [];

  const userFile = join(homedir(), ".config", "harness", "AGENTS.md");
  const userContent = await tryRead(userFile, MAX_FILE_CHARS);
  if (userContent) found.push({ path: userFile, content: userContent, scope: "user" });

  const chain: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    chain.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const d of chain) {
    for (const name of CONTEXT_FILES) {
      const path = join(d, name);
      const content = await tryRead(path, MAX_FILE_CHARS);
      if (content) found.push({ path, content, scope: "project" });
    }
  }

  // Dedupe by path (symlinks, repeated dirs) and bound total size.
  const seen = new Set<string>();
  const unique = found.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));

  let total = 0;
  const bounded: ContextFile[] = [];
  for (const file of unique.reverse()) {
    if (total >= MAX_TOTAL_CHARS) break;
    const remaining = MAX_TOTAL_CHARS - total;
    const content = file.content.slice(0, remaining);
    bounded.push({ ...file, content });
    total += content.length;
  }
  return bounded.reverse();
}

/** Render context files into one prompt block. */
export function renderContextFiles(files: ContextFile[]): string {
  if (files.length === 0) return "";
  const blocks = files.map(
    (f) => `<context-file path="${f.path}" scope="${f.scope}">\n${f.content.trim()}\n</context-file>`,
  );
  return [
    "Project instructions. Follow them. The nearest file to the edited code wins on conflict.",
    ...blocks,
  ].join("\n\n");
}

async function tryRead(path: string, maxChars: number): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return undefined;
    const text = await readFile(path, "utf8");
    return text.slice(0, maxChars);
  } catch {
    return undefined;
  }
}