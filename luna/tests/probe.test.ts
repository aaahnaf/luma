import { test, expect } from 'vitest';
import { tokenize as lex } from '../src/language/lexer';
test('probe interp', () => {
  const src = `state count = 0\nrender {\n  <div>\n    <span id="out">{count}</span>\n    <on click { count = count + 1 } <button id="inc">+1</button>\n  </div>\n}`;
  const r = lex(src);
  const lines: string[] = [];
  for (const d of r.diagnostics) lines.push(`DIAG ${d.line}:${d.column} ${d.message}`);
  for (const t of r.tokens) lines.push(`${t.type}|${JSON.stringify(t.value.slice(0,55))}|${t.pos.line}:${t.pos.column}|${t.tag?JSON.stringify(t.tag):''}`);
  expect(lines.join('\n')).toBe('SENTINEL');
});
