import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative } from "node:path";
import type { Diagnostic, DiagnosticResult } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Regex matching standard TypeScript tsc output lines:
 * e.g. "src/cli.ts(12,5): error TS2304: Cannot find name 'foo'."
 * or   "src/cli.ts:12:5 - error TS2304: Cannot find name 'foo'."
 */
const TSC_REGEX_PAREN = /^([^(]+)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s+(.*)$/;
const TSC_REGEX_COLON = /^([^:]+):(\d+):(\d+)\s+-\s+(error|warning|info)\s+(TS\d+):\s+(.*)$/;

/**
 * Parses compiler/LSP output into Diagnostic records.
 */
export function parseDiagnostics(output: string, cwd?: string): Diagnostic[] {
  const lines = output.split("\n");
  const diagnostics: Diagnostic[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const matchParen = line.match(TSC_REGEX_PAREN);
    if (matchParen) {
      const filePath = cwd ? relative(cwd, matchParen[1]!.trim()) : matchParen[1]!.trim();
      diagnostics.push({
        file: filePath,
        line: Number(matchParen[2]),
        column: Number(matchParen[3]),
        severity: matchParen[4] as Diagnostic["severity"],
        code: matchParen[5],
        message: matchParen[6]!.trim(),
        source: "tsc",
      });
      continue;
    }

    const matchColon = line.match(TSC_REGEX_COLON);
    if (matchColon) {
      const filePath = cwd ? relative(cwd, matchColon[1]!.trim()) : matchColon[1]!.trim();
      diagnostics.push({
        file: filePath,
        line: Number(matchColon[2]),
        column: Number(matchColon[3]),
        severity: matchColon[4] as Diagnostic["severity"],
        code: matchColon[5],
        message: matchColon[6]!.trim(),
        source: "tsc",
      });
      continue;
    }
  }

  return diagnostics;
}

/**
 * Formats diagnostic records into concise, token-efficient text for the agent or CLI.
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return "clean (no errors or warnings)";
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  const lines: string[] = [
    `Found ${diagnostics.length} diagnostic issue${diagnostics.length === 1 ? "" : "s"} (${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}):`,
  ];

  for (const d of diagnostics) {
    const loc = d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : "";
    const code = d.code ? ` (${d.code})` : "";
    lines.push(`  [${d.severity}] ${d.file}${loc} - ${d.message}${code}`);
  }

  return lines.join("\n");
}

/**
 * Runs diagnostics (tsc --noEmit) in the given directory, optionally filtered by file.
 */
export async function runDiagnostics(opts: {
  cwd: string;
  file?: string;
  signal?: AbortSignal;
}): Promise<DiagnosticResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const res = await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd: opts.cwd,
      signal: opts.signal,
      maxBuffer: 5 * 1024 * 1024,
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    stdout = execErr.stdout ?? "";
    stderr = execErr.stderr ?? "";
    exitCode = execErr.code ?? 1;
  }

  const all = parseDiagnostics(stdout + "\n" + stderr, opts.cwd);
  let relevant = all;

  if (opts.file) {
    const normFile = relative(opts.cwd, opts.file).replace(/^\.\//, "");
    relevant = all.filter((d) => d.file.endsWith(normFile) || normFile.endsWith(d.file));
  }

  const errorCount = relevant.filter((d) => d.severity === "error").length;
  const ok = errorCount === 0 && (Boolean(opts.file) || exitCode === 0);

  const summary = relevant.length === 0
    ? (opts.file ? `no diagnostics for ${opts.file}` : "diagnostics clean")
    : `${relevant.length} issue${relevant.length === 1 ? "" : "s"}${opts.file ? ` in ${opts.file}` : ""}`;

  return {
    ok,
    diagnostics: relevant,
    summary,
    raw: stdout,
  };
}
