import { it } from 'vitest';
import * as fs from 'fs';
const src = fs.readFileSync('/tmp/insrc.txt', 'utf8');
it('dump', async () => {
  const lex = await import('../src/language/lexer?_v=' + Date.now());
  let out: string;
  try {
    const r = lex.tokenize(src);
    out = `DIAGS: ${JSON.stringify(r.diagnostics.map(d=>d.line+':'+d.column+' '+d.message))}\nNTOKENS: ${r.tokens.length}\n`;
    for (const t of r.tokens) out += `${t.type}|${JSON.stringify(t.value.slice(0,55))}|${t.pos.line}:${t.pos.column}|${t.tag ? JSON.stringify(t.tag) : ''}\n`;
  } catch (e) {
    out = 'THROWN: ' + ((e as Error).message || String(e)) + '\nSTACK: ' + (e as Error).stack;
  }
  fs.writeFileSync('/tmp/tokendump.txt', out);
});
