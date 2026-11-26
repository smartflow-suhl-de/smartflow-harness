import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SubagentDefinition } from "./types.ts";

export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: "research",
    description: "Read-only research subagent for surveying codebase, documentation, and references",
    mode: "plan",
    systemPrompt:
      "You are a research subagent. Use read-only inspection tools (read, grep, glob, diff) " +
      "to investigate the codebase and return a complete, factual report. Never alter files.",
    maxSteps: 20,
    origin: "builtin",
  },
  {
    name: "review",
    description: "Read-only code review subagent for auditing bugs, regressions, and security issues",
    mode: "plan",
    systemPrompt:
      "You are a code review subagent. Audit changes, logic invariants, potential regressions, " +
      "and security issues without modifying any files.",
    maxSteps: 20,
    origin: "builtin",
  },
];

/**
 * Parses markdown with YAML frontmatter into a SubagentDefinition.
 */
export function parseSubagent(
  content: string,
  filePath: string,
  origin: "project" | "user" = "project",
): SubagentDefinition | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const defaultName = basename(filePath).replace(/\.(md|markdown)$/i, "");

  let frontmatter: Record<string, string> = {};
  let systemPrompt = content.trim();

  if (match) {
    const rawFm = match[1]!;
    systemPrompt = match[2]!.trim();

    for (const rawLine of rawFm.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
        frontmatter[key] = value;
      }
    }
  }

  const name = frontmatter.name || defaultName;
  const description = frontmatter.description || `Subagent ${name}`;
  const mode = (frontmatter.mode as SubagentDefinition["mode"]) || "plan";
  const maxSteps = frontmatter.maxSteps ? Number(frontmatter.maxSteps) : undefined;

  return {
    name,
    description,
    mode,
    systemPrompt: systemPrompt || description,
    maxSteps,
    path: filePath,
    origin,
  };
}

/**
 * Discovers subagents from project, user, and built-in sources.
 */
export async function discoverSubagents(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubagentDefinition[]> {
  const userHome = env.HARNESS_HOME ?? join(homedir(), ".config", "harness");
  const candidates: Array<{ dir: string; origin: "project" | "user" }> = [
    { dir: join(userHome, "agents"), origin: "user" },
    { dir: join(cwd, ".agents"), origin: "project" },
    { dir: join(cwd, "agents"), origin: "project" },
  ];

  const byName = new Map<string, SubagentDefinition>();

  // Built-ins first (lowest precedence)
  for (const agent of BUILTIN_SUBAGENTS) {
    byName.set(agent.name, agent);
  }

  // File-based agents override built-ins
  for (const { dir, origin } of candidates) {
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;

      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".markdown"))) {
          const fullPath = join(dir, entry.name);
          const content = await readFile(fullPath, "utf8");
          const agent = parseSubagent(content, fullPath, origin);
          if (agent) byName.set(agent.name, agent);
        }
      }
    } catch {
      // Directory doesn't exist, ignore
    }
  }

  return [...byName.values()];
}
