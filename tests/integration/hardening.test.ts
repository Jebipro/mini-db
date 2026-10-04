import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { FaultVfs } from '../../src/storage/fault-vfs.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { deterministicEntropy, errOf, memDb, openDb, rows, run } from '../support/db.js';

/** P15 adversarial checks: boundaries and error paths not covered elsewhere. */
describe('hardening', () => {
  it('T-EXEC-008 checkpoint() and integrityCheck() are refused inside an explicit transaction', () => {
    const db = memDb();
    db.execute('BEGIN');
    expect(errOf(() => db.checkpoint()).code).toBe('TXN_ACTIVE');
    expect(errOf(() => db.integrityCheck()).code).toBe('TXN_ACTIVE');
    db.execute('COMMIT');
    db.checkpoint();
  });

  it('T-LIM-001 invalid open options are UsageError INVALID_OPTION', () => {
    for (const opts of [{ cachePages: 10 }, { cachePages: 1.5 }, { cachePages: 2_000_000 }, { walAutoCheckpointFrames: -1 }]) {
      const e = errOf(() => Database.open('x.db', { vfs: new MemoryVfs(), ...opts }));
      expect([e.name, e.code]).toEqual(['UsageError', 'INVALID_OPTION']);
    }
  });

  it('T-EXEC-006 empty tables and empty indexes: queries, updates and deletes are no-ops', () => {
    const db = memDb();
    run(db, 'CREATE TABLE e (id INTEGER PRIMARY KEY, s TEXT); CREATE INDEX es ON e (s)');
    expect(rows(db, "SELECT * FROM e WHERE s = 'x'")).toEqual([]);
    expect(rows(db, 'SELECT * FROM e WHERE id > 0 ORDER BY id LIMIT 3 OFFSET 1')).toEqual([]);
    expect(db.execute('UPDATE e SET s = NULL')).toEqual({ kind: 'changes', command: 'UPDATE', changes: 0 });
    expect(db.execute('DELETE FROM e WHERE id = 1')).toEqual({ kind: 'changes', command: 'DELETE', changes: 0 });
    db.execute("INSERT INTO e VALUES (1, 'only')");
    expect(rows(db, "SELECT id FROM e WHERE s >= 'only' AND s <= 'only'")).toEqual([[1]]);
    db.execute('DELETE FROM e');
    expect(rows(db, "SELECT id FROM e WHERE s = 'only'")).toEqual([]);
  });

  it('T-IDX-004 hundreds of equal keys through SQL with ORDER BY and LIMIT', () => {
    const db = memDb();
    run(db, 'CREATE TABLE d (id INTEGER PRIMARY KEY, k INTEGER); CREATE INDEX dk ON d (k)');
    db.execute('BEGIN');
    for (let i = 0; i < 400; i++) db.execute(`INSERT INTO d VALUES (${i}, ${i % 3})`);
    db.execute('COMMIT');
    expect(rows(db, 'SELECT id FROM d WHERE k = 1').length).toBe(133);
    expect(rows(db, 'SELECT id FROM d WHERE k = 1 ORDER BY id DESC LIMIT 2 OFFSET 1')).toEqual([[394], [391]]);
    db.execute('DELETE FROM d WHERE k = 1');
    expect(rows(db, 'SELECT id FROM d WHERE k >= 1').length).toBe(133);
  });

  it('T-FAIL-003 a read I/O error during a SQL query fails only that statement', () => {
    const base = new MemoryVfs();
    const seed = Database.open('r.db', { vfs: base, entropy: deterministicEntropy(1) });
    run(seed, 'CREATE TABLE t (a TEXT)');
    for (let i = 0; i < 120; i++) seed.execute(`INSERT INTO t VALUES ('${'x'.repeat(3000)}')`);
    seed.close();
    const probe = new FaultVfs(base.crashImage('all-pending'));
    Database.open('r.db', { vfs: probe, cachePages: 64 }).close();
    const fv = new FaultVfs(base.crashImage('all-pending'), { failReadAt: probe.readCount + 20 });
    const db = Database.open('r.db', { vfs: fv, cachePages: 64 });
    const e = errOf(() => db.execute('SELECT * FROM t'));
    expect(e.code).toBe('IO_ERROR');
    expect(db.state).toBe('open');
    expect(rows(db, 'SELECT * FROM t').length).toBe(120);
    db.execute("INSERT INTO t VALUES ('after')");
    db.close();
  });

  it('T-CAT-004 pages freed by DROP TABLE are reused after reopen; the file does not grow', () => {
    const vfs = new MemoryVfs();
    let db = openDb(vfs).db;
    run(db, 'CREATE TABLE big (id INTEGER PRIMARY KEY, s TEXT)');
    db.execute('BEGIN');
    for (let i = 0; i < 100; i++) db.execute(`INSERT INTO big VALUES (${i}, '${'b'.repeat(1000)}')`);
    db.execute('COMMIT');
    db.execute('DROP TABLE big');
    const before = db.integrityCheck().summary;
    expect(before.freePages).toBeGreaterThan(20);
    db.close();
    db = openDb(vfs).db;
    run(db, 'CREATE TABLE again (id INTEGER PRIMARY KEY, s TEXT)');
    db.execute('BEGIN');
    for (let i = 0; i < 100; i++) db.execute(`INSERT INTO again VALUES (${i}, '${'c'.repeat(1000)}')`);
    db.execute('COMMIT');
    const after = db.integrityCheck().summary;
    expect(after.pageCount).toBe(before.pageCount);
  });
});
