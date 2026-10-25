// Top-level compiler entry: source text -> tokens -> AST -> diagnostics -> output.

import { tokenize } from './lexer';
import { parse } from './parser';
import { analyze } from './analyzer';
import { compile as codegen, CompiledOutput } from './codegen';
import { Diagnostic } from './diagnostics';
import * as AST from './ast';

export interface CompileResult {
  program: AST.Program | null;
  diagnostics: Diagnostic[];
  output: CompiledOutput | null;
}

export function compileSource(source: string): CompileResult {
  const { tokens, diagnostics: lexDiags } = tokenize(source);
  if (lexDiags.length) {
    return { program: null, diagnostics: lexDiags, output: null };
  }
  const { program, diagnostics: parseDiags } = parse(tokens, source);
  if (!program || parseDiags.some((d) => d.severity === 'error')) {
    return { program, diagnostics: [...parseDiags], output: null };
  }
  const analysisDiags = analyze(program);
  if (analysisDiags.some((d) => d.severity === 'error')) {
    return { program, diagnostics: [...parseDiags, ...analysisDiags], output: null };
  }
  try {
    const output = codegen(program);
    return { program, diagnostics: [...parseDiags, ...analysisDiags], output };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      program,
      diagnostics: [...parseDiags, ...analysisDiags, { severity: 'error', message: `Internal compiler error: ${msg}`, line: 1, column: 1 }],
      output: null,
    };
  }
}

export type { CompiledOutput };
