import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorruptionError, MiniDbError, StorageError } from '../../src/errors/errors.js';
import { FaultVfs } from '../../src/storage/fault-vfs.js';
import { PAGE_SIZE } from '../../src/storage/layout.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { NodeVfs } from '../../src/storage/node-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import type { Vfs } from '../../src/storage/vfs.js';
import { allocWithPayload, inTxn, openPager, payloadOf, readPayload, writePayload } from '../support/pager-harness.js';
import { useTmpDir } from '../support/tmp.js';

const tmp = useTmpDir();

function errOf(fn: () => unknown): MiniDbError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MiniDbError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

/** S: page 1 payload 1. Returns the pager after one committed transaction. */
function setup(vfs: Vfs, opts = {}): Pager {
  const p = openPager(vfs, 'db', opts);
  inTxn(p, () => allocWithPayload(p, payloadOf(1)));
  return p;
}

describe('pager robustness', () => {
  it('T-FAIL-001 commit fsync failure → IO_COMMIT_UNKNOWN, FAILED, close works, reopen sees S or S⁺', () => {
    const probe = new FaultVfs(new MemoryVfs());
    setup(probe);
    const n0 = probe.opCount;
    // next txn rewrites page 1: op n0+1 = frame write, n0+2 = WAL fsync
    for (const failAt of [n0 + 1, n0 + 2]) {
      const base = new MemoryVfs();
      const fv = new FaultVfs(base, { failAtOp: failAt });
      const p = setup(fv);
      p.beginTxn();
      p.beginStatement();
      writePayload(p, 1, payloadOf(2));
      p.releaseStatement();
      const e = errOf(() => p.commitTxn());
      expect(e).toBeInstanceOf(StorageError);
      expect(e.code).toBe('IO_COMMIT_UNKNOWN');
      expect(p.state).toBe('failed');
      const after = errOf(() => p.pin(1));
      expect(after.code).toBe('DB_FAILED');
      expect((after.cause as MiniDbError).code).toBe('IO_COMMIT_UNKNOWN');
      const opsBeforeClose = fv.opCount;
      p.close();
      expect(fv.opCount).toBe(opsBeforeClose); // FAILED close writes nothing
      const q = openPager(base);
      expect([1, 2]).toContain(readPayload(q, 1)[0]);
      q.close();
    }
  });

  it('T-FAIL-002 checkpoint write failure → FAILED; reopen recovers S from the WAL', () => {
    const probe = new FaultVfs(new MemoryVfs());
    setup(probe);
    const n0 = probe.opCount;
    const base = new MemoryVfs();
    const fv = new FaultVfs(base, { failAtOp: n0 + 1 });
    const p = setup(fv);
    const e = errOf(() => p.checkpoint());
    expect(e.code).toBe('IO_ERROR');
    expect(p.state).toBe('failed');
    p.close();
    const q = openPager(base);
    expect(readPayload(q, 1)).toEqual(payloadOf(1));
    q.close();
  });

  it('T-FAIL-003 a read I/O error fails only the operation; the pager stays usable', () => {
    const base = new MemoryVfs();
    setup(base).close();
    const probe = new FaultVfs(base.crashImage('all-pending'));
    openPager(probe).close();
    const readsAtOpen = probe.readCount;
    const fv = new FaultVfs(base.crashImage('all-pending'), { failReadAt: readsAtOpen + 1 });
    const p = openPager(fv);
    // the open consumed the same reads as the probe minus close; page 1 is not cached yet
    expect(fv.readCount).toBeLessThanOrEqual(readsAtOpen);
    let failed = false;
    for (let i = 0; i < 3 && !failed; i++) {
      try {
        readPayload(p, 1);
      } catch (e) {
        expect((e as MiniDbError).code).toBe('IO_ERROR');
        failed = true;
      }
    }
    expect(failed).toBe(true);
    expect(p.state).toBe('open');
    expect(readPayload(p, 1)).toEqual(payloadOf(1));
    p.close();
  });

  it('T-FAIL-004 CorruptionError on a page read puts the pager in FAILED', () => {
    const vfs = new MemoryVfs();
    setup(vfs).close();
    const bytes = vfs.fileBytes('db');
    bytes[PAGE_SIZE + 100] = (bytes[PAGE_SIZE + 100] as number) ^ 1;
    vfs.setFileBytes('db', bytes);
    const p = openPager(vfs);
    const e = errOf(() => readPayload(p, 1));
    expect(e).toBeInstanceOf(CorruptionError);
    expect(e.code).toBe('PAGE_CHECKSUM_MISMATCH');
    expect(p.state).toBe('failed');
    expect(errOf(() => readPayload(p, 0)).code).toBe('DB_FAILED');
    p.close();
  });

  it('T-PGR-013 auto-checkpoint becomes due at the threshold and runs only outside a transaction', () => {
    const vfs = new MemoryVfs();
    const p = openPager(vfs, 'db', { walAutoCheckpointFrames: 3 });
    inTxn(p, () => allocWithPayload(p, payloadOf(1))); // 2 frames (page 0, page 1)
    expect(p.checkpointDue).toBe(false);
    inTxn(p, () => writePayload(p, 1, payloadOf(2))); // 3 frames
    expect(p.checkpointDue).toBe(true);
    p.beginTxn();
    p.maybeCheckpoint();
    expect(p.stats().txn.checkpoints).toBe(1); // only the bootstrap checkpoint so far
    p.rollbackTxn();
    p.maybeCheckpoint();
    expect(p.stats().txn.checkpoints).toBe(2);
    expect(p.checkpointDue).toBe(false);
    expect(p.stats().wal.frames).toBe(0);
    p.close();

    const q = openPager(new MemoryVfs(), 'db', { walAutoCheckpointFrames: 0 });
    for (let i = 0; i < 10; i++) inTxn(q, () => allocWithPayload(q, payloadOf(i)));
    expect(q.checkpointDue).toBe(false);
    q.close();
  });

  it('T-PGR-016 MemoryVfs and NodeVfs produce byte-identical files for the same operations', () => {
    const dir = tmp();
    const run = (vfs: Vfs, path: string): void => {
      const p = openPager(vfs, path);
      inTxn(p, () => {
        for (let i = 1; i <= 5; i++) allocWithPayload(p, payloadOf(i));
      });
      inTxn(p, () => p.free(3));
      p.checkpoint();
      inTxn(p, () => writePayload(p, 2, payloadOf(9)));
      // leave the WAL non-empty: compare before close as well
      p.close();
    };
    const mem = new MemoryVfs();
    run(mem, 'db');
    const path = join(dir, 'db');
    run(new NodeVfs(), path);
    expect(new Uint8Array(readFileSync(path))).toEqual(mem.fileBytes('db'));
    expect(new Uint8Array(readFileSync(`${path}-wal`))).toEqual(mem.fileBytes('db-wal'));
  });

  it('T-STAT-001 fsync counts: write commit = 1 WAL sync, read-only = 0, checkpoint = 1 data + 2 WAL', () => {
    const p = setup(new MemoryVfs());
    p.resetStats();
    inTxn(p, () => writePayload(p, 1, payloadOf(3)));
    expect(p.stats().io.walSyncs).toBe(1);
    expect(p.stats().io.dataSyncs).toBe(0);
    p.resetStats();
    inTxn(p, () => readPayload(p, 1));
    expect(p.stats().io.walSyncs + p.stats().io.dataSyncs).toBe(0);
    p.resetStats();
    p.checkpoint();
    expect(p.stats().io).toMatchObject({ dataSyncs: 1, walSyncs: 2, walTruncates: 1 });
    expect(p.stats().txn.checkpoints).toBe(1);
    p.close();
  });
});
