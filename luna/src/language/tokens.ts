// Token definitions for the Luna language.

export type TokenType =
  // Literals & identifiers
  | 'IDENT'
  | 'KEYWORD'
  | 'NUMBER'
  | 'STRING'
  | 'TEMPLATE_OPEN' // ` ... ${   (value = text before first ${)
  | 'TEMPLATE_MID' // } ... ${    (value = text between interpolations)
  | 'TEMPLATE_CLOSE' // } ... `   (value = trailing text)
  | 'CSSBLOCK' // raw text of a {style ...} block
  // Punctuation
  | 'LBRACE'
  | 'RBRACE'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'COMMA'
  | 'DOT'
  | 'COLON'
  | 'SEMI'
  | 'QUESTION'
  | 'ARROW' // => (event-handler sugar: `on click => { ... }`)
  | 'TAG' // <name ...> or </name> or <name ... />
  | 'TEXT' // raw text run inside markup (prose, non-ASCII glyphs, punctuation)
  | 'DIRECTIVE' // `{for` / `{if` opening a UI directive block in markup
  | 'DIRECTIVE_END' // matching `}` closing a UI directive block
  // Operators
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'PERCENT'
  | 'ASSIGN' // =
  | 'EQ' // ==
  | 'NEQ' // !=
  | 'LT'
  | 'GT'
  | 'LE'
  | 'GE'
  // Keywords acting as operators: and / or / not are KEYWORD tokens.
  // Special
  | 'NEWLINE'
  | 'EOF'
  | 'ERROR';

export interface SourcePosition {
  line: number; // 1-based
  column: number; // 1-based
  offset: number; // 0-based character offset
}

export interface Token {
  type: TokenType;
  value: string;
  /** For KEYWORD tokens: the keyword itself. */
  keyword?: string;
  /** For TAG tokens: parsed tag information. */
  tag?: TagInfo;
  pos: SourcePosition;
  end: SourcePosition;
}

export interface TagAttr {
  name: string;
  /** Static value (already unescaped from source). */
  value: string;
  /** If the attribute was written with interpolation, e.g. href="{url}". */
  interpolated?: boolean;
  /** Raw expression source when `interpolated` is true. */
  expr?: string;
  /** True for valueless attributes like `disabled`. */
  boolean?: boolean;
}

export interface TagInfo {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: TagAttr[];
  /** true when this token came from the deprecated `expr => tag` sugar. */
  arrowSugar?: boolean;
}

export const KEYWORDS = new Set([
  'page',
  'render',
  'style',
  'component',
  'state',
  'let',
  'const',
  'fn',
  'return',
  'if',
  'else',
  'for',
  'each',
  'in',
  'of',
  'while',
  'on',
  'true',
  'false',
  'null',
  'undefined',
  'and',
  'or',
  'not',
  'with',
]);

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word);
}
