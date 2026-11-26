/**
 * Skill definitions and frontmatter metadata.
 */

export interface Skill {
  name: string;
  description: string;
  args?: string;
  mode?: "plan" | "default" | "yolo";
  body: string;
  path: string;
  origin: "project" | "user";
}
