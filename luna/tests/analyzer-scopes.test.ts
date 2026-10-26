// Regression tests for the analyzer scope bug:
// globalScope.vars was pre-seeded with every top-level declaration name, then
// walkStatements re-declared each one via declare(), producing a false
// `"x" is already declared in this scope` error for EVERY top-level
// state/let/fn. Fixed in src/language/analyzer.ts by starting globalScope empty
// (duplicate detection remains covered by the seenTop pre-pass).

import { describe, it, expect } from 'vitest';
import { compileSource } from '../src/language/compiler';

const errors = (src: string) =>
  compileSource(src).diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.line}:${d.column} ${d.message}`);

describe('analyzer regression: top-level declarations are not false duplicates', () => {
  it('accepts a single top-level state used later', () => {
    expect(errors('state xs = []\npush(xs, 1)\nrender { <i>{len(xs)}</i> }')).toEqual([]);
  });

  it('accepts multiple distinct top-level let/state/fn declarations', () => {
    expect(
      errors(`
        let a = 1
        state b = 2
        fn add(x) { return x + b }
        render { <p>{add(a)}</p> }
      `),
    ).toEqual([]);
  });

  it('still rejects genuine duplicate top-level names', () => {
    const errs = errors('state xs = []\nlet xs = 1\nrender { <i>{xs}</i> }');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).toMatch(/xs/);
  });

  it('still rejects shadowing within the same nested function scope', () => {
    const errs = errors('fn f() {\n  let y = 1\n  let y = 2\n}\nrender { <i>1</i> }');
    expect(errs.join('\n')).toMatch(/already declared/);
  });

  it('component bodies can reference top-level state without duplicate errors', () => {
    // NOTE: a `component Badge(label: "?")` header currently hits a SEPARATE,
    // still-open lexer defect (string default values inside parameter lists are
    // mis-tokenized → parser error "Expected \",\" or \")\" in parameter list";
    // see baseline failure "supports components with props"). To isolate the
    // scope regression, this test uses a component with no prop defaults.
    expect(
      errors(`
        state count = 0
        component Badge() { render { <em>{count}</em> } }
        render { <Badge /> }
      `),
    ).toEqual([]);
  });

  it('suggests the correct name for a typo in an expression statement', () => {
    // Regression: nearestName() only searched the innermost scope.vars, so the
    // "did you mean" hint was missing for names declared at the top level.
    // (The render-markup variant `state counter = 0\nrender { <p>{countr}</p> }`
    // is still blocked by the separate open lexer defect "Unterminated render
    // block", which also makes the baseline test "rejects unknown identifiers
    // with suggestions" fail — see IMPLEMENTATION_STATUS.md.)
    const r = compileSource('state counter = 0\nlet y = countr + 1');
    const err = r.diagnostics.find((d) => d.severity === 'error' && /Unknown name/.test(d.message));
    expect(err).toBeTruthy();
    expect(err!.hint ?? err!.message).toMatch(/counter/);
  });
});
