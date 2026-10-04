import type { MColumn, MExpr, MStmt, MVal } from './ast.js';

/**
 * Reference model (J.3): an obviously-correct in-memory interpreter of the test AST.
 * It deliberately shares no code with src/ (T-ARCH-002): arrays of rows, JS filters, Buffer comparisons.
 *
 * Guarantees: result rows (as a multiset or a total order), change counts, whether a statement fails and the
 * set of error codes it may fail with, statement/transaction atomicity, persistence across clean reopen.
 * Not covered: crash semantics, physical format, plan choice, error positions/messages, unordered row order.
 */

export interface MTable {
  cols: MColumn[];
  rows: MVal[][];
  indexes: Map<string, { col: string; unique: boolean }>;
}

export interface MState {
  tables: Map<string, MTable>;
}

export type MResult =
  | { ok: true; kind: 'rows'; columns: string[]; rows: MVal[][]; totalOrder: boolean }
  | { ok: true; kind: 'changes'; changes: number }
  | { ok: true; kind: 'ok' }
  | { ok: false; codes: Set<string> };

const MAX = 9007199254740991;

class Fail extends Error {
  constructor(readonly codes: Set<string>) {
    super([...codes].join(','));
  }
}

function cloneState(s: MState): MState {
  const tables = new Map<string, MTable>();
  for (const [n, t] of s.tables) {
    tables.set(n, { cols: t.cols.map((c) => ({ ...c })), rows: t.rows.map((r) => [...r]), indexes: new Map(t.indexes) });
  }
  return { tables };
}

/** Text order = UTF-8 byte order. */
function cmpVal(a: Exclude<MVal, null>, b: Exclude<MVal, null>): number {
  if (typeof a === 'string' && typeof b === 'string') return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

/** NULL sorts first. */
export function sortCmp(a: MVal, b: MVal): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return cmpVal(a, b);
}

export function evalExpr(e: MExpr, row: Record<string, MVal>): MVal {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'col':
      if (!(e.name in row)) throw new Fail(new Set(['COLUMN_NOT_FOUND']));
      return row[e.name] as MVal;
    case 'neg': {
      const v = evalExpr(e.e, row);
      return v === null ? null : 0 - (v as number);
    }
    case 'not': {
      const v = evalExpr(e.e, row);
      return v === null ? null : !v;
    }
    case 'arith': {
      const l = evalExpr(e.l, row);
      const r = evalExpr(e.r, row);
      if (l === null || r === null) return null;
      const x = BigInt(l as number);
      const y = BigInt(r as number);
      const out = e.op === '+' ? x + y : e.op === '-' ? x - y : x * y;
      if (out > BigInt(MAX) || out < -BigInt(MAX)) throw new Fail(new Set(['INTEGER_OVERFLOW']));
      return Number(out);
    }
    case 'cmp': {
      const l = evalExpr(e.l, row);
      const r = evalExpr(e.r, row);
      if (l === null || r === null) return null;
      const c = cmpVal(l, r);
      return { '=': c === 0, '<>': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[e.op];
    }
    case 'logic': {
      const l = evalExpr(e.l, row);
      if (e.op === 'AND' && l === false) return false;
      if (e.op === 'OR' && l === true) return true;
      const r = evalExpr(e.r, row);
      if (e.op === 'AND') return r === false ? false : l === null || r === null ? null : true;
      return r === true ? true : l === null || r === null ? null : false;
    }
    case 'isnull': {
      const v = evalExpr(e.e, row);
      return e.negated ? v !== null : v === null;
    }
  }
}

function asRecord(t: MTable, r: MVal[]): Record<string, MVal> {
  const o: Record<string, MVal> = {};
  t.cols.forEach((c, i) => {
    o[c.name] = r[i] as MVal;
  });
  return o;
}

/** Columns with a uniqueness rule: the PK and every UNIQUE index column. */
function uniqueCols(t: MTable): number[] {
  const out = new Set<number>();
  t.cols.forEach((c, i) => {
    if (c.pk) out.add(i);
  });
  for (const ix of t.indexes.values()) if (ix.unique) out.add(t.cols.findIndex((c) => c.name === ix.col));
  return [...out];
}

/** Indexed TEXT columns whose value exceeds the 512-byte key limit. */
function keyTooLarge(t: MTable, row: MVal[], onlyCols?: Set<number>): boolean {
  for (const ix of t.indexes.values()) {
    const ci = t.cols.findIndex((c) => c.name === ix.col);
    if (onlyCols && !onlyCols.has(ci)) continue;
    const v = row[ci] as MVal;
    if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > 512) return true;
  }
  return false;
}

function hasDuplicates(rows: MVal[][], col: number): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[col] as MVal;
    if (v === null) continue;
    const k = JSON.stringify(v);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

export class RefModel {
  state: MState = { tables: new Map() };
  private snapshot: MState | null = null; // set while an explicit transaction is open

  /** Deep copy (crash oracles compute candidate states). */
  clone(): RefModel {
    const m = new RefModel();
    m.state = cloneState(this.state);
    m.snapshot = this.snapshot ? cloneState(this.snapshot) : null;
    return m;
  }

  /** Committed state: the snapshot while a transaction is open, otherwise the current state. */
  committed(): MState {
    return cloneState(this.snapshot ?? this.state);
  }

  get inTxn(): boolean {
    return this.snapshot !== null;
  }

  /** The database lost its handle (close or crash after commit): an open transaction is gone. */
  reopen(): void {
    if (this.snapshot) {
      this.state = this.snapshot;
      this.snapshot = null;
    }
  }

  apply(s: MStmt): MResult {
    if (s.k === 'begin') {
      if (this.snapshot) return { ok: false, codes: new Set(['TXN_ALREADY_ACTIVE']) };
      this.snapshot = cloneState(this.state);
      return { ok: true, kind: 'ok' };
    }
    if (s.k === 'commit' || s.k === 'rollback') {
      if (!this.snapshot) return { ok: false, codes: new Set(['TXN_NOT_ACTIVE']) };
      if (s.k === 'rollback') this.state = this.snapshot;
      this.snapshot = null;
      return { ok: true, kind: 'ok' };
    }
    const before = cloneState(this.state);
    try {
      return this.exec(s);
    } catch (e) {
      if (e instanceof Fail) {
        this.state = before; // statement atomicity
        return { ok: false, codes: e.codes };
      }
      throw e;
    }
  }

  private table(name: string): MTable {
    const t = this.state.tables.get(name);
    if (!t) throw new Fail(new Set(['TABLE_NOT_FOUND']));
    return t;
  }

  private objectExists(name: string): boolean {
    if (this.state.tables.has(name)) return true;
    for (const t of this.state.tables.values()) if (t.indexes.has(name)) return true;
    return false;
  }

  /** Static name check (the engine resolves names before touching any row). */
  private checkCols(t: MTable, e: MExpr | null): void {
    if (e === null) return;
    switch (e.k) {
      case 'lit':
        return;
      case 'col':
        this.colIndex(t, e.name);
        return;
      case 'neg':
      case 'not':
      case 'isnull':
        return this.checkCols(t, e.e);
      default:
        this.checkCols(t, e.l);
        this.checkCols(t, e.r);
    }
  }

  private colIndex(t: MTable, name: string): number {
    const i = t.cols.findIndex((c) => c.name === name);
    if (i < 0) throw new Fail(new Set(['COLUMN_NOT_FOUND']));
    return i;
  }

  private exec(s: Exclude<MStmt, { k: 'begin' | 'commit' | 'rollback' }>): MResult {
    switch (s.k) {
      case 'create': {
        if (this.objectExists(s.table)) throw new Fail(new Set(['OBJECT_EXISTS']));
        const pk = s.cols.find((c) => c.pk);
        const indexes = new Map<string, { col: string; unique: boolean }>();
        if (pk) indexes.set(`mdb_pk_${s.table}`, { col: pk.name, unique: true });
        this.state.tables.set(s.table, { cols: s.cols.map((c) => ({ ...c, notNull: c.notNull || c.pk })), rows: [], indexes });
        return { ok: true, kind: 'ok' };
      }
      case 'drop':
        this.table(s.table);
        this.state.tables.delete(s.table);
        return { ok: true, kind: 'ok' };
      case 'createIndex': {
        if (this.objectExists(s.name)) throw new Fail(new Set(['OBJECT_EXISTS']));
        const t = this.table(s.table);
        const ci = this.colIndex(t, s.col);
        const codes = new Set<string>();
        if (t.rows.some((r) => typeof r[ci] === 'string' && Buffer.byteLength(r[ci] as string, 'utf8') > 512)) codes.add('KEY_TOO_LARGE');
        if (s.unique && hasDuplicates(t.rows, ci)) codes.add('UNIQUE_VIOLATION');
        if (codes.size > 0) throw new Fail(codes);
        t.indexes.set(s.name, { col: s.col, unique: s.unique });
        return { ok: true, kind: 'ok' };
      }
      case 'dropIndex': {
        for (const t of this.state.tables.values()) {
          if (t.indexes.has(s.name)) {
            if (s.name.startsWith('mdb_pk_')) throw new Fail(new Set(['CANNOT_DROP_PK_INDEX']));
            t.indexes.delete(s.name);
            return { ok: true, kind: 'ok' };
          }
        }
        throw new Fail(new Set(['INDEX_NOT_FOUND']));
      }
      case 'insert': {
        const t = this.table(s.table);
        const targets = s.cols === null ? t.cols.map((_, i) => i) : s.cols.map((c) => this.colIndex(t, c));
        const codes = new Set<string>();
        const work = t.rows.map((r) => [...r]);
        for (const exprs of s.rows) {
          const row: MVal[] = t.cols.map(() => null);
          let ok = true;
          exprs.forEach((e, k) => {
            try {
              row[targets[k] as number] = evalExpr(e, {});
            } catch (err) {
              if (!(err instanceof Fail)) throw err;
              err.codes.forEach((c) => codes.add(c));
              ok = false;
            }
          });
          if (!ok) continue;
          if (t.cols.some((c, i) => c.notNull && row[i] === null)) {
            codes.add('NOT_NULL_VIOLATION');
            continue;
          }
          const tooLarge = keyTooLarge(t, row);
          if (tooLarge) codes.add('KEY_TOO_LARGE');
          if (uniqueCols(t).some((ci) => row[ci] !== null && work.some((r) => r[ci] === row[ci]))) {
            codes.add('UNIQUE_VIOLATION');
            continue;
          }
          if (tooLarge) continue;
          work.push(row);
        }
        if (codes.size > 0) throw new Fail(codes);
        t.rows = work;
        return { ok: true, kind: 'changes', changes: s.rows.length };
      }
      case 'update': {
        const t = this.table(s.table);
        const sets = s.sets.map((a) => ({ i: this.colIndex(t, a.col), e: a.e }));
        s.sets.forEach((a) => this.checkCols(t, a.e));
        this.checkCols(t, s.where);
        const targets = t.rows.map((r, i) => ({ r, i })).filter(({ r }) => !s.where || evalExpr(s.where, asRecord(t, r)) === true);
        const codes = new Set<string>();
        const next = t.rows.map((r) => [...r]);
        for (const { r, i } of targets) {
          const rec = asRecord(t, r);
          const nr = [...r];
          let ok = true;
          for (const a of sets) {
            try {
              nr[a.i] = evalExpr(a.e, rec); // SET sees the old row
            } catch (err) {
              if (!(err instanceof Fail)) throw err;
              err.codes.forEach((c) => codes.add(c));
              ok = false;
            }
          }
          if (!ok) continue;
          if (t.cols.some((c, k) => c.notNull && nr[k] === null)) codes.add('NOT_NULL_VIOLATION');
          next[i] = nr;
        }
        if (codes.size === 0) {
          const setIdx = new Set(sets.map((a) => a.i));
          for (const { i } of targets) if (keyTooLarge(t, next[i] as MVal[], setIdx)) codes.add('KEY_TOO_LARGE');
        }
        if (codes.size === 0) {
          for (const ci of uniqueCols(t)) if (hasDuplicates(next, ci)) codes.add('UNIQUE_VIOLATION');
        }
        if (codes.size > 0) throw new Fail(codes);
        t.rows = next;
        return { ok: true, kind: 'changes', changes: targets.length };
      }
      case 'delete': {
        const t = this.table(s.table);
        this.checkCols(t, s.where);
        const keep = t.rows.filter((r) => !(!s.where || evalExpr(s.where, asRecord(t, r)) === true));
        const n = t.rows.length - keep.length;
        t.rows = keep;
        return { ok: true, kind: 'changes', changes: n };
      }
      case 'select': {
        const t = this.table(s.table);
        const cols = s.cols === null ? t.cols.map((_, i) => i) : s.cols.map((c) => this.colIndex(t, c));
        this.checkCols(t, s.where);
        const order = s.order.map((o) => ({ i: this.colIndex(t, o.col), desc: o.desc }));
        let rows = t.rows.filter((r) => !s.where || evalExpr(s.where, asRecord(t, r)) === true);
        rows = [...rows].sort((a, b) => {
          for (const o of order) {
            const c = sortCmp(a[o.i] as MVal, b[o.i] as MVal);
            if (c !== 0) return o.desc ? -c : c;
          }
          return 0;
        });
        if (s.limit !== null) rows = rows.slice(s.offset ?? 0, (s.offset ?? 0) + s.limit);
        const last = order[order.length - 1];
        const totalOrder = last !== undefined && (t.cols[last.i] as MColumn).pk;
        return { ok: true, kind: 'rows', columns: cols.map((i) => (t.cols[i] as MColumn).name), rows: rows.map((r) => cols.map((i) => r[i] as MVal)), totalOrder };
      }
    }
  }
}
