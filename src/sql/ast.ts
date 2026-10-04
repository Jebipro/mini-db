import type { SourcePosition } from '../errors/errors.js';
import type { ColumnType } from '../record/value.js';

/** Every node carries the source position of its first token (operators: the operator token) — H.4. */

export interface Ident {
  name: string;
  pos: SourcePosition;
}

export type BinaryOp = '+' | '-' | '*' | '=' | '<>' | '<' | '<=' | '>' | '>=' | 'AND' | 'OR';
export const COMPARISON_OPS: readonly BinaryOp[] = ['=', '<>', '<', '<=', '>', '>='];
export const ARITHMETIC_OPS: readonly BinaryOp[] = ['+', '-', '*'];

export type Expr =
  | { kind: 'int'; value: number; pos: SourcePosition }
  | { kind: 'str'; value: string; pos: SourcePosition }
  | { kind: 'bool'; value: boolean; pos: SourcePosition }
  | { kind: 'null'; pos: SourcePosition }
  | { kind: 'column'; name: string; pos: SourcePosition }
  | { kind: 'neg'; operand: Expr; pos: SourcePosition }
  | { kind: 'not'; operand: Expr; pos: SourcePosition }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; pos: SourcePosition }
  | { kind: 'isnull'; operand: Expr; negated: boolean; pos: SourcePosition };

export interface OrderItem {
  column: Ident;
  desc: boolean;
}

export interface IntLiteral {
  value: number;
  pos: SourcePosition;
}

export interface SelectStmt {
  kind: 'select';
  /** null = `*` */
  columns: Ident[] | null;
  table: Ident;
  where: Expr | null;
  orderBy: OrderItem[];
  limit: IntLiteral | null;
  offset: IntLiteral | null;
  pos: SourcePosition;
}

export interface ExplainStmt {
  kind: 'explain';
  select: SelectStmt;
  pos: SourcePosition;
}

export interface ValueRow {
  values: Expr[];
  pos: SourcePosition;
}

export interface InsertStmt {
  kind: 'insert';
  table: Ident;
  columns: Ident[] | null;
  rows: ValueRow[];
  pos: SourcePosition;
}

export interface Assignment {
  column: Ident;
  value: Expr;
}

export interface UpdateStmt {
  kind: 'update';
  table: Ident;
  assignments: Assignment[];
  where: Expr | null;
  pos: SourcePosition;
}

export interface DeleteStmt {
  kind: 'delete';
  table: Ident;
  where: Expr | null;
  pos: SourcePosition;
}

export interface ColumnConstraint {
  kind: 'notNull' | 'primaryKey';
  pos: SourcePosition;
}

export interface ColumnDef {
  name: Ident;
  type: ColumnType;
  constraints: ColumnConstraint[];
}

export interface CreateTableStmt {
  kind: 'createTable';
  name: Ident;
  columns: ColumnDef[];
  pos: SourcePosition;
}

export interface DropTableStmt {
  kind: 'dropTable';
  name: Ident;
  pos: SourcePosition;
}

export interface CreateIndexStmt {
  kind: 'createIndex';
  unique: boolean;
  name: Ident;
  table: Ident;
  column: Ident;
  pos: SourcePosition;
}

export interface DropIndexStmt {
  kind: 'dropIndex';
  name: Ident;
  pos: SourcePosition;
}

export interface TxnStmt {
  kind: 'begin' | 'commit' | 'rollback';
  pos: SourcePosition;
}

export type Statement =
  | SelectStmt
  | ExplainStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | DropTableStmt
  | CreateIndexStmt
  | DropIndexStmt
  | TxnStmt;
