// Semantic analysis for the Luna language.
// Checks declarations, scope, and usage before code generation.

import * as AST from './ast';
import { Diagnostic, error } from './diagnostics';

const BUILTINS = new Set([
  'log',
  'warn',
  'error',
  'string',
  'number',
  'boolean',
  'len',
  'keys',
  'values',
  'push',
  'pop',
  'join',
  'split',
  'slice',
  'lower',
  'upper',
  'trim',
  'round',
  'floor',
  'ceil',
  'abs',
  'min',
  'max',
  'random',
  'parseInt',
  'parseFloat',
  'store',
  'retrieve',
  'unstore',
  'delay',
  'fetchJSON',
  'math',
  'json',
  'window',
  'document',
]);

interface Scope {
  parent: Scope | null;
  vars: Set<string>;
}

export function analyze(program: AST.Program): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seenTop = new Map<string, AST.Node>();
  const components = new Map<string, AST.ComponentDef>();

  // ---- collect top-level declarations ----
  for (const stmt of program.statements) {
    if (stmt.kind === 'LetStmt' || stmt.kind === 'StateStmt' || stmt.kind === 'FnStmt') {
      const name = stmt.name;
      if (seenTop.has(name)) {
        const prev = seenTop.get(name)!;
        diagnostics.push(
          error(`"${name}" is declared twice at the top level`, stmt.pos.line, stmt.pos.column, `first declared on line ${prev.pos.line}`),
        );
      }
      seenTop.set(name, stmt);
    }
    if (RESERVED_TOP.includes(getKeyword(stmt))) {
      // handled by parser normally
    }
  }
  for (const c of program.components) {
    if (components.has(c.name)) {
      diagnostics.push(error(`Component "${c.name}" is defined twice`, c.pos.line, c.pos.column));
    }
    components.set(c.name, c);
    if (seenTop.has(c.name)) {
      diagnostics.push(error(`Name "${c.name}" is used for both a variable/function and a component`, c.pos.line, c.pos.column));
    }
    seenTop.set(c.name, c);
  }

  // NOTE: globalScope.vars starts EMPTY. Top-level declarations are registered
  // by declare() while walking below (walkStatements(program.statements, globalScope)).
  // Seeding it from seenTop here caused every top-level `state`/`let`/`fn` to be
  // falsely reported as "already declared in this scope" when the walker declared it.
  // Duplicate top-level names are still caught by the seenTop pre-pass above.
  const globalScope: Scope = { parent: null, vars: new Set<string>() };

  // ---- walk statements ----
  const checkReturnDepth = { depth: 0 };

  function walkStatements(list: AST.Stmt[], scope: Scope) {
    for (const s of list) walkStmt(s, scope);
  }

  function declare(name: string, pos: AST.Node, scope: Scope) {
    if (scope.vars.has(name)) {
      diagnostics.push(error(`"${name}" is already declared in this scope`, pos.pos.line, pos.pos.column));
    }
    scope.vars.add(name);
  }

  function lookup(name: string, scope: Scope): boolean {
    for (let s: Scope | null = scope; s; s = s.parent) if (s.vars.has(name)) return true;
    return false;
  }

  function walkStmt(stmt: AST.Stmt, scope: Scope) {
    switch (stmt.kind) {
      case 'LetStmt':
      case 'StateStmt': {
        checkExpr(stmt.value, scope);
        declare(stmt.name, stmt, scope);
        break;
      }
      case 'FnStmt': {
        const inner: Scope = { parent: globalScope, vars: new Set(stmt.params.map((p) => p.name)) };
        for (const p of stmt.params) if (p.defaultExpr) checkExpr(p.defaultExpr, inner);
        checkReturnDepth.depth++;
        walkStatements(stmt.body.statements, inner);
        checkReturnDepth.depth--;
        break;
      }
      case 'ReturnStmt': {
        if (checkReturnDepth.depth === 0) {
          diagnostics.push(error('"return" is only allowed inside a function', stmt.pos.line, stmt.pos.column));
        }
        if (stmt.argument) checkExpr(stmt.argument, scope);
        break;
      }
      case 'IfStmt': {
        checkExpr(stmt.condition, scope);
        walkStatements(stmt.then.statements, { parent: scope, vars: new Set() });
        if (stmt.else) {
          if (stmt.else.kind === 'IfStmt') walkStmt(stmt.else, scope);
          else walkStatements(stmt.else.statements, { parent: scope, vars: new Set() });
        }
        break;
      }
      case 'ForStmt': {
        const inner: Scope = { parent: scope, vars: new Set() };
        const h = stmt.header;
        if (h.form === 'each') {
          checkExpr(h.iterable, scope);
          declare(h.varName, stmt, inner);
          if (h.indexName) declare(h.indexName, stmt, inner);
        } else if (h.form === 'in') {
          checkExpr(h.object, scope);
          declare(h.varName, stmt, inner);
        } else {
          if (h.init) walkStmt(h.init, inner);
          if (h.test) checkExpr(h.test, inner);
          if (h.update) checkExpr(h.update, inner);
        }
        walkStatements(stmt.body.statements, inner);
        break;
      }
      case 'WhileStmt': {
        checkExpr(stmt.condition, scope);
        walkStatements(stmt.body.statements, { parent: scope, vars: new Set() });
        break;
      }
      case 'EventStmt': {
        const handler = stmt.handler as unknown as AST.FnExpr;
        if (handler.kind === 'FnExpr') {
          const inner: Scope = { parent: globalScope, vars: new Set(handler.params.map((p) => p.name)) };
          checkReturnDepth.depth++;
          if (handler.body.kind === 'Block') walkStatements(handler.body.statements, inner);
          else checkExpr(handler.body, inner);
          checkReturnDepth.depth--;
        }
        if (!stmt.targetIsSelector) checkContent(stmt.target as AST.ContentNode, globalScope);
        break;
      }
      case 'RenderStmt': {
        checkContent(stmt.content, scope);
        break;
      }
      case 'ExprStmt': {
        checkExpr(stmt.expr, scope);
        break;
      }
      case 'Block': {
        walkStatements(stmt.statements, { parent: scope, vars: new Set() });
        break;
      }
      default:
        break;
    }
  }

  function checkContent(node: AST.ContentNode, scope: Scope) {
    switch (node.kind) {
      case 'Element': {
        for (const a of node.attributes) if (typeof a.value !== 'string') checkExpr(a.value, scope);
        for (const c of node.children) checkContent(c, scope);
        break;
      }
      case 'ComponentCall': {
        const def = components.get(node.name);
        if (!def) {
          diagnostics.push(error(`Unknown component "${node.name}"`, node.pos.line, node.pos.column, 'define it with: component ' + node.name + '(props) { ... }'));
        } else {
          const given = new Set(node.attributes.map((a) => a.name));
          for (const a of node.attributes) {
            if (!def.props.some((p) => p.name === a.name) && a.name !== 'children') {
              diagnostics.push(error(`Component "${node.name}" has no prop "${a.name}"`, a.pos.line, a.pos.column, `props: ${def.props.map((p) => p.name).join(', ') || '(none)'}`));
            }
            if (typeof a.value !== 'string') checkExpr(a.value, scope);
          }
          for (const p of def.props) {
            if (!given.has(p.name) && !p.defaultExpr) {
              diagnostics.push(error(`Missing required prop "${p.name}" for component "${node.name}"`, node.pos.line, node.pos.column));
            }
          }
        }
        for (const c of node.children) checkContent(c, scope);
        break;
      }
      case 'Interpolation': {
        checkExpr(node.expr, scope);
        break;
      }
      case 'Text':
        break;
    }
  }

  function checkExpr(expr: AST.Expr, scope: Scope) {
    switch (expr.kind) {
      case 'Ident': {
        if (!lookup(expr.name, scope) && !BUILTINS.has(expr.name)) {
          const suggestion = nearestName(expr.name, scope);
          diagnostics.push(
            error(`Unknown name "${expr.name}"`, expr.pos.line, expr.pos.column, suggestion ? `did you mean "${suggestion}"?` : undefined),
          );
        }
        break;
      }
      case 'TemplateLit':
        for (const p of expr.parts) checkExpr(p, scope);
        break;
      case 'ArrayLit':
        for (const e of expr.elements) checkExpr(e, scope);
        break;
      case 'ObjectLit':
        for (const prop of expr.properties) {
          if (prop.keyExpr) checkExpr(prop.keyExpr, scope);
          checkExpr(prop.value, scope);
        }
        break;
      case 'UnaryExpr':
        checkExpr(expr.operand, scope);
        break;
      case 'BinaryExpr':
        checkExpr(expr.left, scope);
        checkExpr(expr.right, scope);
        break;
      case 'CallExpr': {
        checkExpr(expr.callee, scope);
        for (const a of expr.args) checkExpr(a, scope);
        break;
      }
      case 'MemberExpr':
        checkExpr(expr.object, scope);
        break;
      case 'IndexExpr':
        checkExpr(expr.object, scope);
        checkExpr(expr.index, scope);
        break;
      case 'AssignExpr': {
        checkExpr(expr.target, scope);
        checkExpr(expr.value, scope);
        break;
      }
      case 'FnExpr': {
        const inner: Scope = { parent: scope, vars: new Set(expr.params.map((p) => p.name)) };
        checkReturnDepth.depth++;
        if (expr.body.kind === 'Block') walkStatements(expr.body.statements, inner);
        else checkExpr(expr.body, inner);
        checkReturnDepth.depth--;
        break;
      }
      case 'UICall': {
        checkContent(expr.root, scope);
        break;
      }
      default:
        break;
    }
  }

  function nearestName(name: string, scope: Scope): string | null {
    // Search the ENTIRE enclosing scope chain, not just the innermost scope.
    // Previously only `scope.vars` was considered, so a typo like `countr` used
    // inside `render { ... }` (checked against globalScope) never saw the real
    // declaration and produced no "did you mean" suggestion.
    const all: string[] = [...BUILTINS];
    for (let s: Scope | null = scope; s; s = s.parent) for (const v of s.vars) all.push(v);
    let best: string | null = null;
    let bestDist = 3;
    for (const cand of all) {
      const d = editDistance(name.toLowerCase(), cand.toLowerCase());
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
    return best;
  }

  function editDistance(a: string, b: string): number {
    const m: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return m[a.length][b.length];
  }

  // Top-level statements see the global scope directly.
  walkStatements(program.statements, globalScope);

  // Component bodies get their own scope with props.
  for (const c of program.components) {
    const inner: Scope = { parent: globalScope, vars: new Set([...c.props.map((p) => p.name), 'children']) };
    for (const p of c.props) if (p.defaultExpr) checkExpr(p.defaultExpr, inner);
    checkReturnDepth.depth++;
    walkStatements(c.body, inner);
    checkReturnDepth.depth--;
  }

  return diagnostics;
}

const RESERVED_TOP = [''];
function getKeyword(s: AST.Stmt): string {
  return s.kind;
}
