import { test } from 'vitest';
import { tokenize, tokenizeMarkup } from '../src/language/lexer';

const show = (label: string, r: { tokens: any[]; diagnostics: any[] }) => {
  console.log('===', label, 'DIAGS', JSON.stringify(r.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`)));
  for (const t of r.tokens) console.log(`TOK ${t.type} ${JSON.stringify(t.value.slice(0, 50))}${t.tag ? ' tag=' + JSON.stringify(t.tag) : ''}`);
};

test('dump', () => {
  show('for directive', tokenize(`render {\n  <ul>\n    {for x in xs <li>{x}</li>}\n  </ul>\n}`));
  show('if directive', tokenize(`render { {if n > 2 <b>lots</b>} }`));
  show('on wrapper', tokenize(`state c = 0\nrender {\n  <on click { c = c + 1 } <button id="inc">+1</button>\n}`));
  show('inline event input', tokenize(`state q = ""\nrender {\n  <input value="{q}" on keyup { if key == "Enter" { addTodo() } } />\n}`));
  show('brace in string handler', tokenize(`render {\n  <on click { msg = "{a}" } <button>b</button>\n}`));
  show('nested render in component', tokenize(`component C() {\n  render { <em>[{label}]</em> }\n}`));
  show('markup sub-lex', tokenizeMarkup(`<span>{text}</span>`));
  show('directive body recover', tokenizeMarkup(`{for x in xs <li>{x}</li>}`));
});
