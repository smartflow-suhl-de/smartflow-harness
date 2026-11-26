/**
 * In-process subagent types.
 */

export interface SubagentDefinition {
  name: string;
  description: string;
  mode?: "plan" | "default" | "yolo";
  systemPrompt: string;
  maxSteps?: number;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  path?: string;
  origin: "project" | "user" | "builtin";
}
