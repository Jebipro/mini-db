import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import type { Value } from '../../src/record/value.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { createRng, type Rng } from '../../src/util/prng.js';
import { deterministicEntropy } from '../support/db.js';

/**
 * REVIEW-RM-001: targeted random workload for row moves + index maintenance, with its own tiny model.
 * Table t(id INTEGER PRIMARY KEY, s TEXT, u TEXT, g INTEGER, b BOOLEAN, pad TEXT) with indexes on s (non-unique),
 * u (UNIQUE), g (non-unique), b (non-unique). `pad` grows/shrinks between 0 and 3000 bytes so UPDATEs move rows
 * between pages much more often than the generic generator does. Statement-level uniqueness in the model = the
 * final table has no duplicate non-NULL id/u. Every query is also run with forceSeqScan.
 */

type Row = { id: number; s: string | null; u: string | null; g: number | null; b: boolean | null; pad: string | null };
const COLS = ['id', 's', 'u', 'g', 'b', 'pad'] as const;

const S_POOL = ['', 'a', 'aa', 'ab', 'b', 'é', '😀', 'ｱ', 'm'.repeat(200), 'm'.repeat(201), 'n'.repeat(512)];
const U_POOL = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];

function lit(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function tcmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface Pred {
  sql: string;
  test: (r: Row) => boolean;
}

function genPred(r: Rng): Pred {
  const x = r.nextInt(0, 8);
  switch (x) {
    case 0: {
      const k = r.nextInt(0, 6);
      return { sql: `g = ${k}`, test: (row) => row.g === k };
    }
    case 1: {
      const k = r.nextInt(0, 120);
      return { sql: `id < ${k}`, test: (row) => row.id < k };
    }
    case 2: {
      const k = r.nextInt(0, 120);
      return { sql: `id >= ${k}`, test: (row) => row.id >= k };
    }
    case 3: {
      const v = r.pick(S_POOL);
      return { sql: `s = ${lit(v)}`, test: (row) => row.s !== null && row.s === v };
    }
    case 4: {
      const v = r.pick(S_POOL);
      return { sql: `s > ${lit(v)}`, test: (row) => row.s !== null && tcmp(row.s, v) > 0 };
    }
    case 5: {
      const v = r.chance(0.5);
      return { sql: `b = ${lit(v)}`, test: (row) => row.b === v };
    }
    case 6: {
      const v = r.pick(U_POOL);
      return { sql: `u <= ${lit(v)}`, test: (row) => row.u !== null && tcmp(row.u, v) <= 0 };
    }
    case 7: {
      const k = r.nextInt(0, 6);
      const k2 = r.nextInt(0, 120);
      return { sql: `g > ${k} AND id < ${k2}`, test: (row) => row.g !== null && row.g > k && row.id < k2 };
    }
    default:
      return { sql: 'pad IS NULL', test: (row) => row.pad === null };
  }
}

function randPad(r: Rng): string | null {
  const x = r.nextFloat();
  if (x < 0.15) return null;
  if (x < 0.5) return 'p'.repeat(r.nextInt(0, 20));
  return 'q'.repeat(r.nextInt(500, 3000));
}

function randRow(r: Rng, id: number): Row {
  return {
    id,
    s: r.chance(0.15) ? null : (r.pick(S_POOL) as string),
    u: r.chance(0.4) ? null : (r.pick(U_POOL) as string),
    g: r.chance(0.1) ? null : r.nextInt(0, 6),
    b: r.chance(0.1) ? null : r.chance(0.5),
    pad: randPad(r),
  };
}

function valid(rows: Row[]): boolean {
  const ids = new Set<number>();
  const us = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) return false;
    ids.add(row.id);
    if (row.u !== null) {
      if (us.has(row.u)) return false;
      us.add(row.u);
    }
  }
  return true;
}

const asArr = (row: Row): Value[] => COLS.map((c) => row[c]);
const canon = (rows: Value[][]): string[] => rows.map((x) => JSON.stringify(x)).sort();

function runSeed(seed: number, steps: number): { moves: number } {
  const r = createRng(seed);
  const vfs = new MemoryVfs();
  const open = (): Database => Database.open('rm.db', { vfs, entropy: deterministicEntropy(seed) });
  let db = open();
  db.executeScript(
    'CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, u TEXT, g INTEGER, b BOOLEAN, pad TEXT);' +
      'CREATE INDEX t_s ON t (s); CREATE UNIQUE INDEX t_u ON t (u); CREATE INDEX t_g ON t (g); CREATE INDEX t_b ON t (b);',
  );
  let committed: Row[] = [];
  let rows: Row[] = [];
  let inTxn = false;
  let nextId = 0;
  let moves = 0;
  const ctx = (step: number, sql: string): string => `seed ${seed} step ${step}: ${sql}`;

  const exec = (sql: string): { ok: true } | { ok: false; code: string } => {
    try {
      db.execute(sql);
      return { ok: true };
    } catch (e) {
      if (!(e instanceof MiniDbError)) throw e;
      return { ok: false, code: e.code };
    }
  };

  for (let step = 0; step < steps; step++) {
    const x = r.nextFloat();
    let sql: string;
    let next: Row[] | 'error';
    if (x < 0.25 || rows.length < 5) {
      const n = r.nextInt(1, 3);
      const add: Row[] = [];
      for (let i = 0; i < n; i++) add.push(randRow(r, r.chance(0.05) && rows.length > 0 ? (r.pick(rows) as Row).id : nextId++));
      sql = `INSERT INTO t VALUES ${add.map((a) => `(${asArr(a).map(lit).join(', ')})`).join(', ')}`;
      const all = [...rows, ...add];
      next = valid(all) ? all : 'error';
    } else if (x < 0.6) {
      const p = genPred(r);
      const kind = r.nextInt(0, 3);
      let set: string;
      let f: (row: Row) => Row;
      if (kind === 0) {
        const pad = randPad(r);
        set = `pad = ${lit(pad)}`;
        f = (row) => ({ ...row, pad });
      } else if (kind === 1) {
        const k = r.nextInt(-3, 3);
        set = `id = id + ${k}`;
        f = (row) => ({ ...row, id: row.id + k });
      } else if (kind === 2) {
        const u = r.chance(0.3) ? null : (r.pick(U_POOL) as string);
        set = `u = ${lit(u)}`;
        f = (row) => ({ ...row, u });
      } else {
        const s = r.chance(0.1) ? null : (r.pick(S_POOL) as string);
        const g = r.nextInt(0, 6);
        const pad = randPad(r);
        set = `s = ${lit(s)}, g = ${g}, pad = ${lit(pad)}`;
        f = (row) => ({ ...row, s, g, pad });
      }
      sql = `UPDATE t SET ${set} WHERE ${p.sql}`;
      const all = rows.map((row) => (p.test(row) ? f(row) : row));
      next = valid(all) ? all : 'error';
    } else if (x < 0.75) {
      const p = genPred(r);
      sql = `DELETE FROM t WHERE ${p.sql}`;
      next = rows.filter((row) => !p.test(row));
    } else if (x < 0.85) {
      const p = genPred(r);
      sql = `SELECT * FROM t WHERE ${p.sql}`;
      const want = canon(rows.filter(p.test).map(asArr));
      const viaPlan = db.execute(sql);
      const viaSeq = db.execute(sql, { forceSeqScan: true });
      if (viaPlan.kind !== 'rows' || viaSeq.kind !== 'rows') throw new Error('rows expected');
      expect(canon(viaPlan.rows), ctx(step, sql + ' [plan]')).toEqual(want);
      expect(canon(viaSeq.rows), ctx(step, sql + ' [seq]')).toEqual(want);
      continue;
    } else if (x < 0.95) {
      if (!inTxn) {
        sql = 'BEGIN';
        expect(exec(sql), ctx(step, sql)).toEqual({ ok: true });
        inTxn = true;
      } else if (r.chance(0.4)) {
        sql = 'ROLLBACK';
        expect(exec(sql), ctx(step, sql)).toEqual({ ok: true });
        rows = committed.slice();
        inTxn = false;
      } else {
        sql = 'COMMIT';
        expect(exec(sql), ctx(step, sql)).toEqual({ ok: true });
        committed = rows.slice();
        inTxn = false;
      }
      continue;
    } else {
      if (inTxn) continue;
      const rep = db.integrityCheck();
      expect(rep.issues, ctx(step, 'integrityCheck')).toEqual([]);
      if (r.chance(0.3)) {
        db.close();
        db = open();
      }
      continue;
    }
    const before = db.stats().io.walFrameWrites;
    const res = exec(sql);
    void before;
    if (next === 'error') {
      expect(res.ok, ctx(step, sql + ' should fail')).toBe(false);
      if (!res.ok) expect(['UNIQUE_VIOLATION'], ctx(step, sql)).toContain(res.code);
    } else {
      expect(res, ctx(step, sql)).toEqual({ ok: true });
      if (sql.startsWith('UPDATE') && sql.includes('pad =')) moves++;
      rows = next;
      if (!inTxn) committed = rows.slice();
    }
    expect(db.state, ctx(step, sql)).toBe('open');
  }
  if (inTxn) db.execute('ROLLBACK');
  rows = committed;
  db.close();
  db = open();
  const all = db.execute('SELECT * FROM t');
  if (all.kind !== 'rows') throw new Error('rows');
  expect(canon(all.rows), `seed ${seed} final`).toEqual(canon(rows.map(asArr)));
  expect(db.integrityCheck().issues, `seed ${seed} final integrity`).toEqual([]);
  db.close();
  return { moves };
}

describe('REVIEW-RM-001 row moves + index maintenance vs independent model', () => {
  it('random seeds', () => {
    const seeds = Number(process.env.REVIEW_SEEDS ?? 30);
    for (let s = 1; s <= seeds; s++) runSeed(s, 600);
  });
});
