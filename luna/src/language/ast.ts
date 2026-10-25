// Abstract Syntax Tree for the Luna language.

import { SourcePosition } from './tokens';

export interface Node {
  kind: string;
  pos: SourcePosition;
}

// ---------------- Expressions ----------------

export interface StringLit extends Node {
  kind: 'StringLit';
  value: string;
}

export interface NumberLit extends Node {
  kind: 'NumberLit';
  value: number;
}

export interface BoolLit extends Node {
  kind: 'BoolLit';
  value: boolean;
}

export interface NullLit extends Node {
  kind: 'NullLit';
}

export interface Ident extends Node {
  kind: 'Ident';
  name: string;
}

/** A template literal `text ${expr} text`. */
export interface TemplateLit extends Node {
  kind: 'TemplateLit';
  parts: Expr[]; // alternating StringLit and interpolated expressions
}

export interface ArrayLit extends Node {
  kind: 'ArrayLit';
  elements: Expr[];
}

export interface ObjectLit extends Node {
  kind: 'ObjectLit';
  properties: { key: string; computed?: boolean; keyExpr?: Expr; value: Expr }[];
}

export interface UnaryExpr extends Node {
  kind: 'UnaryExpr';
  op: '-' | 'not';
  operand: Expr;
}

export interface BinaryExpr extends Node {
  kind: 'BinaryExpr';
  op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | 'and' | 'or';
  left: Expr;
  right: Expr;
}

export interface CallExpr extends Node {
  kind: 'CallExpr';
  callee: Expr;
  args: Expr[];
}

export interface MemberExpr extends Node {
  kind: 'MemberExpr';
  object: Expr;
  property: Expr;
  computed: boolean;
}

export interface IndexExpr extends Node {
  kind: 'IndexExpr';
  object: Expr;
  index: Expr;
}

/** A lambda: `{ params } => body` or a block-lambda `{ statements }`. */
export interface FnExpr extends Node {
  kind: 'FnExpr';
  params: FnParam[];
  body: BlockStmt | Expr;
}

export interface AssignExpr extends Node {
  kind: 'AssignExpr';
  target: Expr;
  value: Expr;
}

/** Ternary conditional: `cond ? a : b`. */
export interface TernaryExpr extends Node {
  kind: 'TernaryExpr';
  condition: Expr;
  thenExpr: Expr;
  elseExpr: Expr;
}

/** An expression that produces UI content (element or component call). */
export interface UICallExpr extends Node {
  kind: 'UICall';
  root: ContentNode;
}

export type Expr =
  | StringLit
  | NumberLit
  | BoolLit
  | NullLit
  | Ident
  | TemplateLit
  | ArrayLit
  | ObjectLit
  | UnaryExpr
  | BinaryExpr
  | CallExpr
  | MemberExpr
  | IndexExpr
  | AssignExpr
  | TernaryExpr
  | FnExpr
  | UICallExpr;

// ---------------- JSX-style content ----------------

/** `{for x in xs <li>{x}</li>}` — a reactive list rendered inline in markup. */
export interface ForDirective extends Node {
  kind: 'ForDirective';
  varName: string;
  iterable: Expr;
  body: ContentNode[];
}

/** `{if cond <b>yes</b>}` — conditional UI inline in markup (optional else). */
export interface IfDirective extends Node {
  kind: 'IfDirective';
  condition: Expr;
  then: ContentNode[];
  else?: ContentNode[];
}

export interface Interpolation extends Node {
  kind: 'Interpolation';
  expr: Expr;
}

export interface TextNode extends Node {
  kind: 'Text';
  value: string;
}

export interface ElementNode extends Node {
  kind: 'Element';
  tag: string;
  attributes: Attr[];
  children: ContentNode[];
  selfClosing: boolean;
}

export interface ComponentCallNode extends Node {
  kind: 'ComponentCall';
  name: string;
  attributes: Attr[];
  children: ContentNode[];
}

/** `<on event { handler } <element>>` — an element wrapped with an event binding. */
export interface OnWrapperNode extends Node {
  kind: 'OnWrapper';
  event: string;
  handler: Expr; // FnExpr produced from the `{ ... }` block
  child: ContentNode;
}

/** An attribute value is either a static string or an expression. */
export type Attr = { name: string; value: Expr | string; pos: SourcePosition };

export type ContentNode = ElementNode | ComponentCallNode | Interpolation | TextNode | ForDirective | IfDirective | OnWrapperNode;

// ---------------- Statements ----------------

export interface PageMeta {
  title?: string;
  description?: string;
  themeColor?: string;
}

export interface PageStmt extends Node {
  kind: 'PageStmt';
  meta: PageMeta;
}

export interface StyleStmt extends Node {
  kind: 'StyleStmt';
  css: string;
}

export interface LetStmt extends Node {
  kind: 'LetStmt';
  name: string;
  value: Expr;
}

export interface StateStmt extends Node {
  kind: 'StateStmt';
  name: string;
  value: Expr;
}

export interface FnParam {
  name: string;
  defaultExpr?: Expr;
}

export interface FnStmt extends Node {
  kind: 'FnStmt';
  name: string;
  params: FnParam[];
  body: BlockStmt;
}

export interface ReturnStmt extends Node {
  kind: 'ReturnStmt';
  argument?: Expr;
}

export interface IfStmt extends Node {
  kind: 'IfStmt';
  condition: Expr;
  then: BlockStmt;
  else?: IfStmt | BlockStmt;
}

export interface ForStmt extends Node {
  kind: 'ForStmt';
  header:
    | { form: 'each'; varName: string; indexName?: string; iterable: Expr }
    | { form: 'in'; varName: string; object: Expr }
    | { form: 'cstyle'; init?: Stmt; test?: Expr; update?: Expr };
  body: BlockStmt;
}

export interface WhileStmt extends Node {
  kind: 'WhileStmt';
  condition: Expr;
  body: BlockStmt;
}

export interface EventStmt extends Node {
  kind: 'EventStmt';
  event: string;
  handler: Expr; // function expression
  target: ContentNode | Expr; // rendered element (UI) or selector string
  targetIsSelector: boolean;
}

export interface RenderStmt extends Node {
  kind: 'RenderStmt';
  content: ContentNode;
}

export interface ExprStmt extends Node {
  kind: 'ExprStmt';
  expr: Expr;
}

export interface BlockStmt extends Node {
  kind: 'Block';
  statements: Stmt[];
}

export interface ComponentDef extends Node {
  kind: 'ComponentDef';
  name: string;
  props: FnParam[];
  body: Stmt[];
}

export type Stmt =
  | PageStmt
  | StyleStmt
  | LetStmt
  | StateStmt
  | FnStmt
  | ReturnStmt
  | IfStmt
  | ForStmt
  | WhileStmt
  | EventStmt
  | RenderStmt
  | ExprStmt
  | BlockStmt;

export interface Program extends Node {
  kind: 'Program';
  page: PageStmt | null;
  styles: string[];
  components: ComponentDef[];
  statements: Stmt[];
}
