import { describe, it, expect } from 'vitest';
import { compileSource } from '../src/language/compiler';

const ok = (src: string) => {
  const r = compileSource(src);
  if (r.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error('Unexpected errors:\n' + r.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join('\n'));
  }
  return r;
};

describe('lexer/parser/analyzer', () => {
  it('compiles a minimal page', () => {
    const r = ok(`page { title: "Hi" }\nrender { <h1>Hello</h1> }`);
    expect(r.output!.html).toContain('<title>Hi</title>');
    expect(r.output!.html).toContain('Hello');
  });

  it('reports unterminated strings', () => {
    const r = compileSource(`let s = "oops\n`);
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('rejects unknown identifiers with suggestions', () => {
    const r = compileSource(`state counter = 0\nrender { <p>{countr}</p> }`);
    const err = r.diagnostics.find((d) => d.severity === 'error');
    expect(err).toBeTruthy();
    expect(err!.hint ?? err!.message).toMatch(/counter/);
  });

  it('rejects lowercase component names', () => {
    const r = compileSource(`component card() { render { <div/> } }`);
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('validates component props', () => {
    const r = compileSource(`component Card(title: "") { render { <h2>{title}</h2> } }\nrender { <Card titel="x" /> }`);
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('accepts state, fn, events and loops', () => {
    ok(`
      state items = []
      state n = 0
      fn bump() { n = n + 1 }
      for i in range(3) { log(i) }
      render {
        <div>
          <on click { bump() } <button>go</button>
          {for x in items <span>{x}</span>}
          {if n > 2 <b>lots</b>}
        </div>
      }
    `);
  });
});

describe('codegen + runtime (jsdom)', () => {
  const run = (src: string) => {
    const r = ok(src);
    document.body.innerHTML = '<div id="luna-root"></div>';
    // eslint-disable-next-line no-new-func
    new Function(r.output!.js)();
    return document.body;
  };

  it('renders static markup', () => {
    const body = run(`render { <h1 class="t">Hello Luna</h1>`);
    expect(body.querySelector('h1.t')?.textContent).toBe('Hello Luna');
  });

  it('renders interpolation and reacts to state changes via events', async () => {
    const body = run(`
      state count = 0
      render {
        <div>
          <span id="out">{count}</span>
          <on click { count = count + 1 } <button id="inc">+1</button>
        </div>
      }
    `);
    expect(body.querySelector('#out')!.textContent).toBe('0');
    body.querySelector('#inc')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((res) => requestAnimationFrame(res));
    expect(body.querySelector('#out')!.textContent).toBe('1');
  });

  it('supports components with props', () => {
    const body = run(`
      component Badge(label: "?") { render { <em>[{label}]</em> } }
      render { <Badge label="new" /> }
    `);
    expect(body.querySelector('em')!.textContent).toBe('[new]');
  });

  it('supports for-in lists and conditionals', () => {
    const body = run(`
      state xs = ["a", "b"]
      render {
        <ul>
          {for x in xs <li>{x}</li>}
          {if len(xs) == 2 <p>two</p>}
        </ul>
      }
    `);
    expect(body.querySelectorAll('li').length).toBe(2);
    expect(body.querySelector('p')!.textContent).toBe('two');
  });

  it('supports builtins len/push/log', () => {
    const logs: unknown[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));
    const body = run(`
      state xs = []
      push(xs, 1)
      push(xs, 2)
      log(len(xs))
      render { <i>{len(xs)}</i> }
    `);
    console.log = orig;
    expect(logs).toContain('2');
    expect(body.querySelector('i')!.textContent).toBe('2');
  });
});

describe('example projects compile cleanly', () => {
  const fs = require('fs');
  for (const f of ['counter.luna', 'todo.luna', 'landing.luna']) {
    it(f, () => {
      const src = fs.readFileSync(`${__dirname}/../examples/${f}`, 'utf8');
      const r = compileSource(src);
      const errs = r.diagnostics.filter((d) => d.severity === 'error');
      expect(errs.map((e) => `${e.line}:${e.column} ${e.message}`)).toEqual([]);
      expect(r.output).toBeTruthy();
    });
  }
});
