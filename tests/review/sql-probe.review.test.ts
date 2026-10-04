import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { deterministicEntropy } from '../support/db.js';

/** REVIEW-SQL-001: targeted SQL semantics probes (planner bounds, Halloween, statement-level uniqueness, NULLs, LIMIT). */
function db(): Database {
  return Database.open('s.db', { vfs: new MemoryVfs(), entropy: deterministicEntropy(4) });
}
function rows(d: Database, sql: string, seq = false): unknown[][] {
  const r = d.execute(sql, { forceSeqScan: seq });
  if (r.kind !== 'rows') throw new Error('rows');
  return r.rows;
}
function code(f: () => unknown): string {
  try {
    f();
    return 'ok';
  } catch (e) {
    if (e instanceof MiniDbError) return e.code;
    throw e;
  }
}

describe('REVIEW-SQL-001', () => {
  it('index bounds: every operator / flip / negative / contradiction equals the seq scan', () => {
    const d = db();
    d.executeScript('CREATE TABLE t (id INTEGER PRIMARY KEY, g INTEGER, s TEXT, b BOOLEAN); CREATE INDEX tg ON t (g); CREATE INDEX ts ON t (s); CREATE INDEX tb ON t (b);');
    const texts = ['', 'a', 'aa', 'ab', 'b', 'é'];
    d.execute('BEGIN');
    for (let i = -30; i < 30; i++) {
      const b = i % 3 === 0 ? 'NULL' : i % 2 === 0 ? 'TRUE' : 'FALSE';
      d.execute(`INSERT INTO t VALUES (${i}, ${i % 5}, '${texts[(i + 30) % 6] as string}', ${b})`);
    }
    d.execute('COMMIT');
    const preds = [
      'id = 3', 'id < -5', 'id <= -5', 'id > -5', 'id >= -5', '-5 < id', '-5 >= id', 'id = - 7', 'id > 5 AND id < 3',
      'id = 5 AND id = 6', 'id >= 5 AND id > 5', 'id <= 5 AND id < 5', 'g = 2 AND id > 0', 'g >= 3 AND g <= 3',
      "s = ''", "s > 'a'", "s >= 'a' AND s < 'ab'", "'aa' = s", "s < 'é'", 'b = TRUE', 'b = FALSE AND id < 0', 'b <> TRUE',
      'NOT (id = 3)', 'id = 3 OR id = 4', 'g = NULL', 'NULL = g', 'g IS NULL', 'b IS NOT NULL AND g = 1',
      'id > 9007199254740991', 'id < -9007199254740991', 'id = 0 AND id = - 0',
    ];
    for (const p of preds) {
      const sql = `SELECT id FROM t WHERE ${p} ORDER BY id`;
      expect(rows(d, sql), sql).toEqual(rows(d, sql, true));
    }
    d.close();
  });

  it('Halloween: growing UPDATE through an index visits each row once; PK shift and sign swap succeed (DC-31)', () => {
    const d = db();
    d.executeScript('CREATE TABLE t (id INTEGER PRIMARY KEY, g INTEGER, pad TEXT); CREATE INDEX tg ON t (g);');
    d.execute('BEGIN');
    for (let i = 0; i < 200; i++) d.execute(`INSERT INTO t VALUES (${i}, ${i % 4}, 'p')`);
    d.execute('COMMIT');
    expect(d.execute(`UPDATE t SET g = g + 4, pad = '${'x'.repeat(1500)}' WHERE g >= 0`)).toEqual({ kind: 'changes', command: 'UPDATE', changes: 200 });
    expect(rows(d, 'SELECT id FROM t WHERE g < 4')).toEqual([]);
    expect(rows(d, 'SELECT id FROM t WHERE g >= 4').length).toBe(200);
    expect(d.execute('UPDATE t SET id = id + 1')).toEqual({ kind: 'changes', command: 'UPDATE', changes: 200 });
    expect(d.execute('UPDATE t SET id = 0 - id')).toEqual({ kind: 'changes', command: 'UPDATE', changes: 200 });
    expect(rows(d, 'SELECT id FROM t ORDER BY id LIMIT 2')).toEqual([[-200], [-199]]);
    expect(code(() => d.execute('UPDATE t SET id = -1 WHERE id = -2'))).toBe('UNIQUE_VIOLATION'); // non-target owner
    expect(code(() => d.execute('UPDATE t SET id = 7 WHERE id < -198'))).toBe('UNIQUE_VIOLATION'); // new values collide
    expect(d.integrityCheck().issues).toEqual([]);
    d.close();
  });

  it('UNIQUE allows many NULLs; LIMIT/OFFSET edges; ORDER BY DESC puts NULL last', () => {
    const d = db();
    d.executeScript('CREATE TABLE t (id INTEGER PRIMARY KEY, u TEXT); CREATE UNIQUE INDEX tu ON t (u);');
    d.executeScript("INSERT INTO t VALUES (1, NULL), (2, NULL), (3, 'a'), (4, NULL)");
    expect(code(() => d.execute("INSERT INTO t VALUES (5, 'a')"))).toBe('UNIQUE_VIOLATION');
    expect(rows(d, 'SELECT id FROM t WHERE u IS NULL ORDER BY id')).toEqual([[1], [2], [4]]);
    expect(rows(d, 'SELECT id FROM t ORDER BY u DESC, id LIMIT 2')).toEqual([[3], [1]]);
    expect(rows(d, 'SELECT id FROM t ORDER BY id LIMIT 0')).toEqual([]);
    expect(rows(d, 'SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 3')).toEqual([[4]]);
    expect(rows(d, 'SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 100')).toEqual([]);
    d.close();
  });

  it('DC-43 (design note): a WHERE overflow may error under SeqScan but not under IndexScan', () => {
    const d = db();
    d.executeScript('CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER); INSERT INTO t VALUES (1, 1), (2, 9007199254740991);');
    const q = 'SELECT id FROM t WHERE x * 2 > 0 AND id = 1';
    expect(rows(d, q)).toEqual([[1]]);
    expect(code(() => d.execute(q, { forceSeqScan: true }))).toBe('INTEGER_OVERFLOW');
    d.close();
  });
});
