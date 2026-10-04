import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { deterministicEntropy } from '../support/db.js';

/** REVIEW-BND-001: record-size, TEXT-size and UTF-8 boundaries through SQL, plus growth to the maximum row. */

function code(f: () => unknown): string {
  try {
    f();
    return 'ok';
  } catch (e) {
    if (e instanceof MiniDbError) return e.code;
    throw e;
  }
}
function newDb(): { db: Database; vfs: MemoryVfs } {
  const vfs = new MemoryVfs();
  return { vfs, db: Database.open('b.db', { vfs, entropy: deterministicEntropy(3) }) };
}
const q = (n: number, ch = 'x'): string => `'${ch.repeat(n)}'`;

describe('REVIEW-BND-001 size boundaries', () => {
  it('TEXT 4000 / 4001 bytes (ASCII, 2-, 3-, 4-byte code points) and empty TEXT', () => {
    const { db } = newDb();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)');
    expect(code(() => db.execute(`INSERT INTO t VALUES (1, ${q(4000)})`))).toBe('ok');
    expect(code(() => db.execute(`INSERT INTO t VALUES (2, ${q(4001)})`))).toBe('TEXT_TOO_LARGE');
    expect(code(() => db.execute(`INSERT INTO t VALUES (3, ${q(2000, 'é')})`))).toBe('ok'); // 4000 bytes
    expect(code(() => db.execute(`INSERT INTO t VALUES (4, '${'é'.repeat(2000)}a')`))).toBe('TEXT_TOO_LARGE');
    expect(code(() => db.execute(`INSERT INTO t VALUES (5, '${'한'.repeat(1333)}a')`))).toBe('ok'); // 4000
    expect(code(() => db.execute(`INSERT INTO t VALUES (6, '${'😀'.repeat(1000)}')`))).toBe('ok'); // 4000
    expect(code(() => db.execute(`INSERT INTO t VALUES (7, '${'😀'.repeat(1000)}a')`))).toBe('TEXT_TOO_LARGE');
    expect(code(() => db.execute("INSERT INTO t VALUES (8, '')"))).toBe('ok');
    const r = db.execute("SELECT id FROM t WHERE s = '' ORDER BY id");
    expect(r.kind === 'rows' && r.rows).toEqual([[8]]);
    const e = db.execute('SELECT s FROM t WHERE id = 6');
    expect(e.kind === 'rows' && e.rows[0]?.[0]).toBe('😀'.repeat(1000));
    expect(db.integrityCheck().issues).toEqual([]);
    db.close();
  });

  it('row of exactly 4060 encoded bytes fits; 4061 is ROW_TOO_LARGE (INSERT and UPDATE)', () => {
    const { db } = newDb();
    // encoded = 1 (count) + 1 (bitmap) + (2 + a) + (2 + b) = 6 + a + b
    db.execute('CREATE TABLE t (a TEXT, b TEXT)');
    expect(code(() => db.execute(`INSERT INTO t VALUES (${q(4000)}, ${q(54)})`))).toBe('ok');
    expect(code(() => db.execute(`INSERT INTO t VALUES (${q(4000)}, ${q(55)})`))).toBe('ROW_TOO_LARGE');
    expect(code(() => db.execute(`INSERT INTO t VALUES ('s', 's')`))).toBe('ok');
    expect(code(() => db.execute(`UPDATE t SET a = ${q(4000)}, b = ${q(55)} WHERE a = 's'`))).toBe('ROW_TOO_LARGE');
    expect(code(() => db.execute(`UPDATE t SET a = ${q(4000)}, b = ${q(54)} WHERE a = 's'`))).toBe('ok'); // grows + moves
    const r = db.execute('SELECT b FROM t');
    expect(r.kind === 'rows' && r.rows.map((x) => (x[0] as string).length).sort()).toEqual([54, 54]);
    expect(db.integrityCheck().issues).toEqual([]);
    db.close();
  });

  it('grow every row of a full page to the maximum size one by one (moves) and shrink back, with an index', () => {
    const { db, vfs } = newDb();
    db.executeScript('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT); CREATE INDEX tb ON t (b);');
    db.execute('BEGIN');
    for (let i = 0; i < 300; i++) db.execute(`INSERT INTO t VALUES (${i}, 'a', 'k${i % 7}')`);
    db.execute('COMMIT');
    for (let i = 0; i < 300; i += 3) {
      // 1 + 1 + 8 + (2 + 3990) + (2 + len(b)) ≤ 4060
      db.execute(`UPDATE t SET a = ${q(3990, 'g')} WHERE id = ${i}`);
    }
    db.execute(`UPDATE t SET a = 'x' WHERE id < 150`);
    const r = db.execute("SELECT COUNT_PLACEHOLDER FROM t".replace('COUNT_PLACEHOLDER', 'id') + " WHERE b = 'k3'");
    const r2 = db.execute("SELECT id FROM t WHERE b = 'k3'", { forceSeqScan: true });
    expect(r.kind === 'rows' && r.rows.map((x) => x[0]).sort()).toEqual(r2.kind === 'rows' && r2.rows.map((x) => x[0]).sort());
    expect(db.integrityCheck().issues).toEqual([]);
    db.close();
    const again = Database.open('b.db', { vfs, entropy: deterministicEntropy(3) });
    expect(again.integrityCheck().issues).toEqual([]);
    const pager = (again as unknown as { pager: Pager }).pager;
    expect(pager.pageCount).toBeGreaterThan(100);
    again.close();
  });

  it('TEXT index keys: 512 bytes ok, 513 KEY_TOO_LARGE, multibyte boundary', () => {
    const { db } = newDb();
    db.executeScript('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT); CREATE INDEX ts ON t (s);');
    expect(code(() => db.execute(`INSERT INTO t VALUES (1, ${q(512)})`))).toBe('ok');
    expect(code(() => db.execute(`INSERT INTO t VALUES (2, ${q(513)})`))).toBe('KEY_TOO_LARGE');
    expect(code(() => db.execute(`INSERT INTO t VALUES (3, '${'😀'.repeat(128)}')`))).toBe('ok');
    expect(code(() => db.execute(`INSERT INTO t VALUES (4, '${'😀'.repeat(128)}a')`))).toBe('KEY_TOO_LARGE');
    expect(code(() => db.execute(`UPDATE t SET s = ${q(513)} WHERE id = 1`))).toBe('KEY_TOO_LARGE');
    // DEC-006: a > 512-byte literal is not an index bound, so the query succeeds with and without the index
    const r = db.execute(`SELECT id FROM t WHERE s = ${q(600)}`);
    expect(r.kind === 'rows' && r.rows).toEqual([]);
    const r2 = db.execute(`SELECT id FROM t WHERE s < ${q(600)} ORDER BY id`);
    const r3 = db.execute(`SELECT id FROM t WHERE s < ${q(600)} ORDER BY id`, { forceSeqScan: true });
    expect(r2).toEqual(r3);
    db.close();
  });
});
