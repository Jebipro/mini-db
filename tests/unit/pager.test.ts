import { describe, expect, it } from 'vitest';
import { CorruptionError, InternalError, LimitError, MiniDbError, StorageError } from '../../src/errors/errors.js';
import { PAGE_SIZE, PageType, WAL_HEADER_SIZE } from '../../src/storage/layout.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { pageTypeOf } from '../../src/storage/page.js';
import {
  allocWithPayload,
  inTxn,
  newMemPager,
  openPager,
  pageBytes,
  payloadOf,
  readPayload,
  writePayload,
} from '../support/pager-harness.js';

function errOf(fn: () => unknown): MiniDbError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MiniDbError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

describe('pager', () => {
  it('T-PGR-001 creates a new database via the initialize hook and reopens it', () => {
    const vfs = new MemoryVfs();
    const p = openPager(vfs, 'db', {
      initialize: (pg) => {
        const ref = pg.allocate(PageType.HEAP);
        pg.unpin(ref);
        pg.setRootPointer(ref.id);
      },
    });
    expect(p.pageCount).toBe(2);
    expect(p.getRootPointer()).toBe(1);
    expect(vfs.fileBytes('db').length).toBe(2 * PAGE_SIZE);
    expect(vfs.fileBytes('db-wal').length).toBe(WAL_HEADER_SIZE);
    const dbId = p.dbId;
    p.close();
    const q = openPager(vfs);
    expect(q.pageCount).toBe(2);
    expect(q.getRootPointer()).toBe(1);
    expect(q.dbId).toEqual(dbId);
    expect(pageTypeOf(pageBytes(q, 1))).toBe(PageType.HEAP);
    q.close();
  });

  it('T-PGR-002 cache hit/miss counters and LRU eviction of clean pages', () => {
    const { vfs, pager } = newMemPager();
    inTxn(pager, () => {
      for (let i = 1; i <= 100; i++) allocWithPayload(pager, payloadOf(i));
    });
    pager.close();
    const p = openPager(vfs, 'db', { cachePages: 64 });
    p.resetStats();
    for (let id = 1; id <= 70; id++) readPayload(p, id);
    let s = p.stats();
    expect(s.cache.misses).toBe(70);
    expect(s.cache.hits).toBe(0);
    expect(s.cache.cached).toBe(64);
    expect(s.cache.evictions).toBe(7); // 1 (page 0) + 70 pages - 64 frames
    expect(p.isCached(1)).toBe(false); // least recently used went first
    expect(p.isCached(7)).toBe(false);
    expect(p.isCached(8)).toBe(true);
    readPayload(p, 70);
    s = p.stats();
    expect(s.cache.hits).toBe(1);
    expect(readPayload(p, 1)).toEqual(payloadOf(1));
    expect(p.stats().cache.misses).toBe(71);
    p.close();
  });

  it('T-PGR-003 pinned pages are never evicted; unpin underflow is an InternalError', () => {
    const { vfs, pager } = newMemPager();
    inTxn(pager, () => {
      for (let i = 1; i <= 100; i++) allocWithPayload(pager, payloadOf(i));
    });
    pager.close();
    const p = openPager(vfs, 'db', { cachePages: 64 });
    const held = p.pin(1);
    for (let id = 2; id <= 100; id++) readPayload(p, id);
    expect(p.isCached(1)).toBe(true);
    p.unpin(held);
    expect(errOf(() => p.unpin(held))).toBeInstanceOf(InternalError);
    p.close();
  });

  it('T-PGR-004 a pin left at statement end is an InternalError and fails the pager', () => {
    const { pager } = newMemPager();
    let id = 0;
    inTxn(pager, () => {
      id = allocWithPayload(pager, payloadOf(1));
    });
    pager.beginTxn();
    pager.beginStatement();
    pager.pin(id);
    const e = errOf(() => pager.releaseStatement());
    expect(e).toBeInstanceOf(InternalError);
    expect(pager.state).toBe('failed');
    expect(errOf(() => pager.pin(id)).code).toBe('DB_FAILED');
    pager.close();
  });

  it('T-PGR-005 allocate/free/reuse through the freelist', () => {
    const { pager: p } = newMemPager();
    const ids = inTxn(p, () => [1, 2, 3, 4].map((i) => allocWithPayload(p, payloadOf(i))));
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(p.pageCount).toBe(5);
    inTxn(p, () => {
      p.free(2);
      p.free(4);
    });
    expect(p.freelistCount).toBe(2);
    expect(p.freelistPages()).toEqual([4, 2]);
    const ref = p.pin(4);
    expect(pageTypeOf(ref.data)).toBe(PageType.FREE);
    p.unpin(ref);
    const reused = inTxn(p, () => [allocWithPayload(p, payloadOf(9)), allocWithPayload(p, payloadOf(8)), allocWithPayload(p, payloadOf(7))]);
    expect(reused).toEqual([4, 2, 5]);
    expect(p.freelistCount).toBe(0);
    expect(p.pageCount).toBe(6);
    expect(readPayload(p, 4)).toEqual(payloadOf(9));
    expect(errOf(() => inTxn(p, () => p.free(0)))).toBeInstanceOf(InternalError);
    p.close();
  });

  it('T-PGR-006 committed data survives losing the handle (recovery path)', () => {
    const { vfs, pager } = newMemPager();
    inTxn(pager, () => allocWithPayload(pager, payloadOf(5)));
    inTxn(pager, () => writePayload(pager, 1, payloadOf(6)));
    expect(pager.walFrameOf(1)).toBeDefined();
    for (const policy of ['durable-only', 'all-pending'] as const) {
      const img = vfs.crashImage(policy);
      const q = openPager(img);
      expect(q.stats().recovery.txnsApplied).toBe(2);
      expect(readPayload(q, 1)).toEqual(payloadOf(6));
      expect(img.fileBytes('db-wal').length).toBe(WAL_HEADER_SIZE);
      q.close();
    }
  });

  it('T-PGR-007 transaction rollback restores every page including the header; page 0 stays resident', () => {
    const { pager: p } = newMemPager();
    inTxn(p, () => {
      allocWithPayload(p, payloadOf(1));
      allocWithPayload(p, payloadOf(2));
    });
    const before = p.headerFields();
    const hdrBytes = pageBytes(p, 0);
    p.beginTxn();
    p.beginStatement();
    writePayload(p, 1, payloadOf(9));
    allocWithPayload(p, payloadOf(3));
    p.free(2);
    p.releaseStatement();
    p.resetStats();
    p.rollbackTxn();
    expect(p.headerFields()).toEqual(before);
    expect(p.isCached(0)).toBe(true);
    expect(pageBytes(p, 0)).toEqual(hdrBytes);
    expect(p.stats().cache.misses).toBe(0);
    expect(p.stats().cache.dirty).toBe(0);
    expect(readPayload(p, 1)).toEqual(payloadOf(1));
    expect(readPayload(p, 2)).toEqual(payloadOf(2));
    expect(p.pageCount).toBe(3);
    p.close();
  });

  it('T-PGR-008 statement rollback keeps earlier transaction changes and restores page 0 in place', () => {
    const { pager: p } = newMemPager();
    inTxn(p, () => allocWithPayload(p, payloadOf(1)));
    const committedHdr = pageBytes(p, 0);

    // (b) page 0 first dirtied inside the failing statement → restored to the committed image, clean
    p.beginTxn();
    p.beginStatement();
    writePayload(p, 1, payloadOf(2)); // page 1 first dirtied in the statement → discarded
    allocWithPayload(p, payloadOf(3)); // dirties page 0 and a new page 2
    p.rollbackStatement();
    expect(p.isCached(0)).toBe(true);
    expect(pageBytes(p, 0)).toEqual(committedHdr);
    expect(p.stats().cache.dirty).toBe(0);
    expect(p.pageCount).toBe(2);
    expect(readPayload(p, 1)).toEqual(payloadOf(1));

    // (a) page 0 already dirty before the statement → restored to the pre-statement image, still dirty
    p.beginStatement();
    allocWithPayload(p, payloadOf(4)); // page 2, pageCount 3
    writePayload(p, 1, payloadOf(5));
    p.releaseStatement();
    const preStmtHdr = pageBytes(p, 0);
    p.beginStatement();
    allocWithPayload(p, payloadOf(6)); // page 3, pageCount 4
    writePayload(p, 1, payloadOf(7));
    writePayload(p, 2, payloadOf(8));
    p.rollbackStatement();
    expect(pageBytes(p, 0)).toEqual(preStmtHdr);
    expect(p.pageCount).toBe(3);
    expect(readPayload(p, 1)).toEqual(payloadOf(5));
    expect(readPayload(p, 2)).toEqual(payloadOf(4));
    expect(p.stats().cache.dirty).toBe(3);
    p.commitTxn();
    expect(readPayload(p, 2)).toEqual(payloadOf(4));
    expect(p.pageCount).toBe(3);
    p.close();
  });

  it('T-PGR-009 read precedence: dirty cache > WAL index > data file', () => {
    const vfs = new MemoryVfs();
    let p = openPager(vfs, 'db');
    inTxn(p, () => {
      for (let i = 1; i <= 80; i++) allocWithPayload(p, payloadOf(1));
    });
    p.close(); // checkpoint: data file has v1
    p = openPager(vfs, 'db', { cachePages: 64 });
    inTxn(p, () => writePayload(p, 1, payloadOf(2))); // WAL has v2
    for (let id = 2; id <= 80; id++) readPayload(p, id); // evict page 1
    expect(p.isCached(1)).toBe(false);
    p.resetStats();
    expect(readPayload(p, 1)).toEqual(payloadOf(2));
    expect(p.stats().io.walFrameReads).toBe(1);
    expect(p.stats().io.dataPageReads).toBe(0);
    p.beginTxn();
    p.beginStatement();
    writePayload(p, 1, payloadOf(3));
    expect(readPayload(p, 1)).toEqual(payloadOf(3));
    p.releaseStatement();
    p.rollbackTxn();
    expect(readPayload(p, 1)).toEqual(payloadOf(2));
    p.close();
    p = openPager(vfs, 'db', { cachePages: 64 });
    expect(readPayload(p, 1)).toEqual(payloadOf(2));
    p.close();
  });

  it('T-PGR-010 checkpoint empties the WAL and the data file alone holds the content', () => {
    const { vfs, pager: p } = newMemPager();
    inTxn(p, () => allocWithPayload(p, payloadOf(1)));
    inTxn(p, () => writePayload(p, 1, payloadOf(2)));
    expect(vfs.fileBytes('db-wal').length).toBeGreaterThan(WAL_HEADER_SIZE);
    p.checkpoint();
    expect(vfs.fileBytes('db-wal').length).toBe(WAL_HEADER_SIZE);
    expect(p.stats().wal.frames).toBe(0);
    const img = vfs.crashImage('durable-only');
    img.deleteFile('db-wal');
    const q = openPager(img);
    expect(readPayload(q, 1)).toEqual(payloadOf(2));
    q.close();
    p.close();
  });

  it('T-PGR-011 dirty-page limit raises TXN_TOO_LARGE, rolls back the statement and keeps the transaction', () => {
    const { pager: p } = newMemPager({ cachePages: 64 });
    p.beginTxn();
    p.beginStatement();
    allocWithPayload(p, payloadOf(1));
    p.releaseStatement();
    p.beginStatement();
    let err: unknown;
    try {
      for (let i = 0; i < 100; i++) allocWithPayload(p, payloadOf(i));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LimitError);
    expect((err as LimitError).code).toBe('TXN_TOO_LARGE');
    p.rollbackStatement();
    expect(p.inTxn()).toBe(true);
    expect(p.pageCount).toBe(2);
    p.beginStatement();
    writePayload(p, 1, payloadOf(7));
    p.releaseStatement();
    p.commitTxn();
    expect(readPayload(p, 1)).toEqual(payloadOf(7));
    expect(p.state).toBe('open');
    p.close();
  });

  it('T-PGR-014 a read-only transaction commits without any write or fsync', () => {
    const { pager: p } = newMemPager();
    inTxn(p, () => allocWithPayload(p, payloadOf(1)));
    p.resetStats();
    inTxn(p, () => readPayload(p, 1));
    const io = p.stats().io;
    expect(io.walFrameWrites + io.walSyncs + io.dataPageWrites + io.dataSyncs).toBe(0);
    p.close();
  });

  it('T-PGR-015 reading a page id ≥ pageCount is PAGE_OUT_OF_RANGE', () => {
    const { pager: p } = newMemPager();
    const e = errOf(() => p.pin(5));
    expect(e).toBeInstanceOf(CorruptionError);
    expect(e.code).toBe('PAGE_OUT_OF_RANGE');
    p.close();
  });

  it('T-WAL-009 WAL dbId mismatch: refuse when it has commits, reset when it has none', () => {
    const a = new MemoryVfs();
    const pa = openPager(a, 'db');
    inTxn(pa, () => allocWithPayload(pa, payloadOf(1)));
    const walWithCommit = a.crashImage('all-pending').fileBytes('db-wal');
    pa.close();
    const walEmpty = a.fileBytes('db-wal');

    const b = new MemoryVfs();
    openPager(b, 'db', { entropy: (n) => new Uint8Array(n).fill(0x5a) }).close();
    const b1 = b.crashImage('all-pending');
    b1.setFileBytes('db-wal', walWithCommit);
    const e = errOf(() => openPager(b1));
    expect(e).toBeInstanceOf(CorruptionError);
    expect(e.code).toBe('WAL_MISMATCH');

    const b2 = b.crashImage('all-pending');
    b2.setFileBytes('db-wal', walEmpty);
    const q = openPager(b2);
    expect(q.pageCount).toBe(1);
    q.close();
    expect(b2.fileBytes('db-wal').length).toBe(WAL_HEADER_SIZE);
  });

  it('T-PGR-004 operations after close are DB_CLOSED; double close is a no-op', () => {
    const { pager: p } = newMemPager();
    p.close();
    p.close();
    expect(errOf(() => p.pin(0)).code).toBe('DB_CLOSED');
    expect(errOf(() => p.beginTxn())).not.toBeInstanceOf(StorageError);
  });
});
