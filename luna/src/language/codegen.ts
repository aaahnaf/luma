// Code generation for the Luna language.
// Compiles an analyzed AST.Program into a standalone HTML document with
// embedded CSS and JavaScript. The runtime is plain source text (RUNTIME_JS)
// shared between the Studio preview iframe and single-file export.
//
// Design notes:
// - User functions are real JS `function` declarations, so closures work naturally.
// - Builtins (log, len, store, ...) compile to `_bi.name(...)` calls.
// - UI specs are lazy: dynamic attributes/children become thunks `() => expr`
//   evaluated at render time, so re-rendering after state changes shows current values.
// - Reactivity model: top-level statements run once; event handlers mutate
//   state and trigger `_scheduleUpdate()` which rebuilds mounted UI from the
//   stored spec trees (thunks re-evaluated).

import * as AST from './ast';
import { VOID_HTML } from './parser';

export interface CompiledOutput {
  html: string;
  css: string;
  js: string;
}

/** Escape a string for use in HTML text content. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Escape a string for use in a double-quoted HTML attribute. */
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const BUILTIN_NAMES = [
  'log', 'warn', 'error', 'string', 'number', 'boolean', 'len', 'keys', 'values',
  'push', 'pop', 'join', 'split', 'slice', 'lower', 'upper', 'trim', 'round',
  'floor', 'ceil', 'abs', 'min', 'max', 'random', 'parseInt', 'parseFloat',
  'store', 'retrieve', 'unstore', 'delay', 'fetchJSON', 'json', 'math', 'escapeHtml', 'range',
];
const BUILTINS = new Set(BUILTIN_NAMES);

class Gen {
  fnNames = new Set<string>();
  componentNames = new Set<string>();
  evtCounter = 0;
  /** When set, render statements append to this JS expression instead of "body". */
  regionOverride: string | null = null;

  // ---------- expressions ----------

  expr(e: AST.Expr): string {
    switch (e.kind) {
      case 'StringLit':
        return JSON.stringify(e.value);
      case 'NumberLit':
        return String(e.value);
      case 'BoolLit':
        return e.value ? 'true' : 'false';
      case 'NullLit':
        return 'null';
      case 'Ident':
        return e.name;
      case 'TemplateLit': {
        const parts = e.parts.map((p) => (p.kind === 'StringLit' ? JSON.stringify(p.value) : `_toStr(${this.expr(p)})`));
        return parts.length ? `(${parts.join(' + ')})` : '""';
      }
      case 'ArrayLit':
        return `[${e.elements.map((x) => this.expr(x)).join(', ')}]`;
      case 'ObjectLit': {
        const props = e.properties.map((p) =>
          p.computed ? `[${this.expr(p.keyExpr!)}]: ${this.expr(p.value)}` : `${JSON.stringify(p.key)}: ${this.expr(p.value)}`,
        );
        return `{ ${props.join(', ')} }`;
      }
      case 'UnaryExpr':
        return e.op === '-' ? `(-${this.expr(e.operand)})` : `(!_truthy(${this.expr(e.operand)}))`;
      case 'BinaryExpr': {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        const op: string = e.op;
        switch (op) {
          case '+': return `_add(${left}, ${right})`;
          case '-': return `(${left} - ${right})`;
          case '*': return `(${left} * ${right})`;
          case '/': return `(${left} / ${right})`;
          case '%': return `(${left} % ${right})`;
          case '==': return `(_eq(${left}, ${right}))`;
          case '!=': return `(!_eq(${left}, ${right}))`;
          case '<': return `(${left} < ${right})`;
          case '>': return `(${left} > ${right})`;
          case '<=': return `(${left} <= ${right})`;
          case '>=': return `(${left} >= ${right})`;
          case 'and': return `(${left} && ${right})`;
          case 'or': return `(${left} || ${right})`;
          default: throw new Error(`Unsupported operator "${op}"`);
        }
      }
      case 'CallExpr':
        return `${this.calleeRef(e.callee)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'MemberExpr':
        return `_get(${this.expr(e.object)}, ${JSON.stringify((e.property as AST.Ident).name)})`;
      case 'IndexExpr':
        return `_idx(${this.expr(e.object)}, ${this.expr(e.index)})`;
      case 'AssignExpr':
        // Direct JS assignment; identifiers resolve to the nearest lexical
        // declaration (let/state/fn params/loop vars), giving correct closure
        // capture semantics for free.
        return `(${this.expr(e.target)} = ${this.expr(e.value)})`;
      case 'TernaryExpr':
        return `(_truthy(${this.expr(e.condition)}) ? ${this.expr(e.thenExpr)} : ${this.expr(e.elseExpr)})`;
      case 'FnExpr': {
        const params = e.params.map((p) => `${p.name}${p.defaultExpr ? ` = ${this.expr(p.defaultExpr)}` : ''}`).join(', ');
        if (e.body.kind !== 'Block') return `((${params}) => (${this.expr(e.body as AST.Expr)}))`;
        return `((${params}) => {\n${this.block(e.body, 1)}\n})`;
      }
      case 'UICall':
        return this.content(e.root);
      default:
        throw new Error(`Cannot generate code for node kind "${(e as { kind: string }).kind}"`);
    }
  }

  /** Resolve a call target: user fn -> name, builtin -> _bi.name, else dynamic. */
  private calleeRef(callee: AST.Expr): string {
    if (callee.kind === 'Ident') {
      if (this.fnNames.has(callee.name) || this.componentNames.has(callee.name)) return callee.name;
      if (BUILTINS.has(callee.name)) return `_bi[${JSON.stringify(callee.name)}]`;
      // Unknown at compile time (analyzer flags it) — dynamic fallback.
      return `_lookupFn(${JSON.stringify(callee.name)})`;
    }
    return this.expr(callee);
  }

  // ---------- statements ----------

  stmt(s: AST.Stmt, indent: number): string {
    const pad = '  '.repeat(indent);
    switch (s.kind) {
      case 'LetStmt':
      case 'StateStmt':
        return `${pad}let ${s.name} = ${this.expr(s.value)};`;
      case 'FnStmt': {
        const params = s.params.map((p) => `${p.name}${p.defaultExpr ? ` = ${this.expr(p.defaultExpr)}` : ''}`).join(', ');
        return `${pad}function ${s.name}(${params}) {\n${this.block(s.body, indent + 1)}\n${pad}}`;
      }
      case 'ReturnStmt':
        return `${pad}return ${s.argument ? this.expr(s.argument) : 'undefined'};`;
      case 'IfStmt': {
        let out = `${pad}if (_truthy(${this.expr(s.condition)})) {\n${this.block(s.then, indent + 1)}\n${pad}}`;
        let el = s.else;
        while (el) {
          if (el.kind === 'IfStmt') {
            out += ` else if (_truthy(${this.expr(el.condition)})) {\n${this.block(el.then, indent + 1)}\n${pad}}`;
            el = el.else;
          } else {
            out += ` else {\n${this.block(el, indent + 1)}\n${pad}}`;
            el = undefined;
          }
        }
        return out;
      }
      case 'ForStmt': {
        const h = s.header;
        if (h.form === 'each') {
          if (h.indexName) {
            return (
              `${pad}{ const _seq = _iterable(${this.expr(h.iterable)});\n` +
              `${pad}  for (let ${h.indexName} = 0; ${h.indexName} < _seq.length; ${h.indexName}++) {\n` +
              `${pad}    const ${h.varName} = _seq[${h.indexName}];\n` +
              `${this.block(s.body, indent + 2)}\n` +
              `${pad}  }\n${pad}}`
            );
          }
          return `${pad}for (const ${h.varName} of _iterable(${this.expr(h.iterable)})) {\n${this.block(s.body, indent + 1)}\n${pad}}`;
        }
        if (h.form === 'in') {
          return `${pad}for (const ${h.varName} of Object.keys(${this.expr(h.object)})) {\n${this.block(s.body, indent + 1)}\n${pad}}`;
        }
        const init = h.init ? this.stmt(h.init, 0).trim() : '';
        const test = h.test ? this.expr(h.test) : '';
        const update = h.update ? this.expr(h.update) : '';
        return `${pad}for (${init}; ${test}; ${update}) {\n${this.block(s.body, indent + 1)}\n${pad}}`;
      }
      case 'WhileStmt':
        return `${pad}while (_truthy(${this.expr(s.condition)})) {\n${this.block(s.body, indent + 1)}\n${pad}}`;
      case 'EventStmt': {
        const handler = this.expr(s.handler);
        if (s.targetIsSelector) {
          return `${pad}_onSelector(${this.expr(s.target as AST.Expr)}, ${JSON.stringify(s.event)}, ${handler});`;
        }
        const target = s.target as AST.ContentNode;
        // Bind the handler into the element's own spec so re-renders keep it.
        const spec =
          target.kind === 'Element' || target.kind === 'ComponentCall'
            ? this.boundElement(target, s.event, handler)
            : `_bind(${this.content(target)}, ${JSON.stringify(s.event)}, ${handler})`;
        const region = this.regionOverride ? JSON.stringify(this.regionOverride) : '"body"';
        return `${pad}_mount(${spec}, ${region});`;
      }
      case 'RenderStmt': {
        const region = this.regionOverride ? JSON.stringify(this.regionOverride) : '"body"';
        return `${pad}_mount(${this.content(s.content)}, ${region});`;
      }
      case 'ExprStmt':
        return `${pad}${this.expr(s.expr)};`;
      case 'Block':
        return `${pad}{\n${this.block(s, indent + 1)}\n${pad}}`;
      default:
        throw new Error(`Cannot generate statement kind "${(s as { kind: string }).kind}"`);
    }
  }

  block(b: AST.BlockStmt, indent: number): string {
    return b.statements.map((s) => this.stmt(s, indent)).join('\n');
  }

  // ---------- UI specs (lazy thunks) ----------

  elementSpec(node: AST.ElementNode | AST.ComponentCallNode): string {
    if (node.kind === 'Element') {
      const attrs = node.attributes.map((a) => {
        const val = typeof a.value === 'string' ? JSON.stringify(a.value) : `() => (${this.expr(a.value)})`;
        return `[${JSON.stringify(a.name)}, ${val}]`;
      });
      const tag = node.tag.toLowerCase();
      const isVoid = VOID_HTML.has(tag) || node.selfClosing;
      const children = isVoid ? '[]' : `[${node.children.map((c) => this.content(c)).join(', ')}]`;
      return `_el(${JSON.stringify(node.tag)}, [${attrs.join(', ')}], ${children})`;
    }
    const props = node.attributes.map((a) => {
      const val = typeof a.value === 'string' ? JSON.stringify(a.value) : `() => (${this.expr(a.value)})`;
      return `[${JSON.stringify(a.name)}, ${val}]`;
    });
    const children = `[${node.children.map((c) => this.content(c)).join(', ')}]`;
    return `_comp("${node.name}", [${props.join(', ')}], ${children})`;
  }

  /** Generate an Element/ComponentCall spec carrying an event handler. */
  boundElement(node: AST.ElementNode | AST.ComponentCallNode, event: string, handlerCode: string): string {
    if (node.kind === 'Element') {
      const attrs = node.attributes.map((a) => {
        const val = typeof a.value === 'string' ? JSON.stringify(a.value) : `() => (${this.expr(a.value)})`;
        return `[${JSON.stringify(a.name)}, ${val}]`;
      });
      const tag = node.tag.toLowerCase();
      const isVoid = VOID_HTML.has(tag) || node.selfClosing;
      const children = isVoid ? '[]' : `[${node.children.map((c) => this.content(c)).join(', ')}]`;
      return `_el(${JSON.stringify(node.tag)}, [${attrs.join(', ')}], ${children}, ${JSON.stringify(event)}, ${handlerCode})`;
    }
    const props = node.attributes.map((a) => {
      const val = typeof a.value === 'string' ? JSON.stringify(a.value) : `() => (${this.expr(a.value)})`;
      return `[${JSON.stringify(a.name)}, ${val}]`;
    });
    const children = `[${node.children.map((c) => this.content(c)).join(', ')}]`;
    return `_comp("${node.name}", [${props.join(', ')}], ${children}, ${JSON.stringify(event)}, ${handlerCode})`;
  }

  content(node: AST.ContentNode): string {
    switch (node.kind) {
      case 'Text':
        return `_txt(${JSON.stringify(node.value)})`;
      case 'Interpolation':
        return `_dyn(() => (${this.expr(node.expr)}))`;
      case 'ForDirective': {
        const body = `[${node.body.map((c) => this.content(c)).join(', ')}]`;
        return `_forList(() => (${this.expr(node.iterable)}), (${node.varName}) => ${body})`;
      }
      case 'IfDirective': {
        const then = `[${node.then.map((c) => this.content(c)).join(', ')}]`;
        const elseSpec = node.else ? `, () => [${node.else.map((c) => this.content(c)).join(', ')}]` : '';
        return `_cond(() => (${this.expr(node.condition)}), () => ${then}${elseSpec})`;
      }
      case 'OnWrapper': {
        const handler = this.expr(node.handler);
        if (node.child.kind === 'Element' || node.child.kind === 'ComponentCall') {
          return this.boundElement(node.child, node.event, handler);
        }
        return `_bind(${this.content(node.child)}, ${JSON.stringify(node.event)}, ${handler})`;
      }
      case 'Element':
      case 'ComponentCall':
        return this.elementSpec(node);
      default:
        throw new Error(`Cannot generate content node "${(node as { kind: string }).kind}"`);
    }
  }
}

function indentLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => (l.trim() ? prefix + l : l))
    .join('\n');
}

// ---------------- Program assembly ----------------

export function compile(program: AST.Program): CompiledOutput {
  const g = new Gen();
  for (const s of program.statements) if (s.kind === 'FnStmt') g.fnNames.add(s.name);
  for (const c of program.components) g.componentNames.add(c.name);

  const title = program.page?.meta.title ?? 'Luna Page';
  const description = program.page?.meta.description;
  const themeColor = program.page?.meta.themeColor;
  const css = program.styles.join('\n\n').trim();

  // Components become functions (_props, _children) => DOM node. Their body's
  // render statements append to a local region node returned by the function.
  const componentCode = program.components.map((c, ci) => {
    const inner = new Gen();
    inner.fnNames = g.fnNames;
    inner.componentNames = g.componentNames;
    // Each invocation registers its holder under a unique key so nested or
    // sibling instances never clobber each other's render region.
    const regionKey = `@c${ci}_${c.name}`;
    inner.regionOverride = regionKey;
    const propLets = c.props
      .map((p) => `let ${p.name} = ("${p.name}" in _props) ? _props["${p.name}"] : ${p.defaultExpr ? inner.expr(p.defaultExpr) : 'undefined'};`)
      .join('\n');
    const bodyCode = c.body.map((s) => inner.stmt(s, 1)).join('\n');
    return [
      `function ${c.name}(_props, _children) {`,
      `  const _savedRegion = _regions[${JSON.stringify(regionKey)}];`,
      `  const _compRegion = _makeHolder();`,
      `  _regions[${JSON.stringify(regionKey)}] = _compRegion;`,
      indentLines(propLets, '  '),
      `  const children = _children;`,
      bodyCode,
      `  _regions[${JSON.stringify(regionKey)}] = _savedRegion;`,
      `  return _compRegion;`,
      `}`,
    ].join('\n');
  });

  const mainBody = program.statements.map((s) => g.stmt(s, 1)).join('\n');

  const js = [
    '(function () {',
    '  "use strict";',
    RUNTIME_JS.trim(),
    '',
    '  // ---- components ----',
    ...componentCode,
    `  _components = { ${program.components.map((c) => `"${c.name}": ${c.name}`).join(', ')} };`,
    '',
    '  // ---- page program ----',
    '  try {',
    '  (function main() {',
    mainBody,
    '  })();',
    '  } catch (e) { _fatal(e); }',
    '})();',
  ].join('\n');

  const doc = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    description ? `<meta name="description" content="${escAttr(description)}">` : null,
    themeColor ? `<meta name="theme-color" content="${escAttr(themeColor)}">` : null,
    BASE_CSS,
    css ? `<style>\n${css}\n</style>` : null,
    '</head>',
    '<body>',
    '<div id="luna-root"></div>',
    `<script>\n${js}\n</script>`,
    '</body>',
    '</html>',
  ]
    .filter((x) => x !== null)
    .join('\n');

  return { html: doc, css, js };
}

// ---------------- Runtime ----------------

export const BASE_CSS = `<style>
/* Luna base styles: minimal, sensible defaults. */
:root { color-scheme: light dark; }
#luna-error {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999;
  background: #b91c1c; color: #fff; padding: 10px 14px;
  font: 13px/1.5 system-ui, sans-serif; white-space: pre-wrap;
}
</style>`;

export const RUNTIME_JS = String.raw`
// ===== Luna runtime =====
const _root = document.getElementById('luna-root');
const _regions = { body: _root };
let _components = {};
const _liveMounts = [];

// -- value helpers --
function _truthy(v) { return !!v; }
function _toStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}
function _toNum(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function _add(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return _toStr(a) + _toStr(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  return a + b;
}
function _eq(a, b) {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === 'object' && typeof b === 'object' && a && b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}
function _get(obj, key) { return obj === null || obj === undefined ? undefined : obj[key]; }
function _idx(obj, i) { return obj === null || obj === undefined ? undefined : obj[i]; }
function _iterable(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string') return Array.from(x);
  if (x && typeof x[Symbol.iterator] === 'function') return Array.from(x);
  if (x && typeof x === 'object') return Object.keys(x);
  return [];
}
function _lookupFn(name) {
  if (_components[name]) return (p, ch) => _components[name](p, ch);
  if (_bi[name]) return _bi[name];
  throw new Error('Unknown function "' + name + '"');
}

// -- builtins --
const _bi = {
  log: (...a) => console.log(...a.map(_fmt)),
  warn: (...a) => console.warn(...a.map(_fmt)),
  error: (...a) => console.error(...a.map(_fmt)),
  string: _toStr, number: _toNum, boolean: (v) => _truthy(v),
  len: (x) => _len(x), keys: (o) => Object.keys(o || {}), values: (o) => Object.values(o || {}),
  push: (arr, ...items) => { arr.push(...items); return arr; },
  pop: (arr) => arr.pop(),
  join: (arr, sep) => (arr || []).join(sep === undefined ? ',' : _toStr(sep)),
  split: (s, sep) => _toStr(s).split(sep),
  slice: (x, a, b) => x.slice(a, b),
  lower: (s) => _toStr(s).toLowerCase(),
  upper: (s) => _toStr(s).toUpperCase(),
  trim: (s) => _toStr(s).trim(),
  round: (n) => Math.round(n), floor: (n) => Math.floor(n), ceil: (n) => Math.ceil(n),
  abs: (n) => Math.abs(n), min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
  random: () => Math.random(),
  parseInt: (s, r) => parseInt(s, r === undefined ? 10 : r),
  parseFloat: (s) => parseFloat(s),
  store: (k, v) => { try { localStorage.setItem('luna:' + k, JSON.stringify(v)); } catch (e) { console.warn('store failed: ' + e.message); } },
  retrieve: (k, fb) => { try { const s = localStorage.getItem('luna:' + k); return s === null ? (fb === undefined ? null : fb) : JSON.parse(s); } catch { return fb === undefined ? null : fb; } },
  unstore: (k) => { try { localStorage.removeItem('luna:' + k); } catch {} },
  delay: (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { _fatal(e); } _scheduleUpdate(); }, ms),
  fetchJSON: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error('fetch failed: HTTP ' + r.status); return await r.json(); },
  json: (v) => JSON.stringify(v),
  escapeHtml: (s) => _toStr(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  range: (a, b, step) => {
    const out = [];
    if (b === undefined) { b = a; a = 0; }
    step = step === undefined ? 1 : step;
    if (step > 0) for (let i = a; i < b; i += step) out.push(i);
    else if (step < 0) for (let i = a; i > b; i += step) out.push(i);
    return out;
  },
  key: (ev) => _toStr(ev && ev.key),
  targetValue: (ev) => (ev && ev.target ? _toStr(ev.target.value) : ''),
  math: Math,
};
function _fmt(v) { return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v); }
function _len(x) {
  if (Array.isArray(x) || typeof x === 'string') return x.length;
  if (x && typeof x === 'object') return Object.keys(x).length;
  return 0;
}

// -- UI specs (lazy) --
function _txt(s) { return { k: 'text', value: s }; }
function _dyn(thunk) { return { k: 'dyn', thunk }; }
function _el(tag, attrs, children, onEvent, onHandler) { return { k: 'el', tag, attrs, children, onEvent, onHandler }; }
function _comp(name, props, children, onEvent, onHandler) { return { k: 'comp', name, props, children, onEvent, onHandler }; }
function _forList(iterable, renderItem) { return { k: 'for', iterable, renderItem }; }
function _cond(test, thenFn, elseFn) { return { k: 'cond', test, thenFn, elseFn }; }

const SVG_TAGS = new Set(['svg','circle','rect','line','path','polygon','polyline','ellipse','g','text','tspan','defs','use','clipPath','linearGradient','radialGradient','stop','marker','pattern','image','foreignObject','title']);

function _build(spec) {
  if (!spec) return document.createTextNode('');
  if (spec.k === 'bind') {
    const node = _build(spec.inner);
    _attachHandler(node, spec.event, spec.handler);
    return node;
  }
  if (spec.k === 'text') return document.createTextNode(_toStr(spec.value));
  if (spec.k === 'dyn') {
    const v = spec.thunk();
    return _valueToNode(v);
  }
  if (spec.k === 'for') {
    const frag = document.createDocumentFragment();
    const items = _iterable(typeof spec.iterable === 'function' ? spec.iterable() : spec.iterable);
    for (let i = 0; i < items.length; i++) {
      const rendered = spec.renderItem(items[i], i);
      const list = Array.isArray(rendered) ? rendered : [rendered];
      for (const r of list) frag.appendChild(_build(r));
    }
    return frag;
  }
  if (spec.k === 'cond') {
    const branch = _truthy(spec.test()) ? spec.thenFn : spec.elseFn;
    if (!branch) return document.createDocumentFragment();
    const nodes = branch();
    const list = Array.isArray(nodes) ? nodes : [nodes];
    const frag = document.createDocumentFragment();
    for (const n of list) frag.appendChild(_build(n));
    return frag;
  }
  if (spec.k === 'comp') {
    const fn = _components[spec.name];
    if (!fn) throw new Error('Unknown component "' + spec.name + '"');
    const propsObj = {};
    for (const pair of spec.props) {
      const v = typeof pair[1] === 'function' ? pair[1]() : pair[1];
      propsObj[pair[0]] = v;
    }
    const kids = (spec.children || []).map((c) => _build(c));
    const holder = document.createElement('div');
    holder.style.display = 'contents';
    const out = fn(propsObj, kids);
    if (out && out.nodeType) holder.appendChild(out);
    else if (out) holder.appendChild(_valueToNode(out));
    if (spec.onEvent) _attachHandler(holder, spec.onEvent, spec.onHandler);
    return holder;
  }
  if (spec.k === 'el') {
    const lower = spec.tag.toLowerCase();
    const isSvg = SVG_TAGS.has(lower);
    const el = isSvg
      ? document.createElementNS('http://www.w3.org/2000/svg', spec.tag)
      : document.createElement(spec.tag);
    for (const [name, val] of spec.attrs) {
      const v = typeof val === 'function' ? val() : val;
      if (v === null || v === undefined || v === false) continue;
      if (v === true) { el.setAttribute(name, ''); }
      else el.setAttribute(name, _toStr(v));
      if (name === 'value' && !isSvg && (lower === 'input' || lower === 'textarea' || lower === 'select')) el.value = _toStr(v);
      if (name === 'checked' && !isSvg && lower === 'input') el.checked = _truthy(v);
    }
    for (const c of spec.children) el.appendChild(_build(c));
    if (spec.onEvent) el.addEventListener(spec.onEvent, (ev) => {
      try { spec.onHandler(ev); } catch (e) { _fatal(e); }
      _scheduleUpdate();
    });
    return el;
  }
  return document.createTextNode('');
}

function _valueToNode(v) {
  if (v && typeof v === 'object' && v.k) return _build(v);
  if (Array.isArray(v)) {
    const frag = document.createDocumentFragment();
    for (const item of v) frag.appendChild(_valueToNode(item));
    return frag;
  }
  if (v instanceof Node) return v;
  return document.createTextNode(_toStr(v));
}

function _makeHolder() {
  const d = document.createElement('div');
  d.style.display = 'contents';
  return d;
}

// -- mounting & reactive updates --
// Region names: "body" (the document body) or "@var" (a component-local holder).
function _resolveRegion(name) {
  if (name.charAt(0) === '@') {
    // Component-local regions are registered by the component function under
    // "@<id>" before its body runs; no eval needed.
    return _regions[name] || _root;
  }
  return _regions[name] || _root;
}
function _mount(spec, regionName) {
  const region = _resolveRegion(regionName);
  const mount = { spec, region, node: null };
  _renderMount(mount);
  _liveMounts.push(mount);
}
function _renderMount(mount) {
  const node = _makeHolder();
  node.appendChild(_build(mount.spec));
  if (mount.node && mount.node.parentNode) mount.node.parentNode.replaceChild(node, mount.node);
  else mount.region.appendChild(node);
  mount.node = node;
}
function _rerenderAll() {
  for (const m of _liveMounts) {
    try { _renderMount(m); } catch (e) { _fatal(e); }
  }
}
const _sched = { queued: false };
function _scheduleUpdate() {
  if (_sched.queued) return;
  _sched.queued = true;
  requestAnimationFrame(() => { _sched.queued = false; _rerenderAll(); });
}

// Attach an event to a spec by wrapping it.
function _bind(spec, event, handler) { return { k: 'bind', inner: spec, event, handler }; }
function _attachHandler(node, event, handler) {
  let target = null;
  if (node.nodeType === 1) target = node;
  else if (node.querySelector) target = node.querySelector('*');
  if (!target) { console.warn('event target not found for on ' + event); return; }
  target.addEventListener(event, (ev) => {
    try { handler(ev); } catch (e) { _fatal(e); }
    _scheduleUpdate();
  });
}

function _onSelector(selector, event, handler) {
  const apply = () => {
    document.querySelectorAll(selector).forEach((el) => {
      if (el.__lunaBound) return;
      el.__lunaBound = true;
      el.addEventListener(event, (ev) => {
        try { handler(ev); } catch (e) { _fatal(e); }
        _scheduleUpdate();
      });
    });
  };
  apply();
  // Re-apply after reactive re-renders replace nodes.
  const orig = _rerenderAll;
  _rerenderAll = function () { orig(); apply(); };
}

function _fatal(e) {
  console.error(e);
  _showError(e && e.message ? e.message : String(e));
}
function _showError(msg) {
  let box = document.getElementById('luna-error');
  if (!box) { box = document.createElement('div'); box.id = 'luna-error'; box.setAttribute('role', 'alert'); document.body.appendChild(box); }
  box.textContent = 'Runtime error: ' + msg;
}
window.addEventListener('error', (ev) => _showError(ev.message));
`.replace(/^/gm, '  ');
