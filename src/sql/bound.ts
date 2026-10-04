import type { SourcePosition } from '../errors/errors.js';
import type { ColumnSchema, IndexSchema, TableSchema } from '../catalog/schema.js';
import type { Value } from '../record/value.js';

/** Static types (F.4). NULL is the type of the NULL literal and of operations on it only. */
export type SqlType = 'INTEGER' | 'TEXT' | 'BOOLEAN' | 'NULL';

export type CmpOp = '=' | '<>' | '<' | '<=' | '>' | '>=';
export type ArithOp = '+' | '-' | '*';

/** Bound expressions: names resolved to column indexes, every node typed, positions kept (H.4). */
export type BExpr =
  | { kind: 'const'; value: Value; type: SqlType; pos: SourcePosition }
  | { kind: 'col'; index: number; name: string; type: SqlType; pos: SourcePosition }
  | { kind: 'neg'; operand: BExpr; type: SqlType; pos: SourcePosition }
  | { kind: 'not'; operand: BExpr; type: SqlType; pos: SourcePosition }
  | { kind: 'arith'; op: ArithOp; left: BExpr; right: BExpr; type: SqlType; pos: SourcePosition }
  | { kind: 'cmp'; op: CmpOp; left: BExpr; right: BExpr; type: SqlType; pos: SourcePosition }
  | { kind: 'logic'; op: 'AND' | 'OR'; left: BExpr; right: BExpr; type: SqlType; pos: SourcePosition }
  | { kind: 'isnull'; operand: BExpr; negated: boolean; type: SqlType; pos: SourcePosition };

export interface BoundSelect {
  kind: 'select';
  table: TableSchema;
  /** Projected column indexes (`*` expanded in table order). */
  columns: number[];
  where: BExpr | null;
  orderBy: Array<{ index: number; desc: boolean }>;
  limit: number | null;
  offset: number;
  pos: SourcePosition;
}

export interface BoundExplain {
  kind: 'explain';
  select: BoundSelect;
  pos: SourcePosition;
}

export interface BoundInsert {
  kind: 'insert';
  table: TableSchema;
  /** Target column index for each VALUES position. */
  targets: number[];
  rows: Array<{ values: BExpr[]; pos: SourcePosition }>;
  pos: SourcePosition;
}

export interface BoundUpdate {
  kind: 'update';
  table: TableSchema;
  assignments: Array<{ index: number; value: BExpr }>;
  where: BExpr | null;
  pos: SourcePosition;
}

export interface BoundDelete {
  kind: 'delete';
  table: TableSchema;
  where: BExpr | null;
  pos: SourcePosition;
}

export interface BoundCreateTable {
  kind: 'createTable';
  name: string;
  columns: ColumnSchema[];
  pos: SourcePosition;
}

export interface BoundDropTable {
  kind: 'dropTable';
  table: TableSchema;
  pos: SourcePosition;
}

export interface BoundCreateIndex {
  kind: 'createIndex';
  name: string;
  table: TableSchema;
  column: number;
  unique: boolean;
  pos: SourcePosition;
}

export interface BoundDropIndex {
  kind: 'dropIndex';
  index: IndexSchema;
  pos: SourcePosition;
}

export interface BoundTxn {
  kind: 'begin' | 'commit' | 'rollback';
  pos: SourcePosition;
}

export type BoundStatement =
  | BoundSelect
  | BoundExplain
  | BoundInsert
  | BoundUpdate
  | BoundDelete
  | BoundCreateTable
  | BoundDropTable
  | BoundCreateIndex
  | BoundDropIndex
  | BoundTxn;

/** The catalog view the analyzer needs (import type only: sql must not depend on catalog at runtime). */
export interface SchemaLookup {
  getTable(name: string): TableSchema | undefined;
  getIndex(name: string): IndexSchema | undefined;
  objectExists(name: string): boolean;
}
