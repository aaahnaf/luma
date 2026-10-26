// Browser-side bridge to the real Luna compiler (src/language/*).
// The compiler is pure TypeScript with no Node-only APIs, so Vite bundles it
// straight into the page — no WASM/Emscripten involved.
//
// Everything is wrapped defensively: if compilation throws for any reason
// (broken lexer, parser bug, internal compiler error), we surface an honest
// error message to the UI instead of crashing Studio.

import { compileSource } from '../src/language/compiler';
import type { Diagnostic } from '../src/language/diagnostics';

export interface RunResult {
  ok: boolean;
  /** Self-contained HTML document produced by codegen (only when ok). */
  html: string;
  diagnostics: Diagnostic[];
  /** Fatal/unexpected failure text (compiler crashed, etc.). */
  fatal: string | null;
  /** Wall-clock compile time in ms. */
  elapsedMs: number;
}

export function runLuna(source: string): RunResult {
  const started = performance.now();
  try {
    const result = compileSource(source);
    const elapsedMs = performance.now() - started;
    if (result.output) {
      return { ok: true, html: result.output.html, diagnostics: result.diagnostics, fatal: null, elapsedMs };
    }
    return { ok: false, html: '', diagnostics: result.diagnostics, fatal: null, elapsedMs };
  } catch (err) {
    const message = err instanceof Error ? (err.stack || err.message) : String(err);
    return {
      ok: false,
      html: '',
      diagnostics: [],
      fatal: `The compiler crashed unexpectedly:\n${message}`,
      elapsedMs: performance.now() - started,
    };
  }
}

/** Format a diagnostic list the way the CLI/tests do, for the console panel. */
export function formatDiagnostics(diags: Diagnostic[]): string {
  return diags
    .map(
      (d) =>
        `${d.severity}: line ${d.line}:${d.column} — ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ''}`
    )
    .join('\n');
}
