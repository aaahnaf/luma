// HTML exporter: compile a Luna source file to a standalone, static .html page.
// The exported document embeds the compiled runtime + program so interactivity
// (state, events) works when opened directly in a browser — no server needed.

import { compileSource } from './compiler';

export interface ExportResult {
  ok: boolean;
  html: string;
  diagnosticsText: string;
}

/** Compile `source` and return a self-contained HTML document. */
export function exportHtml(source: string): ExportResult {
  const result = compileSource(source);
  if (!result.output) {
    const text = result.diagnostics
      .map((d) => `${d.severity}: line ${d.line}:${d.column} — ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ''}`)
      .join('\n');
    return { ok: false, html: '', diagnosticsText: text };
  }
  return { ok: true, html: result.output.html, diagnosticsText: result.diagnostics.map((d) => `${d.severity}: ${d.message}`).join('\n') };
}
