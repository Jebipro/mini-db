import type { MExpr, MStmt, MVal } from './ast.js';

/** SQL text for a model statement (fully parenthesized expressions). */
export function renderVal(v: MVal): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return v < 0 ? `(- ${-v})` : String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

export function renderExpr(e: MExpr): string {
  switch (e.k) {
    case 'lit':
      return renderVal(e.v);
    case 'col':
      return e.name;
    case 'neg':
      return `(- ${renderExpr(e.e)})`;
    case 'not':
      return `(NOT ${renderExpr(e.e)})`;
    case 'arith':
    case 'cmp':
    case 'logic':
      return `(${renderExpr(e.l)} ${e.op} ${renderExpr(e.r)})`;
    case 'isnull':
      return `(${renderExpr(e.e)} IS ${e.negated ? 'NOT ' : ''}NULL)`;
  }
}

export function renderStmt(s: MStmt): string {
  switch (s.k) {
    case 'create':
      return `CREATE TABLE ${s.table} (${s.cols
        .map((c) => `${c.name} ${c.type}${c.pk ? ' PRIMARY KEY' : c.notNull ? ' NOT NULL' : ''}`)
        .join(', ')})`;
    case 'drop':
      return `DROP TABLE ${s.table}`;
    case 'createIndex':
      return `CREATE ${s.unique ? 'UNIQUE ' : ''}INDEX ${s.name} ON ${s.table} (${s.col})`;
    case 'dropIndex':
      return `DROP INDEX ${s.name}`;
    case 'insert':
      return `INSERT INTO ${s.table}${s.cols ? ` (${s.cols.join(', ')})` : ''} VALUES ${s.rows
        .map((r) => `(${r.map(renderExpr).join(', ')})`)
        .join(', ')}`;
    case 'update':
      return `UPDATE ${s.table} SET ${s.sets.map((a) => `${a.col} = ${renderExpr(a.e)}`).join(', ')}${s.where ? ` WHERE ${renderExpr(s.where)}` : ''}`;
    case 'delete':
      return `DELETE FROM ${s.table}${s.where ? ` WHERE ${renderExpr(s.where)}` : ''}`;
    case 'select': {
      let out = `SELECT ${s.cols ? s.cols.join(', ') : '*'} FROM ${s.table}`;
      if (s.where) out += ` WHERE ${renderExpr(s.where)}`;
      if (s.order.length > 0) out += ` ORDER BY ${s.order.map((o) => `${o.col}${o.desc ? ' DESC' : ''}`).join(', ')}`;
      if (s.limit !== null) out += ` LIMIT ${s.limit}${s.offset !== null ? ` OFFSET ${s.offset}` : ''}`;
      return out;
    }
    case 'begin':
      return 'BEGIN';
    case 'commit':
      return 'COMMIT';
    case 'rollback':
      return 'ROLLBACK';
  }
}
