// Recursive-descent parser for the Luna language.
// Grammar overview (see docs/LANGUAGE.md):
//   program     := top*
//   top         := pageDecl | styleBlock | componentDef | statement
//   statement   := letDecl | stateDecl | fnDecl | returnStmt | ifStmt
//                | forStmt | whileStmt | eventStmt | block | exprOrRender
//   exprOrRender:= UI element -> RenderStmt, otherwise ExprStmt
//   UI          := '<' tag attrs '>' children '</tag>' | '<' tag attrs '/>'
//   children    := (text | UI | '{' expr '}' | backtick template)*

import { Token, TagInfo, SourcePosition } from './tokens';
import { tokenize } from './lexer';
import { Diagnostic, error, warning } from './diagnostics';
import * as AST from './ast';

const RESERVED = new Set([
  'if', 'else', 'while', 'for', 'return', 'fn', 'let', 'const', 'state',
  'component', 'page', 'style', 'on', 'and', 'or', 'not', 'true', 'false',
  'null', 'undefined', 'with', 'each', 'in', 'of',
]);

export const VOID_HTML = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

const VALID_EVENTS = ['click', 'input', 'change', 'submit', 'keydown', 'keyup', 'load'];

class ParseAbort extends Error {}

export function parse(tokens: Token[], source: string): { program: AST.Program | null; diagnostics: Diagnostic[] } {
  const p = new Parser(tokens, source);
  try {
    const program = p.parseProgram();
    // Surface diagnostics collected while parsing attribute interpolations.
    return { program, diagnostics: [...p.diagnostics, ...p.subDiagnostics] };
  } catch (e) {
    if (e instanceof ParseAbort) {
      return { program: null, diagnostics: [...p.diagnostics, ...p.subDiagnostics] };
    }
    throw e;
  }
}

class Parser {
  ts: Token[];
  source: string;
  i = 0;
  /** Mirrors the lexer's element-open depth so sub-parsers stay in sync. */
  markupDepth = 0;
  diagnostics: Diagnostic[] = [];
  /** Diagnostics from sub-parses of attribute interpolations. */
  subDiagnostics: Diagnostic[] = [];

  constructor(tokens: Token[], source: string) {
    this.ts = tokens.filter((t) => t.type !== 'NEWLINE');
    this.source = source;
  }

  // ---------- helpers ----------

  private peek(offset = 0): Token {
    return this.ts[Math.min(this.i + offset, this.ts.length - 1)];
  }

  private at(type: string): boolean {
    return this.peek().type === type;
  }

  private atKeyword(kw: string): boolean {
    const t = this.peek();
    return t.type === 'KEYWORD' && t.keyword === kw;
  }

  private next(): Token {
    if (this.i < this.ts.length - 1 || this.peek().type !== 'EOF') this.i++;
    return this.ts[this.i - 1];
  }

  private err(message: string, tok: Token | SourcePosition = this.peek(), hint?: string): never {
    const p = "type" in tok ? tok.pos : tok;
    this.diagnostics.push(error(message, p.line, p.column, hint));
    throw new ParseAbort();
  }

  private warn(message: string, tok: Token, hint?: string) {
    this.diagnostics.push(warning(message, tok.pos.line, tok.pos.column, hint));
  }

  private expect(type: string, what: string): Token {
    if (!this.at(type)) this.err(`Expected ${what}, found "${this.display(this.peek())}"`);
    return this.next();
  }

  private display(t: Token): string {
    if (t.type === 'EOF') return 'end of file';
    if (t.type === 'TAG') return t.value;
    return JSON.stringify(t.value);
  }

  private eatSemi() {
    if (this.at('SEMI')) this.next();
  }

  private identName(what = 'an identifier'): string {
    const t = this.peek();
    if (t.type !== 'IDENT') this.err(`Expected ${what}, found "${this.display(t)}"`, t);
    this.next();
    return t.value;
  }

  // ---------- program ----------

  parseProgram(): AST.Program {
    let page: AST.PageStmt | null = null;
    const styles: string[] = [];
    const components: AST.ComponentDef[] = [];
    const statements: AST.Stmt[] = [];

    while (!this.at('EOF')) {
      if (this.atKeyword('page')) {
        const stmt = this.parsePage();
        if (page) this.err('Duplicate "page" declaration — a project has one page', page.pos);
        page = stmt;
      } else if (this.at('CSSBLOCK')) {
        styles.push(this.next().value);
      } else if (this.atKeyword('component')) {
        components.push(this.parseComponent());
      } else {
        statements.push(this.parseStatement());
      }
      this.eatSemi();
    }

    return {
      kind: 'Program',
      pos: { line: 1, column: 1, offset: 0 },
      page,
      styles,
      components,
      statements,
    };
  }

  private parsePageOptions(meta: AST.PageMeta) {
    this.expect('LBRACE', '"{"');
    while (!this.at('RBRACE')) {
      if (this.at('EOF')) this.err('Unterminated page options block');
      const keyTok = this.peek();
      const key = this.identName('a page option name like title or description');
      this.expect('COLON', `":" after "${key}"`);
      const valTok = this.expect('STRING', 'a string value');
      if (key === 'title') meta.title = valTok.value;
      else if (key === 'description') meta.description = valTok.value;
      else if (key === 'themeColor' || key === 'theme-color') meta.themeColor = valTok.value;
      else this.err(`Unknown page option "${key}"`, keyTok, 'options: title, description, themeColor');
      if (this.at('COMMA')) this.next();
      else if (!this.at('RBRACE')) this.err('Expected "," or "}" in page options', this.peek());
    }
    this.next(); // }
  }

  private parsePage(): AST.PageStmt {
    const kw = this.next(); // page
    const meta: AST.PageMeta = {};
    if (this.at('STRING')) {
      meta.title = this.next().value;
      if (this.at('LBRACE')) this.parsePageOptions(meta);
    } else if (this.at('LBRACE')) {
      this.parsePageOptions(meta);
    } else {
      this.err('Expected a page title string or a { title: ... } block after "page"', kw, 'example: page "My Site"');
    }
    return { kind: 'PageStmt', pos: kw.pos, meta };
  }

  private parseComponent(): AST.ComponentDef {
    const kw = this.next(); // component
    const nameTok = this.peek();
    const name = this.identName('a component name');
    if (!/^[A-Z]/.test(name)) {
      this.err(`Component names must start with an uppercase letter ("${name}")`, nameTok);
    }
    const props = this.parseParams();
    this.expect('LBRACE', '"{" to open the component body');
    const body: AST.Stmt[] = [];
    while (!this.at('RBRACE')) {
      if (this.at('EOF')) this.err('Unterminated component body', kw, 'add a closing "}"');
      if (this.atKeyword('component')) this.err('Components cannot be declared inside a component', this.peek());
      if (this.atKeyword('state')) {
        this.err('Components cannot declare state yet (known limitation)', this.peek(), 'keep state at the top level for now');
      }
      body.push(this.parseStatement());
      this.eatSemi();
    }
    this.next(); // }
    return { kind: 'ComponentDef', pos: kw.pos, name, props, body };
  }

  private parseParams(): AST.FnParam[] {
    this.expect('LPAREN', '"(" followed by parameter names');
    const params: AST.FnParam[] = [];
    while (!this.at('RPAREN')) {
      const nameTok = this.peek();
      const name = this.identName('a parameter name');
      if (RESERVED.has(name)) this.err(`"${name}" is a reserved word`, nameTok);
      let defaultExpr: AST.Expr | undefined;
      if (this.at('ASSIGN')) {
        this.next();
        defaultExpr = this.parseExpr();
      }
      params.push({ name, defaultExpr });
      if (this.at('COMMA')) this.next();
      else if (!this.at('RPAREN')) this.err('Expected "," or ")" in parameter list', this.peek());
    }
    this.next(); // )
    return params;
  }

  // ---------- statements ----------

  parseStatement(): AST.Stmt {
    if (this.atKeyword('let') || this.atKeyword('const')) return this.parseLet();
    if (this.atKeyword('state')) return this.parseState();
    if (this.atKeyword('fn')) return this.parseFn();
    if (this.atKeyword('return')) return this.parseReturn();
    if (this.atKeyword('if')) return this.parseIf();
    if (this.atKeyword('for')) return this.parseFor();
    if (this.atKeyword('while')) return this.parseWhile();
    if (this.atKeyword('on')) return this.parseOn();
    if (this.atKeyword('render')) return this.parseRender();
    if (this.at('LBRACE')) return this.parseBlock();
    return this.parseExprOrRender();
  }

  /** `render { <ui> }` — a top-level (or component-body) UI block. */
  private parseRender(): AST.Stmt {
    const kw = this.next(); // render
    const open = this.expect('LBRACE', '"{" after "render"');
    const nodes = this.parseContentUntilRBrace(open);
    return { kind: 'RenderStmt', pos: kw.pos, content: { kind: 'Fragment', pos: open.pos, children: nodes } as any };
  }

  /** Parse markup content until the current frame's closing `}` (consumed). */
  private parseContentUntilRBrace(open: Token): AST.ContentNode[] {
    const nodes: AST.ContentNode[] = [];
    let textBuf = '';
    let textStart = open.end;
    const flushText = () => {
      const collapsed = collapseWhitespace(textBuf);
      if (collapsed) nodes.push({ kind: 'Text', pos: textStart, value: collapsed });
      textBuf = '';
    };
    while (true) {
      const t = this.peek();
      if (t.type === 'EOF') this.err('Unterminated render block', open, 'add a closing "}"');
      if (t.type === 'RBRACE') {
        this.next();
        flushText();
        return nodes;
      }
      if (t.type === 'TEXT') {
        if (!textBuf) textStart = t.pos;
        textBuf += this.next().value;
        continue;
      }
      flushText();
      nodes.push(...this.parseContentSequence(t));
    }
  }

  private parseBlock(): AST.BlockStmt {
    const open = this.expect('LBRACE', '"{"');
    const statements: AST.Stmt[] = [];
    while (!this.at('RBRACE')) {
      if (this.at('EOF')) this.err('Unterminated block', open, 'add a closing "}"');
      statements.push(this.parseStatement());
      this.eatSemi();
    }
    this.next(); // }
    return { kind: 'Block', pos: open.pos, statements };
  }

  private parseLet(): AST.LetStmt {
    const kw = this.next(); // let / const
    const nameTok = this.peek();
    const name = this.identName('a variable name');
    if (RESERVED.has(name)) this.err(`"${name}" is a reserved word`, nameTok);
    this.expect('ASSIGN', `"=" after "${name}"`);
    const value = this.parseExpr();
    return { kind: 'LetStmt', pos: kw.pos, name, value };
  }

  private parseState(): AST.StateStmt {
    const kw = this.next(); // state
    const nameTok = this.peek();
    const name = this.identName('a state variable name');
    if (RESERVED.has(name)) this.err(`"${name}" is a reserved word`, nameTok);
    this.expect('ASSIGN', `"=" after "${name}"`);
    const value = this.parseExpr();
    return { kind: 'StateStmt', pos: kw.pos, name, value };
  }

  private parseFn(): AST.FnStmt {
    const kw = this.next(); // fn
    const nameTok = this.peek();
    const name = this.identName('a function name');
    if (RESERVED.has(name)) this.err(`"${name}" is a reserved word`, nameTok);
    const params = this.parseParams();
    const body = this.parseBlock();
    return { kind: 'FnStmt', pos: kw.pos, name, params, body };
  }

  private parseReturn(): AST.ReturnStmt {
    const kw = this.next(); // return
    let argument: AST.Expr | undefined;
    const startsStatement =
      this.at('RBRACE') || this.at('SEMI') || this.at('EOF') ||
      ['let', 'const', 'state', 'fn', 'if', 'for', 'while', 'on', 'return'].includes(this.peek().keyword ?? '');
    if (!startsStatement) argument = this.parseExpr();
    return { kind: 'ReturnStmt', pos: kw.pos, argument };
  }

  private parseIf(): AST.IfStmt {
    const kw = this.next(); // if
    this.expect('LPAREN', '"(" after "if"');
    const condition = this.parseExpr();
    this.expect('RPAREN', '")" after the if condition');
    const then = this.parseBlock();
    let elseBranch: AST.IfStmt | AST.BlockStmt | undefined;
    if (this.atKeyword('else')) {
      this.next();
      elseBranch = this.atKeyword('if') ? this.parseIf() : this.parseBlock();
    }
    return { kind: 'IfStmt', pos: kw.pos, condition, then, else: elseBranch };
  }

  private parseFor(): AST.ForStmt {
    const kw = this.next(); // for
    if (this.atKeyword('each')) {
      this.next();
      const varName = this.identName('a loop variable name');
      let indexName: string | undefined;
      if (this.atKeyword('with')) {
        this.next();
        indexName = this.identName('an index variable name');
      }
      if (!this.atKeyword('of') && !this.atKeyword('in')) {
        this.err('Expected "of" after the loop variable', this.peek(), 'example: for each item of items { }');
      }
      this.next();
      const iterable = this.parseExpr();
      const body = this.parseBlock();
      return { kind: 'ForStmt', pos: kw.pos, header: { form: 'each', varName, indexName, iterable }, body };
    }
    if (this.atKeyword('in')) {
      this.next();
      const varName = this.identName('a loop variable name');
      if (!this.atKeyword('of')) this.err('Expected "of" after "for in <name>"', this.peek(), 'example: for in key of obj { }');
      this.next();
      const object = this.parseExpr();
      const body = this.parseBlock();
      return { kind: 'ForStmt', pos: kw.pos, header: { form: 'in', varName, object }, body };
    }
    // C-style: for (init; test; update) { }
    this.expect('LPAREN', '"(", "each", or "in" after "for"');
    let init: AST.Stmt | undefined;
    if (!this.at('SEMI')) init = this.parseStatement();
    this.expect('SEMI', '";" after the for-loop initializer');
    let test: AST.Expr | undefined;
    if (!this.at('SEMI')) test = this.parseExpr();
    this.expect('SEMI', '";" after the for-loop condition');
    let update: AST.Expr | undefined;
    if (!this.at('RPAREN')) update = this.parseExpr();
    this.expect('RPAREN', '")" closing the for-loop header');
    const body = this.parseBlock();
    return { kind: 'ForStmt', pos: kw.pos, header: { form: 'cstyle', init, test, update }, body };
  }

  private parseWhile(): AST.WhileStmt {
    const kw = this.next(); // while
    this.expect('LPAREN', '"(" after "while"');
    const condition = this.parseExpr();
    this.expect('RPAREN', '")" after the while condition');
    const body = this.parseBlock();
    return { kind: 'WhileStmt', pos: kw.pos, condition, body };
  }

  private parseOn(): AST.EventStmt {
    // `<on event { handler } <element>>` written at statement level parses
    // exactly like the inline markup form and yields an EventStmt.
    if (this.at('TAG') && this.peek().tag?.name === 'on') {
      const on = this.parseOnWrapper();
      return { kind: 'EventStmt', pos: on.pos, event: on.event, handler: on.handler, target: on.child, targetIsSelector: false };
    }
    const kw = this.next(); // on
    const evTok = this.peek();
    const evName = this.identName('an event name such as click, input, submit, or keydown');
    const event = evName.toLowerCase();
    if (!VALID_EVENTS.includes(event)) {
      this.err(`Unsupported event "${evName}"`, evTok, `supported events: ${VALID_EVENTS.join(', ')}`);
    }

    if (this.at('ARROW')) {
      // Deprecated sugar: on click => fn(args) { } <button>...</button>
      const arrow = this.next();
      this.warn('The "=>" event syntax is deprecated', arrow, 'write: on click { ... } <button>...</button>');
      const handler = this.parseDeprecatedHandler();
      const uiTarget = this.parseElement();
      return { kind: 'EventStmt', pos: kw.pos, event, handler, target: uiTarget, targetIsSelector: false };
    }

    const handler = this.parseClosure();
    let uiTarget: AST.ContentNode | null = null;
    let selectorTarget: AST.StringLit | null = null;
    if (this.at('TAG') && this.peek().tag?.name === 'on' && !this.peek().tag!.closing) {
      // `on click { ... } <on click { ... } <button>>` — rare but legal.
      uiTarget = this.parseOnWrapper();
    } else if (this.at('TAG')) {
      uiTarget = this.parseElement();
    } else if (this.at('STRING')) {
      selectorTarget = { kind: 'StringLit', pos: this.peek().pos, value: this.next().value };
    } else {
      this.err(
        'Expected an element or a CSS selector string after the event handler',
        this.peek(),
        'example: on click { count = count + 1 } <button>+1</button>',
      );
    }
    const target = uiTarget ?? selectorTarget!;
    return { kind: 'EventStmt', pos: kw.pos, event, handler, target, targetIsSelector: uiTarget === null };
  }

  /** In the deprecated form, the handler is `fn(...) {...}` or a closure. */
  private parseDeprecatedHandler(): AST.Expr {
    if (this.atKeyword('fn')) {
      const fnKw = this.next();
      const params = this.parseParams();
      const body = this.parseBlock();
      return { kind: 'FnExpr', pos: fnKw.pos, params, body } as unknown as AST.Expr;
    }
    return this.parseClosure();
  }

  /** Closure: `{ a, b } => expr|block` or `{ statements }`. */
  private parseClosure(): AST.Expr {
    const open = this.expect('LBRACE', '"{"');
    // Empty braces: `{ } => body` or empty block.
    if (this.at('RBRACE')) {
      this.next();
      if (this.at('ARROW')) {
        this.next();
        const body = this.at('LBRACE') ? this.parseBlock() : this.parseExpr();
        return mkFnExpr(open.pos, [], body);
      }
      return mkFnExpr(open.pos, [], { kind: 'Block', pos: open.pos, statements: [] });
    }
    // Deterministic check for a parameter list followed by `=>`:
    // scan forward for a top-level `}` immediately followed by `=>`.
    if (this.lookaheadClosureParams()) {
      const params = this.readClosureParams();
      this.expect('ARROW', '"=>" after the closure parameter list');
      const body = this.at('LBRACE') ? this.parseBlock() : this.parseExpr();
      return mkFnExpr(open.pos, params, body);
    }
    // Plain block closure: `{ statements }`
    const block = this.parseBlockFromOpen(open);
    return mkFnExpr(open.pos, [], block);
  }

  /**
   * Scan (without consuming) from the current token to find the matching `}`
   * of the closure's opening brace. If it is immediately followed by `=>`,
   * this closure has a parameter list.
   */
  private lookaheadClosureParams(): boolean {
    let depth = 1; // we are just after the opening `{`
    for (let j = this.i; j < this.ts.length; j++) {
      const t = this.ts[j];
      if (t.type === 'EOF') return false;
      if (t.type === 'LBRACE' || t.type === 'LBRACKET' || t.type === 'LPAREN') depth++;
      else if (t.type === 'RBRACE' || t.type === 'RBRACKET' || t.type === 'RPAREN') {
        depth--;
        if (depth === 0) {
          const after = this.ts[j + 1];
          return !!after && after.type === 'ARROW';
        }
      }
    }
    return false;
  }

  private readClosureParams(): AST.FnParam[] {
    const params: AST.FnParam[] = [];
    while (true) {
      const name = this.identName('a parameter name');
      if (RESERVED.has(name)) this.err(`"${name}" is a reserved word`);
      let defaultExpr: AST.Expr | undefined;
      if (this.at('ASSIGN')) {
        this.next();
        defaultExpr = this.parseExpr();
      }
      params.push({ name, defaultExpr });
      if (this.at('COMMA')) {
        this.next();
        continue;
      }
      break;
    }
    this.expect('RBRACE', '"}" closing the closure parameter list');
    return params;
  }

  private parseBlockFromOpen(open: Token): AST.BlockStmt {
    const statements: AST.Stmt[] = [];
    while (!this.at('RBRACE')) {
      if (this.at('EOF')) this.err('Unterminated block', open, 'add a closing "}"');
      statements.push(this.parseStatement());
      this.eatSemi();
    }
    this.next(); // }
    return { kind: 'Block', pos: open.pos, statements };
  }

  private parseExprOrRender(): AST.Stmt {
    const expr = this.parseExpr();
    if (expr.kind === 'UICall') {
      const ui = expr as unknown as AST.UICallExpr;
      return { kind: 'RenderStmt', pos: ui.pos, content: ui.root };
    }
    return { kind: 'ExprStmt', pos: expr.pos, expr };
  }

  // ---------- expressions ----------

  parseExpr(): AST.Expr {
    return this.parseAssign();
  }

  private isAssignmentTarget(e: AST.Expr): boolean {
    return e.kind === 'Ident' || e.kind === 'MemberExpr' || e.kind === 'IndexExpr';
  }

  private parseAssign(): AST.Expr {
    const left = this.parseOr();
    if (this.at('ASSIGN')) {
      const eq = this.next();
      if (!this.isAssignmentTarget(left)) {
        this.err('Invalid assignment target', eq, 'you can only assign to variables, fields, or array slots');
      }
      const value = this.parseAssign();
      return { kind: 'AssignExpr', pos: left.pos, target: left, value };
    }
    if (this.at('QUESTION')) {
      const q = this.next();
      const thenExpr = this.parseAssign();
      this.expect('COLON', '":" in the ternary expression');
      const elseExpr = this.parseAssign();
      return { kind: 'TernaryExpr', pos: left.pos, condition: left, thenExpr, elseExpr };
    }
    return left;
  }

  private parseOr(): AST.Expr {
    let left = this.parseAnd();
    while (this.atKeyword('or')) {
      this.next();
      left = { kind: 'BinaryExpr', pos: left.pos, op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): AST.Expr {
    let left = this.parseComparison();
    while (this.atKeyword('and')) {
      this.next();
      left = { kind: 'BinaryExpr', pos: left.pos, op: 'and', left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): AST.Expr {
    let left = this.parseAdditive();
    while (['EQ', 'NEQ', 'LT', 'GT', 'LE', 'GE'].includes(this.peek().type)) {
      const opTok = this.next();
      left = { kind: 'BinaryExpr', pos: left.pos, op: opTok.value as AST.BinaryExpr['op'], left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): AST.Expr {
    let left = this.parseMultiplicative();
    while (this.at('PLUS') || this.at('MINUS')) {
      const opTok = this.next();
      left = { kind: 'BinaryExpr', pos: left.pos, op: opTok.value as AST.BinaryExpr['op'], left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): AST.Expr {
    let left = this.parseUnary();
    while (this.at('STAR') || this.at('SLASH') || this.at('PERCENT')) {
      const opTok = this.next();
      left = { kind: 'BinaryExpr', pos: left.pos, op: opTok.value as AST.BinaryExpr['op'], left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): AST.Expr {
    if (this.at('MINUS')) {
      const op = this.next();
      return { kind: 'UnaryExpr', pos: op.pos, op: '-', operand: this.parseUnary() };
    }
    if (this.atKeyword('not')) {
      const op = this.next();
      return { kind: 'UnaryExpr', pos: op.pos, op: 'not', operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AST.Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.at('LPAREN')) {
        this.next();
        const args: AST.Expr[] = [];
        while (!this.at('RPAREN')) {
          args.push(this.parseExpr());
          if (this.at('COMMA')) this.next();
          else if (!this.at('RPAREN')) this.err('Expected "," or ")" in argument list', this.peek());
        }
        this.next(); // )
        expr = { kind: 'CallExpr', pos: expr.pos, callee: expr, args };
      } else if (this.at('DOT')) {
        const dot = this.next();
        const propTok = this.peek();
        if (propTok.type !== 'IDENT' && propTok.type !== 'KEYWORD') {
          this.err('Expected a property name after "."', propTok);
        }
        this.next();
        expr = {
          kind: 'MemberExpr',
          pos: expr.pos,
          object: expr,
          property: { kind: 'Ident', pos: propTok.pos, name: propTok.value } as AST.Ident,
          computed: false,
        };
      } else if (this.at('LBRACKET')) {
        this.next();
        const index = this.parseExpr();
        this.expect('RBRACKET', '"]"');
        expr = { kind: 'IndexExpr', pos: expr.pos, object: expr, index };
      } else {
        break;
      }
      void 0;
    }
    return expr;
  }

  private parsePrimary(): AST.Expr {
    const t = this.peek();
    switch (t.type) {
      case 'NUMBER':
        this.next();
        return { kind: 'NumberLit', pos: t.pos, value: Number(t.value) };
      case 'STRING':
        this.next();
        return { kind: 'StringLit', pos: t.pos, value: t.value };
      case 'TEMPLATE_OPEN':
        return this.parseTemplate();
      case 'KEYWORD': {
        if (t.keyword === 'true' || t.keyword === 'false') {
          this.next();
          return { kind: 'BoolLit', pos: t.pos, value: t.keyword === 'true' };
        }
        if (t.keyword === 'null' || t.keyword === 'undefined') {
          this.next();
          return { kind: 'NullLit', pos: t.pos };
        }
        if (t.keyword === 'fn') {
          const kw = this.next();
          const params = this.parseParams();
          const body = this.parseBlock();
          return mkFnExpr(kw.pos, params, body);
        }
        return this.err(`Unexpected keyword "${t.keyword}" where a value was expected`, t);
      }
      case 'IDENT':
        this.next();
        return { kind: 'Ident', pos: t.pos, name: t.value };
      case 'LPAREN': {
        this.next();
        const inner = this.parseExpr();
        this.expect('RPAREN', '")"');
        return inner;
      }
      case 'LBRACKET':
        return this.parseArray();
      case 'LBRACE':
        return this.parseObjectLiteral();
      case 'TAG':
        return this.parseUIExpression();
      default:
        return this.err(`Expected an expression, found "${this.display(t)}"`, t);
    }
  }

  private parseTemplate(): AST.Expr {
    const start = this.next() as Token; // TEMPLATE_OPEN
    const parts: AST.Expr[] = [];
    if (start.value) parts.push({ kind: 'StringLit', pos: start.pos, value: start.value });
    while (true) {
      if (this.at('TEMPLATE_CLOSE')) {
        const close = this.next();
        if (close.value) parts.push({ kind: 'StringLit', pos: close.pos, value: close.value });
        break;
      }
      const expr = this.parseExpr();
      parts.push(expr);
      if (this.at('TEMPLATE_MID')) {
        const mid = this.next();
        if (mid.value) parts.push({ kind: 'StringLit', pos: mid.pos, value: mid.value });
        continue;
      }
      if (this.at('TEMPLATE_CLOSE')) {
        const close = this.next();
        if (close.value) parts.push({ kind: 'StringLit', pos: close.pos, value: close.value });
        break;
      }
      this.err('Unterminated template literal', this.peek(), 'expected "}" to close "${...}" and a final backtick');
    }
    if (parts.length === 0) parts.push({ kind: 'StringLit', pos: start.pos, value: '' });
    return { kind: 'TemplateLit', pos: start.pos, parts };
  }

  private parseArray(): AST.Expr {
    const open = this.expect('LBRACKET', '"["');
    const elements: AST.Expr[] = [];
    while (!this.at('RBRACKET')) {
      if (this.at('EOF')) this.err('Unterminated array literal', open, 'add a closing "]"');
      elements.push(this.parseExpr());
      if (this.at('COMMA')) this.next();
      else if (!this.at('RBRACKET')) this.err('Expected "," or "]" in array literal', this.peek());
    }
    this.next(); // ]
    return { kind: 'ArrayLit', pos: open.pos, elements };
  }

  private parseObjectLiteral(): AST.Expr {
    const open = this.expect('LBRACE', '"{"');
    const properties: AST.ObjectLit['properties'] = [];
    while (!this.at('RBRACE')) {
      if (this.at('EOF')) this.err('Unterminated object literal', open, 'add a closing "}"');
      let key: string;
      let computed = false;
      let keyExpr: AST.Expr | undefined;
      const kt = this.peek();
      if (kt.type === 'STRING' || kt.type === 'NUMBER') {
        key = this.next().value;
      } else if (kt.type === 'LBRACKET') {
        this.next();
        keyExpr = this.parseExpr();
        computed = true;
        key = '';
        this.expect('RBRACKET', '"]"');
      } else if (kt.type === 'IDENT' || kt.type === 'KEYWORD') {
        key = this.next().value;
      } else {
        this.err('Expected a property name', kt);
      }
      let value: AST.Expr;
      if (this.at('COLON')) {
        this.next();
        value = this.parseExpr();
      } else if (computed) {
        this.err('Expected ":" after a computed key', this.peek());
      } else {
        value = { kind: 'Ident', pos: kt.pos, name: key } as AST.Ident; // shorthand
      }
      properties.push({ key, computed, keyExpr, value });
      if (this.at('COMMA')) this.next();
      else if (!this.at('RBRACE')) this.err('Expected "," or "}" in object literal', this.peek());
    }
    this.next(); // }
    return { kind: 'ObjectLit', pos: open.pos, properties };
  }

  // ---------- UI ----------

  private parseUIExpression(): AST.Expr {
    const root = this.parseElement();
    return { kind: 'UICall', pos: root.pos, root } as unknown as AST.Expr;
  }

  private convertAttrs(tag: TagInfo, tok: Token): AST.Attr[] {
    const attrs: AST.Attr[] = [];
    for (const a of tag.attrs) {
      if (a.interpolated) {
        const expr = this.parseInterpExpr(a.expr, tok);
        attrs.push({ name: a.name, value: expr, pos: tok.pos });
      } else if (a.boolean) {
        // Valueless attribute: render as boolean true.
        attrs.push({ name: a.name, value: { kind: 'BoolLit', pos: tok.pos, value: true } as AST.BoolLit, pos: tok.pos });
      } else {
        attrs.push({ name: a.name, value: a.value, pos: tok.pos });
      }
    }
    return attrs;
  }

  /** Parse `attr="{expr}"` contents with positions mapped back to the outer token. */
  private parseInterpExpr(src: string, outer: Token): AST.Expr {
    const baseOffset = srcOffsetInToken(this.source, outer, src);
    const { tokens, diagnostics } = tokenize(src);
    if (diagnostics.length > 0) {
      for (const d of diagnostics) {
        this.subDiagnostics.push({ ...d, line: outer.pos.line, column: outer.pos.column, message: `In attribute expression: ${d.message}` });
      }
      this.err(`Invalid attribute expression "{${src}}"`, outer, diagnostics[0].message);
    }
    const sub = new Parser(tokens, src);
    sub.markupDepth = Math.max(0, outer.tag && !outer.tag.closing && !outer.tag.selfClosing ? 1 : 0);
    let expr: AST.Expr;
    try {
      expr = sub.parseExpr();
      if (sub.peek().type !== 'EOF') {
        this.subDiagnostics.push(error('Expected the expression to end here', outer.pos.line, outer.pos.column, `inside "{${src}"`));
        this.err(`Invalid attribute expression "{${src}}"`, outer, 'the expression did not end where expected');
      }
    } catch (e) {
      if (e instanceof ParseAbort) {
        this.subDiagnostics.push(...sub.diagnostics.map((d) => ({ ...d, line: outer.pos.line, column: outer.pos.column })));
        this.err(`Invalid attribute expression "{${src}}"`, outer, sub.diagnostics[0]?.message);
      }
      throw e;
    }
    // Re-map positions of the sub-AST onto the outer tag token (coarse mapping).
    remapPos(expr, outer.pos, baseOffset);
    return expr;
  }

  private parseElement(): AST.ContentNode {
    const tok = this.expect('TAG', 'an HTML tag like <div> or a component like <Card>');
    const tag = tok.tag!;
    if (tag.closing) this.err(`Unexpected closing tag "</${tag.name}">`, tok);
    const attributes = this.convertAttrs(tag, tok);
    const isComponent = /^[A-Z]/.test(tag.name);

    if (tag.selfClosing) {
      if (isComponent) {
        return { kind: 'ComponentCall', pos: tok.pos, name: tag.name, attributes, children: [] };
      }
      return { kind: 'Element', pos: tok.pos, tag: tag.name, attributes, children: [], selfClosing: true };
    }

    const lower = tag.name.toLowerCase();
    const rawText = RAW_TEXT_TAGS.has(lower);
    this.markupDepth++;
    const children = this.parseChildren(tag.name, tok, rawText);
    this.markupDepth--;

    if (isComponent) {
      return { kind: 'ComponentCall', pos: tok.pos, name: tag.name, attributes, children };
    }
    if (VOID_HTML.has(lower) && children.length > 0) {
      this.err(`Void element <${tag.name}> cannot have children`, tok);
    }
    return { kind: 'Element', pos: tok.pos, tag: tag.name, attributes, children, selfClosing: false };
  }

  /** Parse `<on click { bump() } <button>go</button>` into an OnWrapper node. */
  private parseOnWrapper(): AST.OnWrapperNode {
    const tok = this.expect('TAG', 'an <on ...> tag');
    const tag = tok.tag!;
    let event = '';
    let handlerSrc: string | null = null;
    for (const a of tag.attrs) {
      if (a.boolean) {
        if (!event) event = a.name.toLowerCase();
        else this.err(`Unexpected extra attribute "${a.name}" in <on>`, tok, 'usage: <on click { handler } <element>>');
      } else if (a.interpolated) {
        handlerSrc = a.expr ?? a.value;
      } else {
        if (!event) event = a.value.toLowerCase();
      }
    }
    if (!event) this.err('<on> needs an event name', tok, 'example: <on click { doThing() } <button>Go</button>');
    if (!VALID_EVENTS.includes(event)) {
      this.err(`Unsupported event "${event}"`, tok, `supported events: ${VALID_EVENTS.join(', ')}`);
    }
    if (!handlerSrc) this.err('<on> needs a { handler } block', tok, 'example: <on click { count = count + 1 } <button>+1</button>');
    const handler = this.parseInterpExpr(handlerSrc, tok);
    const child = this.parseElement();
    // Consume the wrapper's closing </on>.
    const close = this.peek();
    if (close.type === 'TAG' && close.tag?.closing && close.tag.name === 'on') this.next();
    else this.err('Expected "</on>" to close the <on> wrapper', close);
    return { kind: 'OnWrapper', pos: tok.pos, event, handler, child };
  }

  /** Parse `{for x in xs <body>}` / `{if cond <body>}` directives in markup. */
  private parseDirective(): AST.ContentNode {
    const tok = this.expect('DIRECTIVE', 'a UI directive');
    if (tok.value === 'for') {
      const varName = this.identName('a loop variable name');
      if (!this.atKeyword('in') && !this.atKeyword('of')) {
        this.err('Expected "in" after the loop variable', this.peek(), 'example: {for item in items <li>{item}</li>}');
      }
      this.next();
      const iterable = this.parseExpr();
      const body = this.parseDirectiveBody(tok, 'for');
      return { kind: 'ForDirective', pos: tok.pos, varName, iterable, body };
    }
    const condition = this.parseExpr();
    const then = this.parseDirectiveBody(tok, 'if');
    return { kind: 'IfDirective', pos: tok.pos, condition, then };
  }

  private parseDirectiveBody(dirTok: Token, which: string): AST.ContentNode[] {
    const depthBefore = this.markupDepth;
    this.markupDepth++;
    const body: AST.ContentNode[] = [];
    while (true) {
      const t = this.peek();
      if (t.type === 'EOF') {
        this.markupDepth = depthBefore;
        this.err(`Unterminated {${which} directive}`, dirTok, `add a closing "}"`);
      }
      if (t.type === 'DIRECTIVE_END') {
        this.next();
        break;
      }
      body.push(...this.parseContentSequence(t));
    }
    this.markupDepth = depthBefore;
    if (body.length === 0) this.err(`The {${which} directive has an empty body`, dirTok);
    return body;
  }

  /** Parse one content node from the current markup token (shared by children & directives). */
  private parseContentSequence(t: Token): AST.ContentNode[] {
    if (t.type === 'TAG') {
      if (t.tag!.closing) this.err(`Unexpected closing tag "${t.value}"`, t);
      return [t.tag!.name === 'on' && !t.tag!.closing ? this.parseOnWrapper() : this.parseElement()];
    }
    if (t.type === 'DIRECTIVE') return [this.parseDirective()];
    if (t.type === 'LBRACE') {
      this.next();
      const expr = this.parseExpr();
      this.expect('RBRACE', '"}" after the interpolation');
      return [{ kind: 'Interpolation', pos: t.pos, expr }];
    }
    if (t.type === 'TEMPLATE_OPEN') return [{ kind: 'Interpolation', pos: t.pos, expr: this.parseTemplate() }];
    if (t.type === 'TEXT') return [{ kind: 'Text', pos: t.pos, value: this.next().value }];
    this.err(`Unexpected "${this.display(t)}" inside a UI directive`, t);
  }

  private parseChildren(parentName: string, parentTok: Token, rawText: boolean): AST.ContentNode[] {
    const children: AST.ContentNode[] = [];
    let textBuf = '';
    let textStart = parentTok.end;

    const flushText = () => {
      const collapsed = rawText ? textBuf : collapseWhitespace(textBuf);
      if (collapsed) children.push({ kind: 'Text', pos: textStart, value: collapsed });
      textBuf = '';
    };

    while (true) {
      const t = this.peek();
      if (t.type === 'EOF') {
        this.err(`Unterminated element <${parentName}>`, parentTok, `add a closing </${parentName}>`);
      }
      if (t.type === 'TAG' && t.tag!.closing) {
        if (t.tag!.name === 'on') {
          // The wrapper close is consumed by parseOnWrapper itself.
          this.err(`Unexpected "</on>" here`, t);
        }
        if (t.tag!.name !== parentName) {
          this.err(`Mismatched closing tag: expected </${parentName}>, found </${t.tag!.name}>`, t);
        }
        this.next();
        flushText();
        return children;
      }
      if (t.type === 'TAG') {
        flushText();
        if (t.tag!.name === 'on' && !t.tag!.closing) {
          children.push(this.parseOnWrapper());
          continue;
        }
        children.push(this.parseElement());
        continue;
      }
      if (t.type === 'DIRECTIVE') {
        flushText();
        children.push(this.parseDirective());
        continue;
      }
      if (t.type === 'LBRACE') {
        flushText();
        this.next();
        const expr = this.parseExpr();
        this.expect('RBRACE', '"}" after the interpolation');
        children.push({ kind: 'Interpolation', pos: t.pos, expr });
        continue;
      }
      if (t.type === 'TEMPLATE_OPEN') {
        flushText();
        children.push({ kind: 'Interpolation', pos: t.pos, expr: this.parseTemplate() });
        continue;
      }
      if (t.type === 'TEXT') {
        if (!textBuf) textStart = t.pos;
        textBuf += this.next().value;
        continue;
      }
      // Any other token inside markup is literal text (preserves entities like &amp;).
      if (!textBuf) textStart = t.pos;
      textBuf += this.source.slice(t.pos.offset, t.end.offset);
      this.next();
    }
  }
}

const RAW_TEXT_TAGS = new Set(['script', 'style']);

function mkFnExpr(pos: SourcePosition, params: AST.FnParam[], body: AST.BlockStmt | AST.Expr): AST.Expr {
  return { kind: 'FnExpr', pos, params, body } as unknown as AST.Expr;
}

/** Collapse runs of whitespace/newlines to single spaces; pure whitespace becomes ''. */
function collapseWhitespace(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ');
  return collapsed.trim() === '' && /\n/.test(s) ? '' : collapsed;
}

function srcOffsetInToken(source: string, tok: Token, src: string): number {
  const idx = source.indexOf(src, tok.pos.offset);
  return idx < 0 ? tok.pos.offset : idx;
}

/** Coarsely re-map all node positions in a sub-AST to the outer token position. */
function remapPos(node: unknown, pos: SourcePosition, _baseOffset: number) {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if ('kind' in n && 'pos' in n) n.pos = pos;
  for (const key of Object.keys(n)) {
    const v = n[key];
    if (Array.isArray(v)) for (const item of v) remapPos(item, pos, _baseOffset);
    else if (v && typeof v === 'object' && !(v as any).line) remapPos(v, pos, _baseOffset);
  }
}
