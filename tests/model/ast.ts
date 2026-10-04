/**
 * Test-owned statement AST for model-based testing (J.3). Independent of src/sql: the generator builds these,
 * render.ts turns them into SQL for the database, ref-model.ts interprets them directly.
 */
export type MType = 'INTEGER' | 'TEXT' | 'BOOLEAN';
export type MVal = number | string | boolean | null;

export type MExpr =
  | { k: 'lit'; v: MVal }
  | { k: 'col'; name: string }
  | { k: 'neg'; e: MExpr }
  | { k: 'not'; e: MExpr }
  | { k: 'arith'; op: '+' | '-' | '*'; l: MExpr; r: MExpr }
  | { k: 'cmp'; op: '=' | '<>' | '<' | '<=' | '>' | '>='; l: MExpr; r: MExpr }
  | { k: 'logic'; op: 'AND' | 'OR'; l: MExpr; r: MExpr }
  | { k: 'isnull'; e: MExpr; negated: boolean };

export interface MColumn {
  name: string;
  type: MType;
  notNull: boolean;
  pk: boolean;
}

export type MStmt =
  | { k: 'create'; table: string; cols: MColumn[] }
  | { k: 'drop'; table: string }
  | { k: 'createIndex'; name: string; table: string; col: string; unique: boolean }
  | { k: 'dropIndex'; name: string }
  | { k: 'insert'; table: string; cols: string[] | null; rows: MExpr[][] }
  | { k: 'update'; table: string; sets: Array<{ col: string; e: MExpr }>; where: MExpr | null }
  | { k: 'delete'; table: string; where: MExpr | null }
  | {
      k: 'select';
      table: string;
      cols: string[] | null;
      where: MExpr | null;
      order: Array<{ col: string; desc: boolean }>;
      limit: number | null;
      offset: number | null;
    }
  | { k: 'begin' }
  | { k: 'commit' }
  | { k: 'rollback' };
