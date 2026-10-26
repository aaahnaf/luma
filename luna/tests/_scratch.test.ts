import { it } from 'vitest';
import { tokenize } from '../src/language/lexer';
it('on wrapper tokens', () => {
  const src = 'state n = 0\nfn bump() { n = n + 1 }\nrender {\n  <on click { bump() } <button>go</button>\n}';
  const r = tokenize(src);
  console.log('DIAGS:', r.diagnostics.map(d=>`${d.line}:${d.column} ${d.message}`).join('|'));
  for (const t of r.tokens) console.log(`  ${t.type} ${JSON.stringify(t.value).slice(0,50)}${t.tag ? ' TAG=' + JSON.stringify({name:t.tag.name,closing:t.tag.closing,selfClosing:t.tag.selfClosing,attrs:t.tag.attrs}).slice(0,220) : ''}`);
});
