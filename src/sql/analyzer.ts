import { assertNever } from '../errors/assert.js';
import { LimitError, SemanticError, type SourcePosition } from '../errors/errors.js';
import type { ColumnSchema, TableSchema } from '../catalog/schema.js';
import { MAX_COLUMNS } from '../util/limits.js';
import type { Expr, Ident, Statement } from './ast.js';
import type { BExpr, BoundStatement, SchemaLookup, SqlType } from './bound.js';

const RESERVED_PREFIX = 'mdb_';

/**
 * Name resolution and type checking (F.4, F.7). Runs before any state change; the first violation in
 * source order is reported at the offending token.
 */
export function analyze(stmt: Statement, catalog: SchemaLookup, source: string): BoundStatement {
  return new Analyzer(catalog, source).statement(stmt);
}

class Analyzer {
  constructor(
    private readonly catalog: SchemaLookup,
    private readonly src: string,
  ) {}

  private semantic(code: ConstructorParameters<typeof SemanticError>[0], message: string, pos: SourcePosition): SemanticError {
    return new SemanticError(code, message, { position: pos, source: this.src });
  }

  private table(id: Ident): TableSchema {
    const t = this.catalog.getTable(id.name);
    if (!t) throw this.semantic('TABLE_NOT_FOUND', `no such table: ${id.name}`, id.pos);
    return t;
  }

  private column(t: TableSchema, id: Ident): number {
    const i = t.columns.findIndex((c) => c.name === id.name);
    if (i < 0) throw this.semantic('COLUMN_NOT_FOUND', `no such column: ${id.name} in table ${t.name}`, id.pos);
    return i;
  }

  private newObjectName(id: Ident): string {
    if (id.name.startsWith(RESERVED_PREFIX)) throw this.semantic('RESERVED_NAME', `names starting with '${RESERVED_PREFIX}' are reserved: ${id.name}`, id.pos);
    if (this.catalog.objectExists(id.name)) throw this.semantic('OBJECT_EXISTS', `a table or index named ${id.name} already exists`, id.pos);
    return id.name;
  }

  statement(s: Statement): BoundStatement {
    switch (s.kind) {
      case 'select': {
        const table = this.table(s.table);
        const columns = s.columns === null ? table.columns.map((_, i) => i) : s.columns.map((c) => this.column(table, c));
        const where = s.where ? this.condition(s.where, table) : null;
        const orderBy = s.orderBy.map((o) => ({ index: this.column(table, o.column), desc: o.desc }));
        return { kind: 'select', table, columns, where, orderBy, limit: s.limit?.value ?? null, offset: s.offset?.value ?? 0, pos: s.pos };
      }
      case 'explain': {
        const select = this.statement(s.select);
        if (select.kind !== 'select') return assertNever(select as never, 'explain target');
        return { kind: 'explain', select, pos: s.pos };
      }
      case 'insert': {
        const table = this.table(s.table);
        let targets: number[];
        if (s.columns === null) {
          targets = table.columns.map((_, i) => i);
        } else {
          targets = [];
          for (const c of s.columns) {
            const i = this.column(table, c);
            if (targets.includes(i)) throw this.semantic('DUPLICATE_COLUMN', `column ${c.name} is listed twice`, c.pos);
            targets.push(i);
          }
        }
        const rows = s.rows.map((row) => {
          if (row.values.length !== targets.length) {
            throw this.semantic('COLUMN_COUNT_MISMATCH', `${row.values.length} values for ${targets.length} columns`, row.pos);
          }
          const values = row.values.map((v, k) => {
            const b = this.expr(v, null);
            this.assignable(table.columns[targets[k] as number] as ColumnSchema, b, v);
            return b;
          });
          return { values, pos: row.pos };
        });
        return { kind: 'insert', table, targets, rows, pos: s.pos };
      }
      case 'update': {
        const table = this.table(s.table);
        const seen = new Set<number>();
        const assignments = s.assignments.map((a) => {
          const index = this.column(table, a.column);
          if (seen.has(index)) throw this.semantic('DUPLICATE_COLUMN', `column ${a.column.name} is assigned twice`, a.column.pos);
          seen.add(index);
          const value = this.expr(a.value, table);
          this.assignable(table.columns[index] as ColumnSchema, value, a.value);
          return { index, value };
        });
        const where = s.where ? this.condition(s.where, table) : null;
        return { kind: 'update', table, assignments, where, pos: s.pos };
      }
      case 'delete': {
        const table = this.table(s.table);
        return { kind: 'delete', table, where: s.where ? this.condition(s.where, table) : null, pos: s.pos };
      }
      case 'createTable': {
        const name = this.newObjectName(s.name);
        const columns: ColumnSchema[] = [];
        let pkSeen = false;
        s.columns.forEach((c, position) => {
          if (position === MAX_COLUMNS) {
            throw new LimitError('TOO_MANY_COLUMNS', `a table may have at most ${MAX_COLUMNS} columns`, { position: c.name.pos, source: this.src });
          }
          if (columns.some((x) => x.name === c.name.name)) throw this.semantic('DUPLICATE_COLUMN', `duplicate column ${c.name.name}`, c.name.pos);
          let notNull = false;
          let primaryKey = false;
          for (const k of c.constraints) {
            if (k.kind === 'notNull') {
              if (notNull) throw this.semantic('DUPLICATE_CONSTRAINT', `NOT NULL repeated on ${c.name.name}`, k.pos);
              notNull = true;
            } else {
              if (primaryKey) throw this.semantic('DUPLICATE_CONSTRAINT', `PRIMARY KEY repeated on ${c.name.name}`, k.pos);
              if (pkSeen) throw this.semantic('MULTIPLE_PRIMARY_KEYS', 'a table may have only one PRIMARY KEY column', k.pos);
              primaryKey = true;
              pkSeen = true;
            }
          }
          columns.push({ name: c.name.name, type: c.type, notNull: notNull || primaryKey, primaryKey, position });
        });
        return { kind: 'createTable', name, columns, pos: s.pos };
      }
      case 'dropTable':
        return { kind: 'dropTable', table: this.table(s.name), pos: s.pos };
      case 'createIndex': {
        const name = this.newObjectName(s.name);
        const table = this.table(s.table);
        return { kind: 'createIndex', name, table, column: this.column(table, s.column), unique: s.unique, pos: s.pos };
      }
      case 'dropIndex': {
        const index = this.catalog.getIndex(s.name.name);
        if (!index) throw this.semantic('INDEX_NOT_FOUND', `no such index: ${s.name.name}`, s.name.pos);
        if (index.auto) throw this.semantic('CANNOT_DROP_PK_INDEX', `${index.name} is the PRIMARY KEY index of ${index.table}`, s.name.pos);
        return { kind: 'dropIndex', index, pos: s.pos };
      }
      case 'begin':
      case 'commit':
      case 'rollback':
        return { kind: s.kind, pos: s.pos };
      default:
        return assertNever(s, 'statement');
    }
  }

  private assignable(col: ColumnSchema, b: BExpr, e: Expr): void {
    if (b.type !== 'NULL' && b.type !== col.type) {
      throw this.semantic('TYPE_MISMATCH', `cannot assign ${b.type} to column ${col.name} of type ${col.type}`, e.pos);
    }
  }

  private condition(e: Expr, t: TableSchema): BExpr {
    const b = this.expr(e, t);
    if (b.type !== 'BOOLEAN' && b.type !== 'NULL') throw this.semantic('TYPE_MISMATCH', `WHERE condition must be BOOLEAN, not ${b.type}`, e.pos);
    return b;
  }

  /** `table` null = constant context (INSERT VALUES): column references are NOT_CONSTANT. */
  expr(e: Expr, table: TableSchema | null): BExpr {
    const mismatch = (what: string): SemanticError => this.semantic('TYPE_MISMATCH', what, e.pos);
    const isOneOf = (t: SqlType, ...ok: SqlType[]): boolean => t === 'NULL' || ok.includes(t);
    switch (e.kind) {
      case 'int':
        return { kind: 'const', value: e.value, type: 'INTEGER', pos: e.pos };
      case 'str':
        return { kind: 'const', value: e.value, type: 'TEXT', pos: e.pos };
      case 'bool':
        return { kind: 'const', value: e.value, type: 'BOOLEAN', pos: e.pos };
      case 'null':
        return { kind: 'const', value: null, type: 'NULL', pos: e.pos };
      case 'column': {
        if (table === null) throw this.semantic('NOT_CONSTANT', `column reference ${e.name} is not allowed in VALUES`, e.pos);
        const index = this.column(table, { name: e.name, pos: e.pos });
        return { kind: 'col', index, name: e.name, type: (table.columns[index] as ColumnSchema).type, pos: e.pos };
      }
      case 'neg': {
        const operand = this.expr(e.operand, table);
        if (!isOneOf(operand.type, 'INTEGER')) throw mismatch(`unary - needs INTEGER, not ${operand.type}`);
        return { kind: 'neg', operand, type: 'INTEGER', pos: e.pos };
      }
      case 'not': {
        const operand = this.expr(e.operand, table);
        if (!isOneOf(operand.type, 'BOOLEAN')) throw mismatch(`NOT needs BOOLEAN, not ${operand.type}`);
        return { kind: 'not', operand, type: 'BOOLEAN', pos: e.pos };
      }
      case 'isnull':
        return { kind: 'isnull', operand: this.expr(e.operand, table), negated: e.negated, type: 'BOOLEAN', pos: e.pos };
      case 'binary': {
        const left = this.expr(e.left, table);
        const right = this.expr(e.right, table);
        switch (e.op) {
          case '+':
          case '-':
          case '*':
            if (!isOneOf(left.type, 'INTEGER') || !isOneOf(right.type, 'INTEGER')) throw mismatch(`${e.op} needs INTEGER operands, not ${left.type} and ${right.type}`);
            return { kind: 'arith', op: e.op, left, right, type: 'INTEGER', pos: e.pos };
          case 'AND':
          case 'OR':
            if (!isOneOf(left.type, 'BOOLEAN') || !isOneOf(right.type, 'BOOLEAN')) throw mismatch(`${e.op} needs BOOLEAN operands, not ${left.type} and ${right.type}`);
            return { kind: 'logic', op: e.op, left, right, type: 'BOOLEAN', pos: e.pos };
          default:
            if (left.type !== 'NULL' && right.type !== 'NULL' && left.type !== right.type) throw mismatch(`cannot compare ${left.type} with ${right.type}`);
            return { kind: 'cmp', op: e.op, left, right, type: 'BOOLEAN', pos: e.pos };
        }
      }
      default:
        return assertNever(e, 'expression');
    }
  }
}
