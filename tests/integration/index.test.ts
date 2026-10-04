import { describe, expect, it } from 'vitest';
import type { Database } from '../../src/engine/database.js';
import { ConstraintError, LimitError } from '../../src/errors/errors.js';
import type { Value } from '../../src/record/value.js';
import { createRng } from '../../src/util/prng.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { errOf, memDb, openDb, rows, run, sorted } from '../support/db.js';

function plan(db: Database, sql: string): string[] {
  return rows(db, `EXPLAIN ${sql}`).map((r) => r[0] as string);
}

function scanLine(db: Database, sql: string): string {
  return plan(db, sql).find((l) => /Scan/.test(l))?.trim() ?? '';
}

describe('index integration', () => {
  it('T-IDX-001 CREATE UNIQUE INDEX over duplicates fails, leaves no index and leaks no page', () => {
    const db = memDb();
    run(db, "CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'y'), (1, 'z')");
    const before = db.integrityCheck().summary;
    const e = errOf(() => db.execute('CREATE UNIQUE INDEX ua ON t (a)'));
    expect(e).toBeInstanceOf(ConstraintError);
    expect([e.code, e.position?.column]).toEqual(['UNIQUE_VIOLATION', 1]);
    expect(db.schema()[0]?.indexes).toEqual([]);
    const after = db.integrityCheck();
    expect(after.ok).toBe(true);
    expect(after.summary.pageCount - after.summary.freePages).toBe(before.pageCount - before.freePages);
    db.execute('CREATE UNIQUE INDEX ub ON t (b)');
    db.execute('CREATE INDEX ia ON t (a)');
    expect(db.schema()[0]?.indexes.map((i) => i.name)).toEqual(['ia', 'ub']);
    expect(db.integrityCheck().summary.indexEntries).toBe(6);
  });

  it('T-IDX-002 indexes stay consistent through INSERT, UPDATE (value change and row move) and DELETE', () => {
    const db = memDb();
    run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, g INTEGER, s TEXT, pad TEXT); CREATE INDEX ig ON t (g); CREATE UNIQUE INDEX us ON t (s)');
    const r = createRng(3);
    for (let i = 0; i < 80; i++) db.execute(`INSERT INTO t VALUES (${i}, ${r.nextInt(0, 9)}, 's${i}', NULL)`);
    expect(db.integrityCheck().issues).toEqual([]);
    db.execute('UPDATE t SET g = g + 100 WHERE id < 40');
    expect(db.integrityCheck().issues).toEqual([]);
    // grow rows so they move to other pages: every index must follow the new RIDs
    for (let i = 0; i < 80; i += 3) db.execute(`UPDATE t SET pad = '${'w'.repeat(900)}', s = 'm${i}' WHERE id = ${i}`);
    expect(db.integrityCheck().issues).toEqual([]);
    db.execute('UPDATE t SET id = id + 1000');
    expect(db.integrityCheck().issues).toEqual([]);
    db.execute('DELETE FROM t WHERE g > 104');
    expect(db.integrityCheck().issues).toEqual([]);
    const left = rows(db, 'SELECT id FROM t').length;
    expect(db.integrityCheck().summary.indexEntries).toBe(3 * left);
    expect(rows(db, 'SELECT id FROM t WHERE id = 1003')).toEqual(rows(db, 'SELECT id FROM t WHERE id = 1003', true));
  });

  it('T-IDX-003 the PRIMARY KEY index is automatic, named mdb_pk_<table> and cannot be dropped', () => {
    const db = memDb();
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    expect(db.schema()[0]?.indexes).toEqual([{ name: 'mdb_pk_users', column: 'id', unique: true, auto: true }]);
    expect(errOf(() => db.execute('DROP INDEX mdb_pk_users')).code).toBe('CANNOT_DROP_PK_INDEX');
    expect(errOf(() => db.execute('CREATE TABLE mdb_pk_users (a INTEGER)')).code).toBe('RESERVED_NAME');
    db.execute('INSERT INTO users VALUES (1, NULL)');
    expect(errOf(() => db.execute('INSERT INTO users VALUES (1, NULL)')).code).toBe('UNIQUE_VIOLATION');
    db.execute('DROP TABLE users');
    expect(db.integrityCheck().ok).toBe(true);
  });

  it('T-IDX-004 NULLs are not indexed: several NULLs in a UNIQUE column; IS NULL uses a SeqScan', () => {
    const db = memDb();
    run(db, 'CREATE TABLE t (a INTEGER, b INTEGER); CREATE UNIQUE INDEX ua ON t (a)');
    run(db, 'INSERT INTO t VALUES (NULL, 1), (NULL, 2), (1, 3)');
    expect(errOf(() => db.execute('INSERT INTO t VALUES (1, 4)')).code).toBe('UNIQUE_VIOLATION');
    expect(db.integrityCheck().summary.indexEntries).toBe(1);
    expect(scanLine(db, 'SELECT * FROM t WHERE a IS NULL')).toBe('SeqScan table=t');
    expect(scanLine(db, 'SELECT * FROM t WHERE a = NULL')).toBe('SeqScan table=t');
    expect(sorted(rows(db, 'SELECT b FROM t WHERE a IS NULL'))).toEqual([[1], [2]]);
    db.execute('UPDATE t SET a = NULL WHERE b = 3');
    db.execute('UPDATE t SET a = 7 WHERE b = 1');
    expect(db.integrityCheck().summary.indexEntries).toBe(1);
  });

  it('T-IDX-005 KEY_TOO_LARGE on INSERT, UPDATE and CREATE INDEX', () => {
    const db = memDb();
    run(db, 'CREATE TABLE t (s TEXT); CREATE INDEX i ON t (s)');
    db.execute(`INSERT INTO t VALUES ('${'k'.repeat(512)}')`);
    const ins = errOf(() => db.execute(`INSERT INTO t VALUES ('${'k'.repeat(513)}')`));
    expect(ins).toBeInstanceOf(LimitError);
    expect([ins.code, ins.position?.column]).toEqual(['KEY_TOO_LARGE', 22]);
    expect(errOf(() => db.execute(`UPDATE t SET s = '${'k'.repeat(600)}'`)).code).toBe('KEY_TOO_LARGE');
    run(db, `CREATE TABLE u (s TEXT); INSERT INTO u VALUES ('${'x'.repeat(700)}')`);
    expect(errOf(() => db.execute('CREATE INDEX j ON u (s)')).code).toBe('KEY_TOO_LARGE');
    expect(db.schema().find((t) => t.name === 'u')?.indexes).toEqual([]);
    // a long literal in WHERE cannot be an index bound: the planner leaves it to the filter
    expect(scanLine(db, `SELECT * FROM t WHERE s = '${'k'.repeat(600)}'`)).toBe('SeqScan table=t');
    expect(rows(db, `SELECT * FROM t WHERE s = '${'k'.repeat(600)}'`)).toEqual([]);
  });

  it('T-PLAN-001 planner rules: unique = beats non-unique = beats range; name tie-break; flipped literals; no index for <>, OR, col-col, NULL', () => {
    const db = memDb();
    run(
      db,
      `CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, s TEXT);
       CREATE INDEX ib ON t (b); CREATE INDEX ia ON t (a); CREATE INDEX ia2 ON t (a); CREATE UNIQUE INDEX us ON t (s)`,
    );
    expect(scanLine(db, 'SELECT * FROM t WHERE a = 1 AND id = 5')).toBe('IndexScan table=t index=mdb_pk_t column=id range=[5, 5]');
    expect(scanLine(db, "SELECT * FROM t WHERE a = 1 AND s = 'x'")).toBe("IndexScan table=t index=us column=s range=['x', 'x']");
    expect(scanLine(db, 'SELECT * FROM t WHERE b > 3 AND a = 1')).toBe('IndexScan table=t index=ia column=a range=[1, 1]');
    expect(scanLine(db, 'SELECT * FROM t WHERE b > 3 AND a < 9')).toBe('IndexScan table=t index=ia column=a range=(-inf, 9)');
    expect(scanLine(db, 'SELECT * FROM t WHERE 3 < b')).toBe('IndexScan table=t index=ib column=b range=(3, +inf)');
    expect(scanLine(db, 'SELECT * FROM t WHERE b >= -5 AND b > -5 AND b <= 10 AND 10 > b')).toBe('IndexScan table=t index=ib column=b range=(-5, 10)');
    expect(scanLine(db, 'SELECT * FROM t WHERE b = 1 AND b = 2')).toBe('IndexScan table=t index=ib column=b range=[2, 1]');
    for (const w of ['b <> 1', 'b = 1 OR b = 2', 'a = b', 'b = NULL', 'NOT (b = 1)', 'b + 0 = 1', 'b IS NULL']) {
      expect(scanLine(db, `SELECT * FROM t WHERE ${w}`), w).toBe('SeqScan table=t');
    }
    expect(scanLine(db, 'SELECT * FROM t')).toBe('SeqScan table=t');
    expect(rows(db, 'SELECT * FROM t WHERE b = 1 AND b = 2')).toEqual([]);
  });

  it('T-PLAN-002 EXPLAIN prints IndexScan with the full WHERE kept as a Filter', () => {
    const db = memDb();
    run(db, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER); CREATE INDEX idx_age ON users (age)');
    expect(plan(db, "SELECT name FROM users WHERE age >= 30 AND name <> 'x' ORDER BY name LIMIT 10")).toEqual([
      'Project columns=name',
      '  Limit limit=10 offset=0',
      '    Sort keys=name ASC',
      "      Filter predicate=((age >= 30) AND (name <> 'x'))",
      '        IndexScan table=users index=idx_age column=age range=[30, +inf)',
    ]);
    expect(plan(db, 'SELECT * FROM users WHERE id = 7')).toEqual([
      'Project columns=id, name, age',
      '  Filter predicate=(id = 7)',
      '    IndexScan table=users index=mdb_pk_users column=id range=[7, 7]',
    ]);
  });

  it('T-DIFF-001 random queries return the same rows with indexes and with forceSeqScan', () => {
    for (const seed of [1, 2, 3]) {
      const r = createRng(seed);
      const db = memDb();
      run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c BOOLEAN); CREATE INDEX ia ON t (a); CREATE INDEX ib ON t (b); CREATE INDEX ic ON t (c)');
      const texts = ['', 'a', 'b', 'é', '한', '😀', 'zz'];
      const lit = (col: string): string => {
        if (col === 'a' || col === 'id') return String(r.nextInt(-12, 12));
        if (col === 'b') return `'${r.pick(texts)}'`;
        return r.pick(['TRUE', 'FALSE']);
      };
      for (let i = 0; i < 200; i++) {
        const a = r.chance(0.1) ? 'NULL' : String(r.nextInt(-10, 10));
        const b = r.chance(0.1) ? 'NULL' : `'${r.pick(texts)}'`;
        const c = r.chance(0.1) ? 'NULL' : r.pick(['TRUE', 'FALSE']);
        db.execute(`INSERT INTO t VALUES (${i}, ${a}, ${b}, ${c})`);
      }
      let indexed = 0;
      for (let q = 0; q < 300; q++) {
        const n = r.nextInt(1, 3);
        const conj = Array.from({ length: n }, () => {
          const col = r.pick(['id', 'a', 'b', 'c']);
          const op = r.pick(['=', '<', '<=', '>', '>=', '<>']);
          return r.chance(0.5) ? `${col} ${op} ${lit(col)}` : `${lit(col)} ${op} ${col}`;
        });
        const sql = `SELECT * FROM t WHERE ${conj.join(r.chance(0.8) ? ' AND ' : ' OR ')}`;
        const withIdx = db.execute(sql);
        const seq = db.execute(sql, { forceSeqScan: true });
        if (withIdx.kind !== 'rows' || seq.kind !== 'rows') throw new Error('not rows');
        expect(sorted(withIdx.rows as Value[][]), sql).toEqual(sorted(seq.rows as Value[][]));
        if (scanLine(db, sql).startsWith('IndexScan')) indexed++;
      }
      expect(indexed).toBeGreaterThan(100);
    }
  });

  it('T-IDX-002 indexes survive reopen and are rebuilt into the catalog', () => {
    const vfs = new MemoryVfs();
    const { db } = openDb(vfs);
    run(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT); CREATE INDEX i ON t (s); INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    db.close();
    const again = openDb(vfs).db;
    expect(again.schema()[0]?.indexes.map((i) => i.name)).toEqual(['i', 'mdb_pk_t']);
    expect(scanLine(again, "SELECT * FROM t WHERE s = 'b'")).toBe("IndexScan table=t index=i column=s range=['b', 'b']");
    expect(rows(again, "SELECT id FROM t WHERE s = 'b'")).toEqual([[2]]);
  });
});
