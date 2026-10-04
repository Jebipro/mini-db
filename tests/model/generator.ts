import type { Rng } from '../../src/util/prng.js';
import type { MColumn, MExpr, MStmt, MType, MVal } from './ast.js';
import type { MState, MTable } from './ref-model.js';

/**
 * Random statement generator (J.4). Reads the model state to produce mostly valid statements plus a share
 * of deliberate failures. WHERE clauses never contain arithmetic (no plan-dependent overflow, DC-43).
 */
const MAX = 9007199254740991;
const TEXTS = ['', 'a', 'b', 'c', 'd', 'e', 'é', '한', '😀', 'ｱ', 'ab', 'a b', "it's", 'B', 'zz'];
const INT_EDGE = [0, 1, -1, MAX, -MAX, MAX - 1, -(MAX - 1)];

export interface GenOptions {
  withIndexes: boolean;
}

export function randomValue(r: Rng, t: MType, nullable = true): MVal {
  if (nullable && r.chance(0.15)) return null;
  switch (t) {
    case 'INTEGER':
      return r.chance(0.15) ? r.pick(INT_EDGE) : r.nextInt(-20, 20);
    case 'TEXT':
      // occasional long values make rows move between pages and exceed the 512-byte key limit
      return r.chance(0.06) ? 'L'.repeat(r.nextInt(300, 650)) : r.pick(TEXTS);
    case 'BOOLEAN':
      return r.chance(0.5);
  }
}

const lit = (v: MVal): MExpr => ({ k: 'lit', v });
const col = (name: string): MExpr => ({ k: 'col', name });

function tableNames(s: MState): string[] {
  return [...s.tables.keys()].sort();
}

function pkCol(t: MTable): MColumn | undefined {
  return t.cols.find((c) => c.pk);
}

/** Boolean predicate over the table: comparisons, IS NULL, AND/OR/NOT. */
function genPredicate(r: Rng, t: MTable, depth = 0): MExpr {
  const x = r.nextFloat();
  if (depth < 2 && x < 0.25) {
    return { k: 'logic', op: r.chance(0.5) ? 'AND' : 'OR', l: genPredicate(r, t, depth + 1), r: genPredicate(r, t, depth + 1) };
  }
  if (depth < 2 && x < 0.32) return { k: 'not', e: genPredicate(r, t, depth + 1) };
  const c = r.pick(t.cols);
  if (x < 0.42) return { k: 'isnull', e: col(c.name), negated: r.chance(0.5) };
  if (c.type === 'BOOLEAN' && r.chance(0.3)) return col(c.name);
  const op = r.pick(['=', '<>', '<', '<=', '>', '>='] as const);
  // literal from the column's domain; sometimes compare two columns of the same type
  const same = t.cols.filter((o) => o.type === c.type && o.name !== c.name);
  const right = same.length > 0 && r.chance(0.15) ? col(r.pick(same).name) : lit(randomValue(r, c.type, r.chance(0.1)));
  return r.chance(0.5) ? { k: 'cmp', op, l: col(c.name), r: right } : { k: 'cmp', op, l: right, r: col(c.name) };
}

/** Value expression for SET / VALUES. In VALUES (`table` null) there are no column references. */
function genValueExpr(r: Rng, c: MColumn, t: MTable | null): MExpr {
  if (c.type === 'INTEGER' && r.chance(0.3)) {
    const base: MExpr = t && r.chance(0.6) ? col(c.name) : lit(randomValue(r, 'INTEGER', false));
    const x = r.nextFloat();
    if (x < 0.4) return { k: 'arith', op: r.pick(['+', '-'] as const), l: base, r: lit(r.nextInt(-5, 5)) };
    if (x < 0.7) return { k: 'arith', op: '*', l: base, r: lit(r.pick([2, -1, 3, 0])) };
    return { k: 'neg', e: base };
  }
  if (c.type === 'BOOLEAN' && t && r.chance(0.2)) return { k: 'not', e: col(c.name) };
  return lit(randomValue(r, c.type, !c.notNull || r.chance(0.03)));
}

let tableSeq = 0;

export function resetGenerator(): void {
  tableSeq = 0;
}

function genCreate(r: Rng): MStmt {
  const n = r.nextInt(2, 6);
  const types: MType[] = ['INTEGER', 'TEXT', 'BOOLEAN'];
  const cols: MColumn[] = [];
  const withPk = r.chance(0.8);
  for (let i = 0; i < n; i++) {
    const pk = withPk && i === 0;
    cols.push({ name: `c${i}`, type: pk ? 'INTEGER' : r.pick(types), notNull: pk || r.chance(0.2), pk });
  }
  return { k: 'create', table: `t${tableSeq++ % 4}`, cols };
}

export function generate(r: Rng, s: MState, inTxn: boolean, opts: GenOptions): MStmt {
  const names = tableNames(s);
  if (names.length === 0 || (names.length < 3 && r.chance(0.03))) return genCreate(r);
  const name = r.pick(names);
  const t = s.tables.get(name) as MTable;
  const x = r.nextFloat();

  if (x < 0.3) {
    // INSERT
    const n = r.nextInt(1, 4);
    const byName = r.chance(0.3);
    let cols = byName ? t.cols.filter((c) => c.notNull || r.chance(0.6)) : t.cols;
    if (cols.length === 0) cols = [r.pick(t.cols)];
    const rows = Array.from({ length: n }, () =>
      cols.map((c) => {
        if (c.pk) {
          const existing = t.rows.map((row) => row[0]).filter((v): v is number => typeof v === 'number');
          if (existing.length > 0 && r.chance(0.08)) return lit(r.pick(existing)); // deliberate duplicate
          return lit(r.nextInt(-200, 200));
        }
        return genValueExpr(r, c, null);
      }),
    );
    return { k: 'insert', table: name, cols: byName ? cols.map((c) => c.name) : null, rows };
  }
  if (x < 0.55) {
    // SELECT
    const cols = r.chance(0.4) ? null : Array.from({ length: r.nextInt(1, 3) }, () => r.pick(t.cols).name);
    const where = r.chance(0.7) ? genPredicate(r, t) : null;
    const pk = pkCol(t);
    let order: Array<{ col: string; desc: boolean }> = [];
    let limit: number | null = null;
    let offset: number | null = null;
    if (r.chance(0.6)) {
      order = Array.from({ length: r.nextInt(1, 2) }, () => ({ col: r.pick(t.cols).name, desc: r.chance(0.4) }));
      if (pk && r.chance(0.7)) {
        order.push({ col: pk.name, desc: r.chance(0.3) });
        if (r.chance(0.5)) {
          limit = r.nextInt(0, 6);
          offset = r.chance(0.5) ? r.nextInt(0, 5) : null;
        }
      }
    }
    if (r.chance(0.02)) return { k: 'select', table: name, cols: ['nope'], where, order, limit, offset }; // deliberate failure
    return { k: 'select', table: name, cols, where, order, limit, offset };
  }
  if (x < 0.7) {
    // UPDATE
    const n = r.nextInt(1, 2);
    const targets = [...new Set(Array.from({ length: n }, () => r.pick(t.cols)))];
    const sets = targets.map((c) => {
      if (c.pk && r.chance(0.5)) return { col: c.name, e: { k: 'arith', op: '+', l: col(c.name), r: lit(r.nextInt(-3, 3)) } as MExpr };
      if (c.type === 'INTEGER' && r.chance(0.05)) return { col: c.name, e: { k: 'arith', op: '*', l: col(c.name), r: lit(MAX) } as MExpr };
      return { col: c.name, e: genValueExpr(r, c, t) };
    });
    return { k: 'update', table: name, sets, where: r.chance(0.8) ? genPredicate(r, t) : null };
  }
  if (x < 0.8) return { k: 'delete', table: name, where: r.chance(0.9) ? genPredicate(r, t) : null };
  if (x < 0.88) {
    if (inTxn) return r.chance(0.6) ? { k: 'commit' } : { k: 'rollback' };
    return r.chance(0.9) ? { k: 'begin' } : r.pick([{ k: 'commit' }, { k: 'rollback' }] as MStmt[]);
  }
  if (x < 0.93 && opts.withIndexes) {
    const existing = [...t.indexes.keys()].filter((n) => !n.startsWith('mdb_'));
    if (existing.length > 0 && r.chance(0.4)) return { k: 'dropIndex', name: r.pick(existing) };
    const c = r.pick(t.cols);
    return { k: 'createIndex', name: `i_${name}_${c.name}_${r.nextInt(0, 2)}`, table: name, col: c.name, unique: r.chance(0.3) };
  }
  if (x < 0.95) return r.chance(0.5) ? genCreate(r) : { k: 'drop', table: name };
  return { k: 'select', table: name, cols: null, where: null, order: [], limit: null, offset: null };
}
