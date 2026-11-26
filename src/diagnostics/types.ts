/**
 * Diagnostics types for LSP and compiler diagnostics.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  file: string;
  line?: number;
  column?: number;
  severity: DiagnosticSeverity;
  message: string;
  code?: string | number;
  source?: string;
}

export interface DiagnosticResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  summary: string;
  raw?: string;
}
