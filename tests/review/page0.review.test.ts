import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { computePageCrc } from '../../src/storage/page.js';
import type { Pager } from '../../src/storage/pager.js';
import { readU32 } from '../../src/util/bytes.js';
import { deterministicEntropy } from '../support/db.js';

/**
 * REVIEW-P0-001: rev1 Page 0 semantics through the public SQL API, with byte-exact checks of the cached
 * page 0 and of the private transaction state (headerBefore, txnDirty, frame.dirty).
 */

interface PagerInternals {
  frames: Map<number, { data: Uint8Array; pins: number; dirty: boolean }>;
  txnDirty: Set<number>;
  headerBefore: Uint8Array | null;
  savepoint: Map<number, Uint8Array | null>;
}

function pagerOf(db: Database): Pager {
  return (db as unknown as { pager: Pager }).pager;
}
function internals(db: Database): PagerInternals {
  return pagerOf(db) as unknown as PagerInternals;
}
function page0(db: Database): Uint8Array {
  return Uint8Array.from((internals(db).frames.get(0) as { data: Uint8Array }).data);
}
function state(db: Database): { dirty: boolean; inTxnDirty: boolean; headerBefore: Uint8Array | null; savepoint: number } {
  const i = internals(db);
  return {
    dirty: (i.frames.get(0) as { dirty: boolean }).dirty,
    inTxnDirty: i.txnDirty.has(0),
    headerBefore: i.headerBefore === null ? null : Uint8Array.from(i.headerBefore),
    savepoint: i.savepoint.size,
  };
}
function fails(db: Database, sql: string, code: string): void {
  let err: unknown;
  try {
    db.execute(sql);
  } catch (e) {
    err = e;
  }
  expect(err instanceof MiniDbError && err.code, sql).toBe(code);
}
const pageCountOf = (b: Uint8Array): number => readU32(b, 28);

function setup(): Database {
  const db = Database.open('p0.db', { vfs: new MemoryVfs(), entropy: deterministicEntropy(5) });
  db.executeScript("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'x');");
  return db;
}

describe('REVIEW-P0-001 page 0 resident semantics', () => {
  it('autocommit commit: page 0 clean, stamped, equal to its WAL image; no txn state left', () => {
    const db = setup();
    const p = pagerOf(db);
    db.execute('CREATE TABLE u (id INTEGER)');
    const s = state(db);
    expect(s).toEqual({ dirty: false, inTxnDirty: false, headerBefore: null, savepoint: 0 });
    const img = page0(db);
    expect(readU32(img, 4)).toBe(computePageCrc(img));
    expect(p.walFrameOf(0)).toBeDefined();
    db.close();
  });

  it('autocommit failure after page 0 was dirtied: byte-identical restore, clean', () => {
    const db = setup();
    const before = page0(db);
    // CREATE UNIQUE INDEX allocates its root (dirtying page 0) and then fails on the duplicate
    fails(db, 'CREATE UNIQUE INDEX t_v ON t (v)', 'UNIQUE_VIOLATION');
    expect(page0(db)).toEqual(before);
    expect(state(db)).toEqual({ dirty: false, inTxnDirty: false, headerBefore: null, savepoint: 0 });
    expect(db.integrityCheck().issues).toEqual([]);
    db.close();
  });

  it('explicit txn: page 0 dirtied in S1, S2 dirties it again and fails → S1 image, still dirty, headerBefore = pre-txn', () => {
    const db = setup();
    const preTxn = page0(db);
    db.execute('BEGIN');
    db.execute('CREATE TABLE w (id INTEGER)');
    const afterS1 = page0(db);
    expect(pageCountOf(afterS1)).toBeGreaterThan(pageCountOf(preTxn));
    fails(db, 'CREATE UNIQUE INDEX t_v ON t (v)', 'UNIQUE_VIOLATION');
    expect(page0(db)).toEqual(afterS1);
    const s = state(db);
    expect(s.dirty).toBe(true);
    expect(s.inTxnDirty).toBe(true);
    expect(s.headerBefore).toEqual(preTxn);
    expect(s.savepoint).toBe(0);
    db.execute('ROLLBACK');
    expect(page0(db)).toEqual(preTxn);
    expect(state(db)).toEqual({ dirty: false, inTxnDirty: false, headerBefore: null, savepoint: 0 });
    expect(db.integrityCheck().issues).toEqual([]);
    db.close();
  });

  it('explicit txn: S1 leaves page 0 alone, S2 first dirties it and fails → pre-txn image, clean, headerBefore null', () => {
    const db = setup();
    const preTxn = page0(db);
    db.execute('BEGIN');
    db.execute("UPDATE t SET v = 'x' WHERE id = 1"); // in place: no allocation, keeps the duplicate
    expect(state(db).inTxnDirty).toBe(false);
    fails(db, 'CREATE UNIQUE INDEX t_v2 ON t (v)', 'UNIQUE_VIOLATION');
    expect(page0(db)).toEqual(preTxn);
    expect(state(db)).toEqual({ dirty: false, inTxnDirty: false, headerBefore: null, savepoint: 0 });
    // S3 dirties page 0 again: headerBefore must be recaptured from the restored (= committed) image
    db.execute('CREATE TABLE z (id INTEGER)');
    expect(state(db).headerBefore).toEqual(preTxn);
    db.execute('COMMIT');
    expect(state(db)).toEqual({ dirty: false, inTxnDirty: false, headerBefore: null, savepoint: 0 });
    expect(db.integrityCheck().issues).toEqual([]);
    db.close();
  });
});
