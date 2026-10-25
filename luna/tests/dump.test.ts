import { it } from 'vitest';
import { tokenize } from '../src/language/lexer';

const dump = (name: string, src: string) => {
  const { tokens, diagnostics } = tokenize(src);
  console.log('===', name, 'DIAGS', JSON.stringify(diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`)));
  for (const t of tokens) console.log('TOK', t.type, JSON.stringify(t.value.slice(0, 40)), t.pos.line + ':' + t.pos.column);
};

it('dump', () => {
  dump('simple render', 'render { <h1>Hello</h1> }');
  dump('interp', 'state c = 0\nrender { <p>{c}</p> }');
  dump('on wrapper', 'state c = 0\nrender { <on click { c = c + 1 } <button>+1</button> }');
  dump('for directive', 'state xs = []\nrender { <ul>{for x in xs <li>{x}</li>}</ul> }');
  dump('landing input', 'state draft = ""\nrender { <input value="{draft}" on keyup { if key == "Enter" { } } /> }');
});
