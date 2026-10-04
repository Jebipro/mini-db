import { afterEach, expect } from 'vitest';
import { Database, type ExecResult, type OpenOptions } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import type { Value } from '../../src/record/value.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { createRng } from '../../src/util/prng.js';

/**
 * Database test harness. Every database opened through `openDb` is integrity-checked and closed after the
 * test (T-INTEG-001) unless the test closed it or it is FAILED.
 */
const open: Database[] = [];

afterEach(() => {
  const dbs = open.splice(0);
  for (const db of dbs) {
    if (db.state !== 'open') continue;
    if (db.inTransaction) db.execute('ROLLBACK');
    const report = db.integrityCheck();
    expect(report.issues, 'T-INTEG-001 integrity after test').toEqual([]);
    db.close();
  }
});

export function deterministicEntropy(seed = 99): (n: number) => Uint8Array {
  const r = createRng(seed);
  return (n) => r.bytes(n);
}

export function openDb(vfs: MemoryVfs = new MemoryVfs(), opts: OpenOptions = {}, path = 'test.db'): { db: Database; vfs: MemoryVfs } {
  const db = Database.open(path, { vfs, entropy: deterministicEntropy(), ...opts });
  open.push(db);
  return { db, vfs };
}

export function memDb(opts: OpenOptions = {}): Database {
  return openDb(new MemoryVfs(), opts).db;
}

export function rows(db: Database, sql: string, forceSeqScan = false): Value[][] {
  const r = db.execute(sql, { forceSeqScan });
  if (r.kind !== 'rows') throw new Error(`not a query: ${sql}`);
  return r.rows;
}

export function run(db: Database, script: string): ExecResult[] {
  return db.executeScript(script);
}

export function errOf(fn: () => unknown): MiniDbError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MiniDbError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

/** Rows sorted for order-insensitive comparison. */
export function sorted(r: Value[][]): Value[][] {
  return [...r].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}
