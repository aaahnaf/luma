// Diagnostics for the Luna compiler.

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line: number; // 1-based
  column: number; // 1-based
  /** Optional hint shown after the message, e.g. "Did you mean ...?" */
  hint?: string;
}

export function error(message: string, line: number, column: number, hint?: string): Diagnostic {
  return { severity: 'error', message, line, column, hint };
}

export function warning(message: string, line: number, column: number, hint?: string): Diagnostic {
  return { severity: 'warning', message, line, column, hint };
}

/** Format a diagnostic like a classic compiler message: file:line:col: message */
export function formatDiagnostic(d: Diagnostic, file = 'main.luna'): string {
  const hint = d.hint ? ` (${d.hint})` : '';
  return `${file}:${d.line}:${d.column}: ${d.severity}: ${d.message}${hint}`;
}
