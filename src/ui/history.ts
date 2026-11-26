import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_ENTRIES = 500;

export function historyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HARNESS_HOME ?? join(homedir(), ".config", "harness"), "history");
}

/**
 * Prompt history, one JSON string per line so multi-line entries survive.
 * Loaded once at startup; saved after each submitted line (a few hundred
 * bytes — not worth debouncing).
 */
export async function loadHistory(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    const text = await readFile(historyPath(env), "utf8");
    const entries: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed === "string" && parsed.trim()) entries.push(parsed);
      } catch {
        // Skip a torn line rather than losing the whole history.
      }
    }
    return entries.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export async function saveHistory(
  entries: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = historyPath(env);
  try {
    await mkdir(dirname(path), { recursive: true });
    const body = entries
      .slice(-MAX_ENTRIES)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await writeFile(path, `${body}\n`, "utf8");
  } catch {
    // History is a convenience; never fail a session over it.
  }
}

/** Add an entry, skipping blanks and consecutive duplicates. */
export function pushHistory(entries: string[], line: string): void {
  const value = line.replace(/\s+$/, "");
  if (!value.trim()) return;
  if (entries[entries.length - 1] === value) return;
  entries.push(value);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}