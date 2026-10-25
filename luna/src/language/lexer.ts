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

type Ctx = 'code' | 'markup' | 'attr' | 'template';

class Lexer {
  source: string;
  pos = 0;
  line = 1;
  col = 1;
  tokens: Token[] = [];
  diagnostics: Diagnostic[] = [];
  /** Tracks whether the previous significant token can end an expression. */
  private prevExprEnd = false;
  /** Stack of brace-driven contexts (code blocks, interpolations, templates, directives). */
  private braceStack: Ctx[] = [];
  /** Number of open elements whose children are markup. */
  private markupDepth = 0;
  /** When > 0, the next `{` opens a directive BODY (markup) instead of code. */
  private directiveBodyPending = 0;
  /** When > 0, the next `{` opens a `render { ... }` UI block (markup). */
  private renderBodyPending = 0;

  constructor(source: string) {
    this.source = source;
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

  /** True when the current position sits inside element/directive markup. */
  private inMarkup(): boolean {
    return this.markupDepth > 0 && this.braceStack.length === 0;
  }

  private scanToken() {
    const start = this.position();
    const c = this.ch();

    if (c === '\n') {
      this.advance();
      this.tokens.push({ type: 'NEWLINE', value: '\n', pos: start, end: this.position() });
      return;
    }

    // ---- markup context: prose becomes whole TEXT runs ----
    if (this.inMarkup()) {
      if (c !== '<' && c !== '{' && c !== '`') {
        this.scanTextRun(start);
        return;
      }
    }

    // Identifiers / keywords
    if (ID_START.test(c)) {
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
    // the LBRACE case via renderBodyPending).
    if (c === 'r' && this.source.startsWith('render', this.pos)) {
      let j = this.pos + 'render'.length;
      while (this.source[j] === ' ' || this.source[j] === '\t') j++;
      if (this.source[j] === '{') {
        for (let k = 0; k < 'render'.length; k++) this.advance();
        this.renderBodyPending++;
        this.make('KEYWORD', 'render', start, { keyword: 'render' });
        return;
      }
    }

    // UI directives inside markup: `{for ... }`, `{if ... }`.
    if (c === '{' && this.inMarkup()) {
      const kw = this.lookaheadDirective();
      if (kw) {
        this.advance(); // {
        while (this.ch() === ' ' || this.ch() === '\t') this.advance();
        for (let k = 0; k < kw.length; k++) this.advance();
        // The directive header (`x in items` / `cond`) is code; its body is
        // markup. Push a 'code' frame for the header, and remember that the
        // next `{` opens the directive body (markup context).
        this.braceStack.push('code');
        this.directiveBodyPending++;
        this.make('DIRECTIVE', kw, start);
        return;
      }
    }

    switch (c) {
      case '{': {
        this.advance();
        if (this.renderBodyPending > 0) {
          // `render { ... }` — the block is a markup region until its `}`.
          this.renderBodyPending--;
          this.braceStack.push('markup');
          this.markupDepth++;
          this.make('LBRACE', '{', start);
          return;
        }
        if (this.directiveBodyPending > 0) {
          // This `{` opens a directive body: switch back to markup context.
          this.directiveBodyPending--;
          const top = this.braceStack[this.braceStack.length - 1];
          if (top === 'code') this.braceStack.pop();
          this.braceStack.push('markup');
          this.markupDepth++;
          this.make('LBRACE', '{', start);
          return;
        }
        // Nested braces are ordinary code braces; they never shadow the
        // surrounding markup/template boundary frames on the stack.
        this.braceStack.push('code');
        this.make('LBRACE', '{', start);
        return;
      }
      case '}': {
        this.advance();
        // Pop any nested 'code' frames until we reach a boundary context.
        while (this.braceStack.length > 0 && this.braceStack[this.braceStack.length - 1] === 'code') {
          this.braceStack.pop();
        }
        const top = this.braceStack[this.braceStack.length - 1];
        if (top === 'template') {
          this.braceStack.pop();
          // Continue scanning the rest of the template literal.
          this.scanTemplateContinue(start);
          return;
        }
        if (top === 'markup') {
          // Close of a `{for ...}` / `{if ...}` directive block.
          this.braceStack.pop();
          this.markupDepth--;
          this.make('DIRECTIVE_END', '}', start);
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
      if (s === '<' || s === '{' || s === '`') break;
      i++;
    }
    const value = this.source.slice(this.pos, i);
    while (this.pos < i) this.advance();
    this.make('TEXT', value, start);
  }

  private isTagStart(c: '<' | '>'): boolean {
    if (c === '>') return false; // '>' only opens a tag via scanTag internals (never here)
    const next = this.ch(1);
    if (next === '/') return TAG_NAME.test(this.ch(2));
    if (!TAG_NAME.test(next)) return false;
    // `<on event { handler } <button>` wraps an element: its closing `>`
    // arrives after a `}`, so bypass the comparison heuristic for it.
    if (this.source.startsWith('on', this.pos + 1) && !/[A-Za-z0-9_-]/.test(this.ch(3))) {
      for (let i = this.pos + 1; i < this.source.length; i++) {
        const s = this.source[i];
        if (s === '\n') return false;
        if (s === '>') return true;
      }
      return false;
    }
    if (this.prevExprEnd) return false; // `a < b` is a comparison
    // A tag must be terminated by `>` on the same line, otherwise treat the
    // `<` as a comparison operator and let the parser report a useful error.
    for (let i = this.pos + 1; i < this.source.length; i++) {
      const s = this.source[i];
      if (s === '\n') return false;
      if (s === '>') return true;
      if (s === '/' && this.source[i + 1] === '>') return true;
    }
    return false;
  }

  /**
   * If we are at `{` followed by a UI directive keyword (`for` or `if`), and
   * the brace group is balanced before EOF, return the keyword. Object
   * literals such as `{ for: 1 }` (colon before any brace close) are rejected.
   */
  private lookaheadDirective(): 'for' | 'if' | null {
    const m = /^\{\s*(for|if)(?![A-Za-z0-9_$])/.exec(this.source.slice(this.pos));
    if (!m) return null;
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
    // At '<'. Parse: <name attr="v" ...>, </name>, <name ... />
    this.advance(); // <
    let closing = false;
    if (this.ch() === '/') {
      this.advance();
      closing = true;
    }
    let name = '';
    while (this.pos < this.source.length && /[a-zA-Z0-9-]/.test(this.ch())) name += this.advance();
    if (!name) this.err('Malformed tag', 'expected a tag name after "<"');

    const attrs: TagAttr[] = [];
    let selfClosing = false;

    // The `on` tag wraps an element: `<on click { handler } <button>`.
    // Its header ends at the `>` that follows the handler's closing `}`.
    const isOn = name === 'on';
    let onBraceDepth = 0;
    let onSeenBrace = false;

    while (true) {
      if (this.pos >= this.source.length) {
        this.err('Unterminated tag', `tag "<${name}" was never closed with ">"`);
      }
      const c = this.ch();
      if (isOn && (c === '{' || c === '}')) {
        // Raw-capture braces inside the `<on>` header; do not touch the
        // global brace stack (the parser sub-tokenizes the expr later).
        if (c === '{') {
          onBraceDepth++;
          onSeenBrace = true;
        } else onBraceDepth--;
        this.advance();
        continue;
      }
      if (isOn && c === '>' && !(onSeenBrace && onBraceDepth > 0)) {
        this.advance();
        break;
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        this.advance();
        continue;
      }
      if (c === '\n') {
        this.err('Unterminated tag', `tags must be closed on one line ("<${name}")`);
      }
      if (c === '/' && this.ch(1) === '>') {
        this.advance();
        this.advance();
        selfClosing = true;
        break;
      }
      if (c === '>' && !isOn) {
        this.advance();
        break;
      }
      // Attribute name
      let attrName = '';
      while (this.pos < this.source.length && ATTR_NAME.test(this.ch())) attrName += this.advance();
      if (!attrName) {
        this.err(`Invalid attribute in tag "<${name}">`, `unexpected character "${c}"`);
      }
      // Optional "=" value
      let value = '';
      let interpolated = false;
      let exprSrc: string | undefined;
      let isBoolean = false;
      // skip spaces around =
      let j = this.pos;
      while (this.source[j] === ' ' || this.source[j] === '\t') j++;
      if (this.source[j] === '=') {
        while (this.pos < j) this.advance();
        this.advance(); // =
        while (this.ch() === ' ' || this.ch() === '\t') this.advance();
        const q = this.ch();
        if (q === '{') {
          // Unquoted interpolation: class={done ? "done" : ""}
          let raw = '';
          let d = 0;
          while (true) {
            if (this.pos >= this.source.length || this.ch() === '\n') {
              this.err('Unterminated attribute expression', `attribute "${attrName}" of tag "<${name}">`);
            }
            const v = this.ch();
            if (v === '{') d++;
            if (v === '}') {
              d--;
              if (d === 0) {
                this.advance();
                break;
              }
            }
            raw += this.advance();
          }
          interpolated = true;
          value = raw.trim();
          exprSrc = raw.trim();
        } else if (q === '"' || q === "'") {
          this.advance();
          let raw = '';
          while (true) {
            if (this.pos >= this.source.length || this.ch() === '\n') {
              this.err('Unterminated attribute value', `attribute "${attrName}" of tag "<${name}">`);
            }
            const v = this.advance();
            if (v === q) break;
            raw += v;
          }
          // Detect full interpolation: href="{expr}"
          const m = /^\{\s*([\s\S]*?)\s*\}$/.exec(raw);
          if (m) {
            interpolated = true;
            value = m[1];
            exprSrc = m[1];
          } else {
            value = unescapeAttr(raw);
          }
        } else {
          // Unquoted static value (stop at space or >)
          while (this.pos < this.source.length && this.ch() !== ' ' && this.ch() !== '>' && this.ch() !== '\n' && this.ch() !== '\t') {
            value += this.advance();
          }
        }
      } else if (!closing) {
        // Boolean attribute like `disabled` or `checked`.
        value = '';
        isBoolean = true;
      }
      attrs.push({ name: attrName, value, interpolated, expr: exprSrc, boolean: isBoolean });
    }

    const tag: TagInfo = { name, closing, selfClosing, attrs };
    this.tokens.push({ type: 'TAG', value: this.source.slice(start.offset, this.pos), tag, pos: start, end: this.position() });
    this.prevExprEnd = !closing && !selfClosing ? false : true;
    // Markup context tracking: opening non-void tags put the lexer into markup
    // until their closing tag arrives. The parser mirrors this symmetrically.
    if (!closing && !selfClosing) {
      this.markupDepth++;
      this.braceStack.push('markup');
    } else if (closing) {
      if (this.markupDepth > 0 && this.braceStack[this.braceStack.length - 1] === 'markup') {
        this.markupDepth--;
        this.braceStack.pop();
      }
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
