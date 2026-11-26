import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Skill } from "./types.ts";

/**
 * Parses markdown text with optional YAML frontmatter into a Skill object.
 */
export function parseSkill(
  content: string,
  filePath: string,
  origin: "project" | "user" = "project",
): Skill | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const defaultName = basename(filePath).replace(/\.(md|markdown)$/i, "");

  let frontmatter: Record<string, string> = {};
  let body = content;

  if (match) {
    const rawFm = match[1]!;
    body = match[2]!.trim();

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
  const description = frontmatter.description || `Skill ${name}`;
  const args = frontmatter.args;
  const mode = frontmatter.mode as Skill["mode"];

  if (!name) return undefined;

  return {
    name,
    description,
    args,
    mode,
    body,
    path: filePath,
    origin,
  };
}

/**
 * Renders a skill body with given argument values.
 */
export function renderSkill(skill: Skill, rawArgs: string): string {
  const trimmed = rawArgs.trim();
  let rendered = skill.body;

  if (rendered.includes("$ARGUMENTS") || rendered.includes("$@")) {
    rendered = rendered.replace(/\$ARGUMENTS|\$@/g, trimmed);
  } else if (trimmed) {
    rendered = `${rendered}\n\nArguments:\n${trimmed}`;
  }

  // Support positional parameters $1, $2, ...
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      rendered = rendered.replace(new RegExp(`\\$${i + 1}\\b`, "g"), parts[i]!);
    }
  }

  return rendered;
}

/**
 * Discovers skills from standard project and user locations.
 */
export async function discoverSkills(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Skill[]> {
  const userHome = env.HARNESS_HOME ?? join(homedir(), ".config", "harness");
  const candidates: Array<{ dir: string; origin: "project" | "user" }> = [
    { dir: join(userHome, "skills"), origin: "user" },
    { dir: join(cwd, ".skills"), origin: "project" },
    { dir: join(cwd, "skills"), origin: "project" },
    { dir: join(cwd, ".agents", "skills"), origin: "project" },
  ];

  const byName = new Map<string, Skill>();

  for (const { dir, origin } of candidates) {
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;

      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".markdown"))) {
          const fullPath = join(dir, entry.name);
          const content = await readFile(fullPath, "utf8");
          const skill = parseSkill(content, fullPath, origin);
          if (skill) byName.set(skill.name, skill);
        } else if (entry.isDirectory()) {
          // Check for subdir/SKILL.md convention (OpenBot / Claude skills)
          const skillFile = join(dir, entry.name, "SKILL.md");
          try {
            const content = await readFile(skillFile, "utf8");
            const skill = parseSkill(content, skillFile, origin);
            if (skill) byName.set(skill.name, skill);
          } catch {
            // No SKILL.md in subdir
          }
        }
      }
    } catch {
      // Directory doesn't exist, ignore
    }
  }

  return [...byName.values()];
}
