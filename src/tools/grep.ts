import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { defineTool, ok, optionalNumber, requireString } from "./registry.ts";

const MAX_OUTPUT = 20_000;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|\.next|\.cache)(\/|$)/;

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents with a regular expression. Uses ripgrep when available " +
    "(fast, respects .gitignore) and falls back to a JS scan. " +
    "Use this instead of `grep -r` / `rg` in bash to keep output structured.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (RE2 syntax with ripgrep)" },
      glob: { type: "string", description: "Optional file glob, e.g. \"*.ts\"" },
      path: { type: "string", description: "Directory or file to search (default workspace)" },
      context_lines: { type: "number", description: "Lines of context (default 0)" },
      limit: { type: "number", description: "Max matches (default 200)" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern");
    const glob = typeof args.glob === "string" ? args.glob : undefined;
    const searchPath = typeof args.path === "string" && args.path ? args.path : ".";
    const contextLines = Math.max(0, Math.min(10, optionalNumber(args, "context_lines") ?? 0));
    const limit = Math.max(1, Math.min(1000, optionalNumber(args, "limit") ?? 200));

    if (await hasRipgrep()) {
      return rgSearch({ pattern, glob, searchPath, contextLines, limit, cwd: ctx.cwd, signal: ctx.signal });
    }
    return jsSearch({ pattern, glob, searchPath, limit, cwd: ctx.cwd });
  },
});

async function hasRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("rg", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function rgSearch(opts: {
  pattern: string;
  glob?: string;
  searchPath: string;
  contextLines: number;
  limit: number;
  cwd: string;
  signal: AbortSignal;
}) {
  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-columns=300",
    "--max-columns-preview",
    `--max-count=${opts.limit}`,
    ...(opts.contextLines ? ["-C", String(opts.contextLines)] : []),
    ...(opts.glob ? ["--glob", opts.glob] : []),
    "--",
    opts.pattern,
    opts.searchPath,
  ];

  return new Promise<{ ok: boolean; output: string; summary?: string }>((resolve) => {
    const child = spawn("rg", args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < MAX_OUTPUT * 2) out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", () => resolve({ ok: false, output: "ripgrep failed to start" }));
    child.on("close", (code) => {
      if (code === 2) {
        resolve({ ok: false, output: `grep failed: ${err.trim() || "invalid pattern"}` });
        return;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        resolve(ok("(no matches)"));
        return;
      }
      const count = trimmed.split("\n").length;
      resolve({
        ok: true,
        output: truncate(trimmed, MAX_OUTPUT),
        summary: `${count} lines`,
      });
    });
  });
}

async function jsSearch(opts: {
  pattern: string;
  glob?: string;
  searchPath: string;
  limit: number;
  cwd: string;
}) {
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, "g");
  } catch (err) {
    return { ok: false, output: `invalid pattern: ${(err as Error).message}` };
  }
  const globRe = opts.glob ? globToRegex(opts.glob) : undefined;
  const results: string[] = [];
  let scanned = 0;

  async function walk(dir: string, rel: string) {
    if (results.length >= opts.limit || scanned > 20_000) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= opts.limit) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (IGNORED.test(childRel)) continue;
      if (entry.isDirectory()) {
        await walk(`${dir}/${entry.name}`, childRel);
      } else if (entry.isFile()) {
        if (globRe && !globRe.test(childRel)) continue;
        scanned++;
        let text: string;
        try {
          text = await readFile(`${dir}/${entry.name}`, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        text.split("\n").forEach((line, i) => {
          if (results.length >= opts.limit) return;
          if (!re.test(line)) return;
          re.lastIndex = 0;
          results.push(`${childRel}:${i + 1}:${line.slice(0, 300)}`);
        });
      }
    }
  }

  await walk(`${opts.cwd}/${opts.searchPath}`.replace(/\/\.$/, ""), opts.searchPath === "." ? "" : opts.searchPath);
  if (results.length === 0) return ok("(no matches)");
  return ok(results.join("\n") + (results.length >= opts.limit ? `\n… (limit ${opts.limit})` : ""), `${results.length} matches`);
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${escaped}$`);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}