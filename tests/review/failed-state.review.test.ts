import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { FaultVfs } from '../../src/storage/fault-vfs.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { PAGE_SIZE, PageType } from '../../src/storage/layout.js';
import { deterministicEntropy } from '../support/db.js';

/** REVIEW-ERR-001: FAILED-state API surface, IO_COMMIT_UNKNOWN, and auto-checkpoint failure attribution (DC-26/49). */

function err(f: () => unknown): MiniDbError | 'ok' {
  try {
    f();
    return 'ok';
  } catch (e) {
    if (e instanceof MiniDbError) return e;
    throw e;
  }
}
const codeOf = (x: MiniDbError | 'ok'): string => (x === 'ok' ? 'ok' : x.code);

describe('REVIEW-ERR-001 FAILED state', () => {
  it('after a CorruptionError every API except close() is refused; record what stats() does', () => {
    const vfs = new MemoryVfs();
    let db = Database.open('f.db', { vfs, entropy: deterministicEntropy(1) });
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)');
    db.execute('BEGIN');
    for (let i = 0; i < 100; i++) db.execute(`INSERT INTO t VALUES (${i}, '${'x'.repeat(200)}')`);
    db.execute('COMMIT');
    db.close();
    const bytes = vfs.fileBytes('f.db');
    // flip a byte inside the last heap page (not a catalog/table root, so open still succeeds)
    let victim = 0;
    for (let id = 3; id < bytes.length / PAGE_SIZE; id++) if (bytes[id * PAGE_SIZE] === PageType.HEAP) victim = id;
    expect(victim).toBeGreaterThan(3);
    bytes[victim * PAGE_SIZE + 4000] = (bytes[victim * PAGE_SIZE + 4000] as number) ^ 1;
    vfs.setFileBytes('f.db', bytes);
    db = Database.open('f.db', { vfs, entropy: deterministicEntropy(1) });
    expect(codeOf(err(() => db.execute('SELECT * FROM t')))).toBe('PAGE_CHECKSUM_MISMATCH');
    expect(db.state).toBe('failed');
    expect(codeOf(err(() => db.execute('SELECT 1 FROM t')))).toBe('DB_FAILED');
    expect(codeOf(err(() => db.executeScript('SELECT * FROM t')))).toBe('DB_FAILED');
    expect(codeOf(err(() => db.schema()))).toBe('DB_FAILED');
    expect(codeOf(err(() => db.integrityCheck()))).toBe('DB_FAILED');
    expect(codeOf(err(() => db.checkpoint()))).toBe('DB_FAILED');
    const cause = err(() => db.execute('SELECT * FROM t'));
    expect(cause !== 'ok' && (cause.cause as MiniDbError).code).toBe('PAGE_CHECKSUM_MISMATCH');
    // DC-49 says every call except close() is refused; stats()/resetStats() are not (recorded as a doc finding)
    expect(codeOf(err(() => db.stats()))).toBe('ok');
    expect(codeOf(err(() => db.resetStats()))).toBe('ok');
    expect(codeOf(err(() => db.close()))).toBe('ok');
    expect(db.state).toBe('closed');
    expect(codeOf(err(() => db.execute('SELECT * FROM t')))).toBe('DB_CLOSED');
  });

  it('commit fsync failure → IO_COMMIT_UNKNOWN, FAILED; reopen sees either state, integrity ok', () => {
    const probeBase = new MemoryVfs();
    const probe = new FaultVfs(probeBase);
    const p = Database.open('c.db', { vfs: probe, entropy: deterministicEntropy(1) });
    p.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const before = probe.opCount;
    p.execute('INSERT INTO t VALUES (1)');
    const syncOp = probe.opLog.slice(before).find((o) => o.kind === 'sync');
    p.close();
    const base = new MemoryVfs();
    const fv = new FaultVfs(base, { failAtOp: syncOp?.seq as number });
    const db = Database.open('c.db', { vfs: fv, entropy: deterministicEntropy(1) });
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const e = err(() => db.execute('INSERT INTO t VALUES (1)'));
    expect(codeOf(e)).toBe('IO_COMMIT_UNKNOWN');
    expect(db.state).toBe('failed');
    expect(codeOf(err(() => db.execute('INSERT INTO t VALUES (2)')))).toBe('DB_FAILED');
    db.close();
    for (const policy of ['durable-only', 'all-pending'] as const) {
      const again = Database.open('c.db', { vfs: base.crashImage(policy), entropy: deterministicEntropy(1) });
      const r = again.execute('SELECT id FROM t');
      expect([[], [[1]]]).toContainEqual(r.kind === 'rows' ? r.rows : null);
      expect(again.integrityCheck().issues).toEqual([]);
      again.close();
    }
  });

  it('auto-checkpoint failure is reported by the NEXT statement, never by the commit that made it due', () => {
    const opts = { walAutoCheckpointFrames: 2, entropy: deterministicEntropy(1) };
    const probe = new FaultVfs(new MemoryVfs());
    const p = Database.open('a.db', { ...opts, vfs: probe });
    p.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    p.execute('INSERT INTO t VALUES (1)'); // commit makes a checkpoint due
    const before = probe.opCount;
    p.execute('SELECT * FROM t'); // runs the due checkpoint first
    const firstDataWrite = probe.opLog.slice(before).find((o) => o.kind === 'write' && o.file === 'a.db');
    expect(firstDataWrite).toBeDefined();
    p.close();

    const base = new MemoryVfs();
    const db = Database.open('a.db', { ...opts, vfs: new FaultVfs(base, { failAtOp: firstDataWrite?.seq as number }) });
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(codeOf(err(() => db.execute('INSERT INTO t VALUES (1)')))).toBe('ok'); // acknowledged
    expect(codeOf(err(() => db.execute('SELECT * FROM t')))).toBe('IO_ERROR');
    expect(db.state).toBe('failed');
    db.close();
    const again = Database.open('a.db', { ...opts, vfs: base.crashImage('durable-only') });
    const r = again.execute('SELECT id FROM t');
    expect(r.kind === 'rows' && r.rows).toEqual([[1]]);
    expect(again.integrityCheck().issues).toEqual([]);
    again.close();
  });
});
