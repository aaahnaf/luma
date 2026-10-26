// Lexer for the Luna language.
// Turns source text into a flat token stream with line/column positions.
//
// Context model: the lexer maintains a stack of contexts. `markup` contexts
// are active inside element bodies (between `<tag>` and `</tag>`) and inside
// `{for ...}` / `{if ...}` UI directives; everything else is `code`. In
// markup, plain prose (including non-ASCII glyphs like ☾) becomes TEXT runs,
// while in code the same characters are ordinary identifiers/operators.

import { Token, TokenType, SourcePosition, TagInfo, TagAttr, isKeyword } from './tokens';
import { Diagnostic, error } from './diagnostics';

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/;
const ATTR_NAME = /[a-zA-Z_][a-zA-Z0-9_:.-]*/;

/** Characters that, when they follow an expression, indicate the next `<`/`>` are comparisons. */
const EXPR_END_TYPES = new Set<TokenType>([
  'IDENT',
  'NUMBER',
  'STRING',
  'TEMPLATE_CLOSE',
  'RPAREN',
  'RBRACKET',
  'KEYWORD', // true/false/null/undefined end expressions
]);

class Bail extends Error {}

export function tokenize(source: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const lexer = new Lexer(source);
  try {
    const tokens = lexer.run();
    return { tokens, diagnostics: lexer.diagnostics };
  } catch (e) {
    if (e instanceof Bail) {
      return { tokens: [], diagnostics: lexer.diagnostics };
    }
    throw e;
  }
}

type Ctx = 'code' | 'markup' | 'attr' | 'template' | 'interp';

/** A `{` frame on the lexer's brace stack, with how its `}` should tokenize. */
interface BraceFrame {
  ctx: Ctx;
  kind: 'code' | 'render' | 'directiveBody' | 'interp' | 'templateHole' | 'object';
}

/** Lex `src` as markup content (as inside a render block). Exported for
 *  tests; the parser also uses it to re-lex recovered source. */
export function tokenizeMarkup(src: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const lexer = new Lexer('render {' + src + '\n}');
  try {
    const all = lexer.run();
    const tokens = all.slice(2, all.length - 2); // drop KEYWORD(render), LBRACE, RBRACE, EOF
    return { tokens, diagnostics: lexer.diagnostics };
  } catch (e) {
    if (e instanceof Bail) return { tokens: [], diagnostics: lexer.diagnostics };
    throw e;
  }
}

class Lexer {
  source: string;
  pos = 0;
  line = 1;
  col = 1;
  tokens: Token[] = [];
  diagnostics: Diagnostic[] = [];
  /** Tracks whether the previous significant token can end an expression. */
  private prevExprEnd = false;
  /** Set while scanning a tag header: `<`/`>` there are tag delimiters, never comparisons. */
  private inTagHeader = false;
  /** Stack of open `{` frames (code blocks, render blocks, interpolations, templates, directives). */
  private braceStack: BraceFrame[] = [];
  /** Number of open elements whose children are markup. The parser
   *  mirrors this when parsing element bodies (markupDepth > 0 means "inside
   *  an element", which is the only situation where prose becomes TEXT). */
  markupDepth = 0;
  /** When > 0, the next `{` is an interpolation inside markup. Set by the
   *  parser's sub-lexers (`sub.interpOnly++`) so element bodies never treat
   *  `{` as a directive header — directives are parsed only at sibling level. */
  interpOnly = 0;
  /** Set after emitting a DIRECTIVE token: the next scan captures the raw
   *  directive header text (everything up to the body-opening `{`). */
  private directiveHeaderActive = false;
  /** Raw-capture state for an `<on event { handler } ...>` wrapper tag whose
   *  header contains a brace group. The scanner walks the source until the
   *  real tag-closing `>` (depth 0), skipping strings and balanced groups, so
   *  handler bodies with arbitrary braces/newlines cannot break tag lexing. */
  private onRawScan: { start: SourcePosition; name: string } | null = null;

  constructor(source: string) {
    this.source = source;
  }

  private push(ctx: Ctx, kind: BraceFrame['kind']) {
    this.braceStack.push({ ctx, kind });
  }

  private err(message: string, hint?: string): never {
    this.diagnostics.push(error(message, this.line, this.col, hint));
    throw new Bail();
  }

  private ch(offset = 0): string {
    return this.source[this.pos + offset] ?? '\u0000';
  }

  private advance(): string {
    const c = this.source[this.pos];
    this.pos++;
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private make(type: TokenType, value: string, start: SourcePosition, extra?: Partial<Token>): Token {
    const tok: Token = {
      type,
      value,
      pos: start,
      end: { line: this.line, column: this.col, offset: this.pos },
      ...extra,
    };
    this.tokens.push(tok);
    this.prevExprEnd = EXPR_END_TYPES.has(type);
    return tok;
  }

  run(): Token[] {
    while (this.pos < this.source.length || !this.eofEmitted) {
      this.step();
      if (this.eofEmitted) break;
    }
    return this.tokens;
  }

  private eofEmitted = false;

  private step() {
    const startPos = this.pos;
    const startLen = this.tokens.length;
    this.skipTrivia();
    if (this.pos >= this.source.length) {
      const p = this.position();
      this.tokens.push({ type: 'EOF', value: '', pos: p, end: p });
      this.eofEmitted = true;
      return;
    }
    this.scanToken();
    // A scan that neither consumed input nor produced a token would spin the
    // caller forever; fail fast with a diagnostic instead.
    if (this.pos === startPos && this.tokens.length === startLen && !this.eofEmitted) {
      this.err(`Unexpected character "${this.ch()}"`, 'check for stray punctuation or an unclosed string/tag nearby');
    }
  }

  private position(): SourcePosition {
    return { line: this.line, column: this.col, offset: this.pos };
  }

  private skipTrivia() {
    while (this.pos < this.source.length) {
      const c = this.ch();
      if (c === ' ' || c === '\t' || c === '\r') {
        this.advance();
      } else if (c === '/' && this.ch(1) === '/') {
        while (this.pos < this.source.length && this.ch() !== '\n') this.advance();
      } else if (c === '/' && this.ch(1) === '*') {
        const start = this.position();
        this.advance();
        this.advance();
        let closed = false;
        while (this.pos < this.source.length) {
          if (this.ch() === '*' && this.ch(1) === '/') {
            this.advance();
            this.advance();
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) this.err('Unterminated block comment', `comment started at line ${start.line}`);
      } else {
        break;
      }
    }
  }

  /** True when the current position sits inside element/directive markup
   *  (i.e. the innermost open `{` frame — if any — is a markup frame). */
  private inMarkup(): boolean {
    if (this.markupDepth > 0 && this.braceStack.length === 0) return true; // bare element bodies (sub-lexed fragments)
    const top = this.braceStack[this.braceStack.length - 1];
    return top ? top.ctx === 'markup' : false;
  }

  /** True when an element or render block has left an implicit markup region
   *  that a stray `}` should close (e.g. `<div>` opened inside `render {`). */
  private hasImplicitMarkupFrame(): boolean {
    return this.braceStack.some((f) => f.ctx === 'markup' && f.kind === 'code');
  }

  private scanToken() {
    const start = this.position();
    const c = this.ch();

    if (c === '\n') {
      this.advance();
      // Newlines inside markup content are formatting only — the parser joins
      // adjacent TEXT runs. Emitting them as tokens would let a stray `\n`
      // terminate an interpolation or directive header scan prematurely.
      if (!this.inMarkup()) {
        this.tokens.push({ type: 'NEWLINE', value: '\n', pos: start, end: this.position() });
      }
      return;
    }

    // Directive headers (`{for x in xs`, `{if cond`) are captured verbatim as
    // raw source text — balanced braces and strings included — and re-lexed by
    // the parser via a sub-lexer. This keeps operators like `>` inside the
    // header from being misread as markup or comparison tokens at top level.
    if (this.directiveHeaderActive) {
      this.scanDirectiveHeader(start);
      return;
    }

    // Raw capture for `<on event { handler } ...>` wrapper tags (see onRawScan).
    if (this.onRawScan) {
      this.continueOnRawScan();
      return;
    }

    // Inside a tag header, prose words are attribute names / static values —
    // never language keywords. This must be checked before the directive-header
    // and raw-capture states above? No: those states are handled above. This
    // guard covers the normal in-header scan path used by sub-lexers.
    if (this.inTagHeader && ID_START.test(c)) {
      let word = '';
      while (this.pos < this.source.length && ID_CHAR.test(this.ch())) word += this.advance();
      this.make('IDENT', word, start);
      return;
    }

    // ---- markup context: prose becomes whole TEXT runs ----
    if (this.inMarkup()) {
      if (c === '}') {
        // A `}` inside an element body closes the innermost open markup frame
        // (render block, directive body, or implicit element frame) — it is
        // never prose. This lets `{for x in xs <li>{x}</li>}` and single-line
        // `render { <h1>Hi</h1> }` terminate correctly even though an open
        // `<li>`/`<h1>` keeps us in markup.
        const top = this.braceStack[this.braceStack.length - 1];
        if (top && top.ctx === 'markup') {
          this.advance();
          this.braceStack.pop();
          this.markupDepth--;
          if (top.kind === 'render') this.make('RBRACE', '}', start);
          else this.make('DIRECTIVE_END', '}', start);
          return;
        }
        this.scanTextRun(start);
        return;
      }
      if (c !== '<' && c !== '{') {
        this.scanTextRun(start);
        return;
      }
    }

    // Identifiers / keywords. Inside element/directive markup, words are
    // prose (the markup branch above normally catches them first; this guard
    // covers frames where markup context is implied but prose must not be
    // mistaken for language keywords).
    if (ID_START.test(c)) {
      if (this.inMarkup()) {
        this.scanTextRun(start);
        return;
      }
      let word = '';
      while (this.pos < this.source.length && ID_CHAR.test(this.ch())) word += this.advance();
      if (isKeyword(word)) {
        this.make('KEYWORD', word, start, { keyword: word });
      } else {
        this.make('IDENT', word, start);
      }
      return;
    }

    // Numbers
    if (DIGIT.test(c)) {
      let num = '';
      while (DIGIT.test(this.ch())) num += this.advance();
      if (this.ch() === '.' && DIGIT.test(this.ch(1))) {
        num += this.advance();
        while (DIGIT.test(this.ch())) num += this.advance();
      }
      if (this.ch() === 'e' || this.ch() === 'E') {
        const save = { pos: this.pos, line: this.line, col: this.col };
        let exp = this.advance();
        if (this.ch() === '+' || this.ch() === '-') exp += this.advance();
        if (DIGIT.test(this.ch())) {
          while (DIGIT.test(this.ch())) exp += this.advance();
          num += exp;
        } else {
          this.pos = save.pos;
          this.line = save.line;
          this.col = save.col;
        }
      }
      this.make('NUMBER', num, start);
      return;
    }

    // Strings
    if (c === '"' || c === "'") {
      this.scanString(c, start);
      return;
    }

    // Template literals
    if (c === '`') {
      this.scanTemplate(start);
      return;
    }

    // Style blocks: `{style ... }` — raw CSS text (code context only).
    if (c === '{' && !this.inMarkup() && /^style(?![A-Za-z0-9_$])/.test(this.source.slice(this.pos + 1))) {
      this.scanStyleBlock(start);
      return;
    }

    // The `render` keyword is followed by a `{ ... }` UI block. Emit the
    // keyword here; the following `{` opens the markup context (handled in
    // the LBRACE case via renderBodyPending). This applies anywhere a
    // statement can appear — top level, component bodies, and code blocks —
    // but never inside element/directive markup, where `render` is prose.
    // `render` is emitted as an ordinary KEYWORD; the LBRACE case detects a
    // `render {` sequence by inspecting the previous token and opens a markup
    // frame instead of a code frame.


    // UI directives inside markup: `{for ... }`, `{if ... }`.
    if (c === '{' && this.inMarkup()) {
      const kw = this.interpOnly > 0 ? null : this.lookaheadDirective();
      if (kw) {
        this.advance(); // {
        while (this.ch() === ' ' || this.ch() === '\t') this.advance();
        for (let k = 0; k < kw.length; k++) this.advance();
        this.make('DIRECTIVE', kw, start);
        // The directive header (`x in items` / `cond`) is captured verbatim as
        // raw source text (see scanDirectiveHeader) and re-lexed by the parser.
        this.directiveHeaderActive = true;
        return;
      }
      // A `{` at sibling level inside a render block opens a nested render
      // block only when it follows the `render` keyword; everywhere else in
      // markup it is an interpolation.
      const prevD = this.tokens[this.tokens.length - 1];
      if (prevD && prevD.type === 'KEYWORD' && prevD.keyword === 'render') {
        this.advance();
        this.push('markup', 'render');
        this.markupDepth++;
        this.make('LBRACE', '{', start);
        return;
      }
      this.advance();
      this.push('interp', 'interp');
      this.make('LBRACE', '{', start);
      return;
    }

    switch (c) {
      case '{': {
        const prev = this.tokens[this.tokens.length - 1];
        const prevRenderKw = !!prev && prev.type === 'KEYWORD' && prev.keyword === 'render';
        this.advance();
        if (prevRenderKw) {
          // `render { ... }` anywhere a statement may appear: the block is a
          // markup region until its `}`.
          this.push('markup', 'render');
          this.markupDepth++;
          this.make('LBRACE', '{', start);
          return;
        }
        if (this.inMarkup()) {
          // Inside markup, `{ ... }` is an interpolation: its contents are
          // code until the matching `}` returns us to the markup frame.
          this.push('interp', 'interp');
          this.make('LBRACE', '{', start);
          return;
        }
        // Braces in code context are ordinary code braces (blocks, object
        // literals, closures). They never shadow surrounding markup frames.
        this.push('code', 'code');
        this.make('LBRACE', '{', start);
        return;
      }
      case '}': {
        this.advance();
        const topNow = this.braceStack[this.braceStack.length - 1];
        if (topNow && topNow.ctx === 'interp') {
          // Close of a markup interpolation `{ expr }`: pop back to markup.
          this.braceStack.pop();
          this.make('RBRACE', '}', start);
          this.prevExprEnd = true;
          return;
        }
        // Pop any nested 'code'/'templateHole' frames until we reach a boundary context.
        while (this.braceStack.length > 0) {
          const t = this.braceStack[this.braceStack.length - 1];
          if ((t.ctx === 'code' && t.kind === 'code') || t.ctx === 'interp') this.braceStack.pop();
          else break;
        }
        const top = this.braceStack[this.braceStack.length - 1];
        if (top && top.ctx === 'template') {
          this.braceStack.pop();
          // Continue scanning the rest of the template literal.
          this.scanTemplateContinue(start);
          return;
        }
        if (top && top.ctx === 'markup') {
          // Close of a `render { ... }` block or an element/directive markup
          // frame. Render blocks were opened with an LBRACE token the parser
          // must match, so they emit RBRACE; directive bodies and implicit
          // element frames emit DIRECTIVE_END so their terminator is
          // distinguishable from interpolations nested inside them.
          const kind = top.kind;
          this.braceStack.pop();
          this.markupDepth--;
          if (kind === 'render') this.make('RBRACE', '}', start);
          else this.make('DIRECTIVE_END', '}', start);
          return;
        }
        this.make('RBRACE', '}', start);
        this.prevExprEnd = true;
        return;
      }
      case '(':
        this.advance();
        this.make('LPAREN', '(', start);
        return;
      case ')':
        this.advance();
        this.make('RPAREN', ')', start);
        this.prevExprEnd = true;
        return;
      case '[':
        this.advance();
        this.make('LBRACKET', '[', start);
        return;
      case ']':
        this.advance();
        this.make('RBRACKET', ']', start);
        this.prevExprEnd = true;
        return;
      case ',':
        this.advance();
        this.make('COMMA', ',', start);
        return;
      case '.':
        this.advance();
        this.make('DOT', '.', start);
        return;
      case ':':
        this.advance();
        this.make('COLON', ':', start);
        return;
      case '?':
        this.advance();
        this.make('QUESTION', '?', start);
        return;
      case ';':
        this.advance();
        this.make('SEMI', ';', start);
        return;
      case '+':
        this.advance();
        this.make('PLUS', '+', start);
        return;
      case '-':
        this.advance();
        this.make('MINUS', '-', start);
        return;
      case '*':
        this.advance();
        this.make('STAR', '*', start);
        return;
      case '%':
        this.advance();
        this.make('PERCENT', '%', start);
        return;
      case '/':
        this.advance();
        this.make('SLASH', '/', start);
        return;
      case '=':
        if (this.ch(1) === '>') {
          this.advance();
          this.advance();
          this.make('ARROW', '=>', start);
          return;
        }
        if (this.ch(1) === '=') {
          this.advance();
          this.advance();
          this.make('EQ', '==', start);
          return;
        }
        this.advance();
        this.make('ASSIGN', '=', start);
        return;
      case '!':
        if (this.ch(1) === '=') {
          this.advance();
          this.advance();
          this.make('NEQ', '!=', start);
          return;
        }
        this.err('Unexpected character "!"', 'use the keyword "not" to negate a value');
      case '<':
      case '>':
        if (this.isTagStart(c)) {
          this.scanTag(start);
          return;
        }
        // Comparison operators
        if (c === '<') {
          if (this.ch(1) === '=') {
            this.advance();
            this.advance();
            this.make('LE', '<=', start);
          } else {
            this.advance();
            this.make('LT', '<', start);
          }
        } else {
          if (this.ch(1) === '=') {
            this.advance();
            this.advance();
            this.make('GE', '>=', start);
          } else {
            this.advance();
            this.make('GT', '>', start);
          }
        }
        this.prevExprEnd = false;
        return;
      default: {
        this.err(`Unexpected character "${c}"`);
      }
    }
  }

  /** Consume a maximal whitespace-delimited prose run as one TEXT token. */
  private scanTextRun(start: SourcePosition) {
    let i = this.pos;
    while (i < this.source.length) {
      const s = this.source[i];
      if (s === '\n' || s === ' ' || s === '\t' || s === '\r') break;
      if (s === '<' || s === '{') break;
      i++;
    }
    const value = this.source.slice(this.pos, i);
    while (this.pos < i) this.advance();
    this.make('TEXT', value, start);
  }

  /**
   * Capture the raw source of a directive header (`{for x in xs` → `x in xs`)
   * immediately after its DIRECTIVE token was emitted. The header runs to the
   * `{` that opens the directive body — balanced braces and quoted strings are
   * skipped so constructs like `{if len(xs) == 2 { ... } <p>}` capture the
   * whole condition. If no body brace is found before EOF, the header ends at
   * the matching `}` of the directive group itself (the parser then reports a
   * missing body).
   */
  private scanDirectiveHeader(start: SourcePosition) {
    this.directiveHeaderActive = false;
    const src = this.source;
    let i = this.pos;
    let depth = 0; // nesting inside the captured expression (parens/brackets/braces)
    let end = -1; // offset of the body-opening `{`, or of the group's final `}`
    let bodyFound = false;
    while (i < src.length) {
      const v = src[i];
      if (v === '"' || v === "'" || v === '`') {
        const q = v;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (v === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
        // A tag opening at header depth means the body starts right here
        // (`{for x in xs <li>...}`): no separate `{` body delimiter exists.
        if (depth === 0) {
          end = i;
          break;
        }
        i++;
        continue;
      }
      if (v === '(' || v === '[') {
        depth++;
        i++;
        continue;
      }
      if (v === ')' || v === ']') {
        depth = Math.max(0, depth - 1);
        i++;
        continue;
      }
      if (v === '{') {
        if (depth === 0) {
          end = i;
          bodyFound = true;
          break;
        }
        depth++;
        i++;
        continue;
      }
      if (v === '}') {
        if (depth === 0) {
          end = i; // the `}` that closes the directive group (no body)
          break;
        }
        depth--;
        i++;
        continue;
      }
      i++;
    }
    if (end < 0) {
      this.err('Unterminated directive', 'every "{for" / "{if" needs a matching "}"');
    }
    const header = src.slice(this.pos, end).trim();
    this.syncTo(end);
    if (bodyFound) {
      this.advance(); // consume the body-opening `{`
      this.push('markup', 'directiveBody');
      this.markupDepth++;
    } else {
      this.advance(); // consume the group-closing `}`
    }
    if (header) {
      this.tokens.push({ type: 'DIRECTIVE_HDR', value: header, pos: start, end: this.position() });
    }
  }

  private isTagStart(c: '<' | '>'): boolean {
    if (c === '>') return false; // '>' only opens a tag via scanTag internals (never here)
    const next = this.ch(1);
    if (next === '/') return TAG_NAME.test(this.ch(2));
    if (!TAG_NAME.test(next)) return false;
    // `<on event { handler } <button>` wraps an element: its closing `>`
    // arrives after a `}`, so bypass the comparison heuristic for it.
    if (this.source.startsWith('on', this.pos + 1) && !/[A-Za-z0-9_-]/.test(this.ch(3))) {
      let depth = 0;
      for (let i = this.pos + 1; i < this.source.length; i++) {
        const s = this.source[i];
        if (s === '\n' && depth === 0) return false;
        if (s === '{') depth++;
        else if (s === '}') depth--;
        else if (s === '>' && depth === 0) return true;
      }
      return false;
    }
    // A tag must be terminated by `>` on the same line (or within its inline
    // `{ ... }` groups), otherwise treat the `<` as a comparison operator and
    // let the parser report a useful error. The scanTag header scanner skips
    // quoted strings and balanced brace groups, so `>` inside handler source
    // never falsely terminates the search.
    {
      let depth = 0;
      let i = this.pos + 1;
      while (i < this.source.length) {
        const s = this.source[i];
        if (s === '"' || s === "'") {
          const q = s;
          i++;
          while (i < this.source.length && this.source[i] !== q) {
            if (this.source[i] === '\\') i++;
            i++;
          }
          i++;
          continue;
        }
        if (s === '\n' && depth === 0) return false;
        if (s === '{') depth++;
        else if (s === '}') depth--;
        else if (s === '>' && depth === 0) return true;
        else if (s === '/' && depth === 0 && this.source[i + 1] === '>') return true;
        i++;
      }
      return false;
    }
  }

  /**
   * If we are at `{` followed by a UI directive keyword (`for` or `if`), and
   * the brace group is balanced before EOF, return the keyword. Object
   * literals such as `{ for: 1 }` (colon before any brace close) are rejected.
   */
  private lookaheadDirective(): 'for' | 'if' | null {
    const m = /^\{\s*(for|if)(?![A-Za-z0-9_$])/.exec(this.source.slice(this.pos));
    if (!m) return null;
    // A directive may only appear where a sibling content node can start:
    // directly inside a markup frame with nothing open above it. Interpolations,
    // tag bodies and directive headers push frames, so `{for ...}` inside them
    // is never a directive.
    const stackTop = this.braceStack[this.braceStack.length - 1];
    if (!(stackTop && stackTop.ctx === 'markup')) return null;
    const kw = m[1] as 'for' | 'if';
    let depth = 0;
    for (let i = this.pos; i < this.source.length; i++) {
      const s = this.source[i];
      if (s === '{') depth++;
      else if (s === '}') {
        depth--;
        if (depth === 0) return kw; // balanced — plausible directive
      } else if (s === ':' && depth === 1) {
        return null; // looks like an object literal key
      }
    }
    return null; // unbalanced braces — not a directive
  }

  private scanString(quote: string, start: SourcePosition) {
    this.advance(); // opening quote
    let value = '';
    while (true) {
      if (this.pos >= this.source.length || this.ch() === '\n') {
        this.err('Unterminated string literal', 'strings must be closed on the same line');
      }
      const c = this.advance();
      if (c === quote) break;
      if (c === '\\') {
        if (this.pos >= this.source.length) this.err('Unterminated string literal');
        const esc = this.advance();
        switch (esc) {
          case 'n':
            value += '\n';
            break;
          case 't':
            value += '\t';
            break;
          case 'r':
            value += '\r';
            break;
          case '\\':
            value += '\\';
            break;
          case '"':
            value += '"';
            break;
          case "'":
            value += "'";
            break;
          case '`':
            value += '`';
            break;
          default:
            value += esc;
        }
      } else {
        value += c;
      }
    }
    this.make('STRING', value, start);
  }

  /** Scan from the opening backtick of a template literal. */
  private scanTemplate(start: SourcePosition) {
    this.advance(); // consume `
    this.scanTemplateBody(start, 'TEMPLATE_OPEN');
  }

  /** After a `}` that closes a `${...}` hole, continue scanning template text. */
  private scanTemplateContinue(start: SourcePosition) {
    this.scanTemplateBody(start, 'TEMPLATE_MID');
  }

  private scanTemplateBody(start: SourcePosition, openType: 'TEMPLATE_OPEN' | 'TEMPLATE_MID') {
    let text = '';
    while (true) {
      if (this.pos >= this.source.length) {
        this.err('Unterminated template literal', 'close it with a backtick (`)');
      }
      const c = this.ch();
      if (c === '`') {
        this.advance();
        this.make('TEMPLATE_CLOSE', text, start);
        return;
      }
      if (c === '\\') {
        this.advance();
        if (this.pos >= this.source.length) this.err('Unterminated template literal');
        const esc = this.advance();
        switch (esc) {
          case 'n':
            text += '\n';
            break;
          case 't':
            text += '\t';
            break;
          case '`':
            text += '`';
            break;
          case '\\':
            text += '\\';
            break;
          default:
            text += esc;
        }
        continue;
      }
      if (c === '$' && this.ch(1) === '{') {
        this.advance();
        this.advance();
        this.make(openType, text, start);
        this.braceStack.push('template');
        return;
      }
      this.advance();
      text += c === '\n' ? '\n' : c;
    }
  }

  private scanStyleBlock(start: SourcePosition) {
    // current char is '{'
    this.advance(); // {
    let depth = 1;
    let text = '';
    while (true) {
      if (this.pos >= this.source.length) {
        this.err('Unterminated style block', 'every "{style" needs a matching "}"');
      }
      const c = this.ch();
      if (c === '{') depth++;
      if (c === '}') {
        depth--;
        if (depth === 0) {
          this.advance();
          break;
        }
      }
      text += this.advance();
    }
    // Strip the leading "style" keyword from the captured text.
    const css = text.replace(/^\s*style/, '');
    this.tokens.push({ type: 'CSSBLOCK', value: css, pos: start, end: this.position() });
    this.prevExprEnd = true;
  }

  private scanTag(start: SourcePosition) {
    // Raw header scanner. The tag header is scanned directly from source so
    // that `{ ... }` groups (interpolations, inline event handlers) can be
    // captured verbatim — including newlines and braces inside strings —
    // without the main token loop misinterpreting them. After scanning, the
    // expression sources are re-tokenized by the parser via sub-lexers.
    const src = this.source;
    let i = this.pos + 1; // after '<'
    let closing = false;
    if (src[i] === '/') {
      closing = true;
      i++;
    }
    const nameStart = i;
    while (i < src.length && /[a-zA-Z0-9-]/.test(src[i])) i++;
    const name = src.slice(nameStart, i);
    if (!name) {
      this.advance();
      this.err('Malformed tag', 'expected a tag name after "<"');
    }

    /** Skip spaces/tabs inside the header. Newlines are rejected: tags must
     *  close on one line (otherwise `a < b` comparisons would swallow lines). */
    const skipWs = () => {
      while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i++;
    };

    /** Capture a balanced `{ ... }` group at src[i]. Returns inner text or null. */
    const captureGroup = (): string | null => {
      if (src[i] !== '{') return null;
      let d = 0;
      const innerStart = i + 1;
      while (i < src.length) {
        const v = src[i];
        if (v === '{') d++;
        else if (v === '}') {
          d--;
          if (d === 0) {
            const inner = src.slice(innerStart, i);
            i++; // consume final }
            return inner;
          }
        }
        i++;
      }
      return null;
    };

    /** Read a quoted string (raw, quotes included), honoring backslash escapes. */
    const readQuoted = (): string | null => {
      const q = src[i];
      let out = q;
      i++;
      while (i < src.length) {
        const v = src[i];
        if (v === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += v;
        i++;
        if (v === q) return out;
      }
      return null; // unterminated
    };

    const attrs: TagAttr[] = [];
    let selfClosing = false;
    // `<on event { handler } <child>` wrapper tags: the header contains a
    // multi-line balanced group followed by the child's `<`, which the inline
    // scanner cannot handle. Hand the whole tag over to the raw-capture state
    // machine, which walks to the real depth-0 tag terminator and re-parses
    // the collected header with this same grammar.
    if (name === 'on' && !closing) {
      this.onRawScan = { start, name };
      return;
    }
    this.inTagHeader = true;

    while (true) {
      skipWs();
      if (i < src.length && src[i] === '\n') {
        this.syncTo(i);
        this.inTagHeader = false;
        this.err('Unterminated tag', `tags must be closed on one line ("<${name}")`);
      }
      if (i >= src.length) {
        this.syncTo(i);
        this.inTagHeader = false;
        this.err('Unterminated tag', `tag "<${name}" was never closed with ">"`);
      }
      const c = src[i];
      if (c === '/' && src[i + 1] === '>') {
        i += 2;
        selfClosing = true;
        break;
      }
      if (c === '>') {
        i += 1;
        break;
      }
      if (closing) {
        this.syncTo(i);
        this.inTagHeader = false;
        this.err(`Unexpected content in closing tag "</${name}`, 'closing tags take no attributes');
      }
      // Inline event attribute: `on keyup { handler }` / `on click={fn}`.
      if (c === 'o' && src.startsWith('on', i) && !/[A-Za-z0-9_:.-]/.test(src[i + 2] ?? '')) {
        let j = i + 2;
        const nc = src[j];
        if (nc === ' ' || nc === '\t' || nc === '=') {
          i = j;
          if (src[i] === '=') i++;
          skipWs();
          let evName = '';
          while (i < src.length && ID_CHAR.test(src[i])) evName += src[i++];
          evName = evName.toLowerCase();
          if (!evName) {
            this.syncTo(i);
            this.inTagHeader = false;
            this.err('Expected an event name after "on"', 'example: on click { doThing() }');
          }
          skipWs();
          // `<input on keyup { ... >`: the tag header scanner cannot capture a
          // multi-line balanced group safely, so hand over to the raw-capture
          // state machine which walks the source until the real tag close.
          if (name !== 'on' && src[i] === '{') {
            this.onRawScan = { start, name };
            return;
          }
          let handlerSrc: string | null = null;
          if (src[i] === '{') {
            handlerSrc = captureGroup();
          } else if (src[i] === '"' || src[i] === "'") {
            const rawFull = readQuoted();
            const raw = rawFull && rawFull.length >= 2 ? rawFull.slice(1, -1) : null;
            if (raw !== null) {
              const m = /^\{\s*([\s\S]*?)\s*\}$/.exec(raw);
              handlerSrc = m ? m[1] : null;
            }
          }
          if (handlerSrc === null || handlerSrc.trim().length === 0) {
            this.syncTo(i);
            this.inTagHeader = false;
            this.err(`Inline event "on ${evName}" needs a { handler } block`, `example: on ${evName} { doThing() }`);
          }
          attrs.push({ name: `on ${evName}`, value: handlerSrc.trim(), interpolated: false, boolean: false, event: evName, handlerSrc: handlerSrc.trim() });
          continue;
        }
      }
      // Attribute name
      let attrName = '';
      while (i < src.length && ATTR_NAME.test(src[i])) attrName += src[i++];
      if (!attrName) {
        this.syncTo(i);
        this.inTagHeader = false;
        this.err(`Invalid attribute in tag "<${name}"`, `unexpected character "${c}"`);
      }
      // Optional `=` value
      let k = i;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (src[k] === '=') {
        i = k + 1;
        while (src[i] === ' ' || src[i] === '\t') i++;
        const v = src[i];
        if (v === '{') {
          const raw = captureGroup();
          if (raw === null) {
            this.syncTo(i);
            this.inTagHeader = false;
            this.err('Unterminated attribute expression', `attribute "${attrName}" of tag "<${name}"`);
          }
          attrs.push({ name: attrName, value: raw.trim(), interpolated: true, expr: raw.trim(), boolean: false });
        } else if (v === '"' || v === "'") {
          const rawFull = readQuoted();
          if (rawFull === null || !rawFull.endsWith(v)) {
            this.syncTo(i);
            this.inTagHeader = false;
            this.err('Unterminated attribute value', `attribute "${attrName}" of tag "<${name}"`);
          }
          const raw = rawFull.slice(1, -1);
          const m = /^\{\s*([\s\S]*?)\s*\}$/.exec(raw);
          if (m) {
            attrs.push({ name: attrName, value: m[1], interpolated: true, expr: m[1], boolean: false });
          } else {
            attrs.push({ name: attrName, value: unescapeAttr(raw), interpolated: false, boolean: false });
          }
        } else {
          // Unquoted static value (stop at whitespace or `>` or `/>`)
          let val = '';
          while (i < src.length && src[i] !== ' ' && src[i] !== '>' && src[i] !== '\n' && src[i] !== '\t' && src[i] !== '\r') {
            if (src[i] === '/' && src[i + 1] === '>') break;
            val += src[i++];
          }
          attrs.push({ name: attrName, value: val, interpolated: false, boolean: false });
        }
      } else {
        // Boolean attribute like `disabled` or `checked`.
        attrs.push({ name: attrName, value: '', interpolated: false, boolean: true });
      }
    }

    this.syncTo(i);
    this.inTagHeader = false;
    const tag: TagInfo = { name, closing, selfClosing, attrs };
    this.tokens.push({ type: 'TAG', value: src.slice(start.offset, this.pos), tag, pos: start, end: this.position() });
    this.prevExprEnd = !closing && !selfClosing ? false : true;
    // Markup context tracking: opening non-void tags put the lexer into markup
    // until their closing tag arrives. Void elements (`<input ...>` without
    // `/>`) close implicitly and must not push a frame. The `<on ...>` wrapper
    // is LUMA syntax, not an HTML element: it always closes with `</on>`, even
    // when written self-closing-style, so it pushes its frame unconditionally.
    const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    if (!closing && !selfClosing && (name === 'on' || !VOID.has(name.toLowerCase()))) {
      this.markupDepth++;
      this.push('markup', 'code'); // implicit element-markup frame
    } else if (closing) {
      if (this.markupDepth > 0) {
        for (let kk = this.braceStack.length - 1; kk >= 0; kk--) {
          if (this.braceStack[kk].ctx === 'markup') {
            this.braceStack.splice(kk, 1);
            break;
          }
        }
        this.markupDepth--;
      }
    }
  }

  /** Advance line/column state until `this.pos` reaches absolute offset `i`. */
  private syncTo(i: number) {
    while (this.pos < i && this.pos < this.source.length) this.advance();
  }

  /** Shared markup-frame bookkeeping for a completed tag token. */
  private finishTagMarkup(tag: TagInfo, start: SourcePosition): void {
    const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    const name = tag.name;
    if (!tag.closing && !tag.selfClosing && (name === 'on' || !VOID.has(name.toLowerCase()))) {
      this.markupDepth++;
      this.push('markup', 'code'); // implicit element-markup frame
    } else if (tag.closing) {
      if (this.markupDepth > 0) {
        for (let kk = this.braceStack.length - 1; kk >= 0; kk--) {
          if (this.braceStack[kk].ctx === 'markup') {
            this.braceStack.splice(kk, 1);
            break;
          }
        }
        this.markupDepth--;
      }
    }
  }

  /**
   * Continue raw capture of an `<input on keyup { handler } ...>`-style tag
   * whose inline-event group spans arbitrary source (including braces inside
   * strings and newlines). We walk the source from the saved position,
   * skipping quoted strings and balanced `{...}` groups, until the real
   * depth-0 tag terminator (`>` or `/>`). The captured text is then parsed
   * with the same attribute grammar as scanTag, and the resulting TAG token
   * is emitted. This guarantees handler bodies can never be truncated by the
   * one-line header heuristic.
   */
  private continueOnRawScan() {
    const st = this.onRawScan!;
    const src = this.source;
    let i = this.pos;
    let depth = 0;
    let end = -1;
    let selfClosing = false;
    while (i < src.length) {
      const v = src[i];
      if (v === '"' || v === "'") {
        const q = v;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (v === '{') { depth++; i++; continue; }
      if (v === '}') { depth--; i++; continue; }
      if (depth === 0 && v === '/' && src[i + 1] === '>') { end = i + 2; selfClosing = true; break; }
      if (depth === 0 && v === '>') { end = i + 1; break; }
      i++;
    }
    if (end < 0) {
      this.onRawScan = null;
      this.err('Unterminated tag', `tag "<${st.name}" was never closed with ">"`);
    }
    const headerText = src.slice(this.pos, end - (selfClosing ? 2 : 1));
    this.syncTo(end);
    this.onRawScan = null;
    // Re-scan the collected header text with the standard attribute scanner.
    // It contains complete balanced groups now, so captureGroup succeeds.
    // The inner lexer starts in code context (markupDepth 0), so its scanTag
    // runs the inline attribute grammar — including `on <event> { ... }` —
    // and never recurses into raw capture (the wrapper's own name is already
    // stripped from headerText).
    let attrs: TagAttr[];
    try {
      attrs = this.scanAttrsFromText(headerText, st.name);
    } catch (e) {
      if (e instanceof Bail) throw e;
      this.err(`Invalid attribute in tag "<${st.name}"`, 'inline event group could not be parsed');
    }
    const tag: TagInfo = { name: st.name, closing: false, selfClosing, attrs };
    this.tokens.push({ type: 'TAG', value: src.slice(st.start.offset, this.pos), tag, pos: st.start, end: this.position() });
    this.prevExprEnd = selfClosing;
    this.finishTagMarkup(tag, st.start);
  }

  /** Parse attribute text collected verbatim by continueOnRawScan. Throws a
   *  lexer diagnostic error if malformed (same messages as scanTag). */
  private scanAttrsFromText(text: string, tagName: string): TagAttr[] {
    const savedSource = this.source;
    const savedPos = this.pos;
    const savedLine = this.line;
    const savedCol = this.col;
    const savedTokens = this.tokens;
    try {
      // Temporarily lex against the extracted header using a nested Lexer so
      // we reuse scanTag's exact grammar without disturbing outer state.
      const inner = new Lexer(`<${tagName} ${text}>`);
      const res = inner.run();
      const tok = res.find((t) => t.type === 'TAG');
      if (!tok || !tok.tag) this.err(`Invalid attribute in tag "<${tagName}"`, 'inline event group could not be parsed');
      return tok.tag.attrs;
    } finally {
      this.source = savedSource;
      this.pos = savedPos;
      this.line = savedLine;
      this.col = savedCol;
      this.tokens = savedTokens;
    }
  }

}

function unescapeAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
