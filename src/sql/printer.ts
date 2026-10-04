import { assertNever } from '../errors/assert.js';
import type { Expr, Statement } from './ast.js';

/**
 * Canonical printing (F.10): binary `(l op r)`, `(NOT e)`, `(-e)`, `(e IS [NOT] NULL)`, integers in decimal,
 * strings single-quoted with '' escaping, TRUE/FALSE/NULL, normalized column names.
 * printStatement output re-parses to the same AST (T-PAR-006).
 */
export function printExpr(e: Expr): string {
  switch (e.kind) {
    case 'int':
      return String(e.value);
    case 'str':
      return `'${e.value.replace(/'/g, "''")}'`;
    case 'bool':
      return e.value ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'column':
      return e.name;
    case 'neg':
      return `(-${printExpr(e.operand)})`;
    case 'not':
      return `(NOT ${printExpr(e.operand)})`;
    case 'binary':
      return `(${printExpr(e.left)} ${e.op} ${printExpr(e.right)})`;
    case 'isnull':
      return `(${printExpr(e.operand)} IS ${e.negated ? 'NOT ' : ''}NULL)`;
    default:
      return assertNever(e, 'expression');
  }
}

export function printStatement(s: Statement): string {
  switch (s.kind) {
    case 'select': {
      let out = `SELECT ${s.columns === null ? '*' : s.columns.map((c) => c.name).join(', ')} FROM ${s.table.name}`;
      if (s.where) out += ` WHERE ${printExpr(s.where)}`;
      if (s.orderBy.length > 0) out += ` ORDER BY ${s.orderBy.map((o) => `${o.column.name} ${o.desc ? 'DESC' : 'ASC'}`).join(', ')}`;
      if (s.limit) out += ` LIMIT ${s.limit.value}`;
      if (s.offset) out += ` OFFSET ${s.offset.value}`;
      return out;
    }
    case 'explain':
      return `EXPLAIN ${printStatement(s.select)}`;
    case 'insert': {
      const cols = s.columns === null ? '' : ` (${s.columns.map((c) => c.name).join(', ')})`;
      const rows = s.rows.map((r) => `(${r.values.map(printExpr).join(', ')})`).join(', ');
      return `INSERT INTO ${s.table.name}${cols} VALUES ${rows}`;
    }
    case 'update': {
      let out = `UPDATE ${s.table.name} SET ${s.assignments.map((a) => `${a.column.name} = ${printExpr(a.value)}`).join(', ')}`;
      if (s.where) out += ` WHERE ${printExpr(s.where)}`;
      return out;
    }
    case 'delete':
      return `DELETE FROM ${s.table.name}${s.where ? ` WHERE ${printExpr(s.where)}` : ''}`;
    case 'createTable': {
      const cols = s.columns.map((c) => {
        const cons = c.constraints.map((k) => (k.kind === 'notNull' ? ' NOT NULL' : ' PRIMARY KEY')).join('');
        return `${c.name.name} ${c.type}${cons}`;
      });
      return `CREATE TABLE ${s.name.name} (${cols.join(', ')})`;
    }
    case 'dropTable':
      return `DROP TABLE ${s.name.name}`;
    case 'createIndex':
      return `CREATE ${s.unique ? 'UNIQUE ' : ''}INDEX ${s.name.name} ON ${s.table.name} (${s.column.name})`;
    case 'dropIndex':
      return `DROP INDEX ${s.name.name}`;
    case 'begin':
      return 'BEGIN';
    case 'commit':
      return 'COMMIT';
    case 'rollback':
      return 'ROLLBACK';
    default:
      return assertNever(s, 'statement');
  }
}
