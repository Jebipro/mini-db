import { describe, expect, it } from 'vitest';
import { CorruptionError } from '../../src/errors/errors.js';
import { FaultVfs, SimulatedCrash } from '../../src/storage/fault-vfs.js';
import { PAGE_SIZE, PageType, WAL_FRAME_SIZE, WAL_HEADER_SIZE, walFrameOffset } from '../../src/storage/layout.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { initPage, stampPageCrc } from '../../src/storage/page.js';
import { createIoStats } from '../../src/storage/stats.js';
import { frameChecksum, readWalHeader, scanWal, WalFile, type WalHeader } from '../../src/storage/wal.js';
import type { StorageFile } from '../../src/storage/vfs.js';
import { readU32, writeU32 } from '../../src/util/bytes.js';
import { crc32 } from '../../src/util/crc32.js';
import { createRng } from '../../src/util/prng.js';

const DB_ID = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);

function page(id: number, fill: number): { id: number; data: Uint8Array } {
  const data = new Uint8Array(PAGE_SIZE);
  initPage(data, PageType.HEAP, id);
  data.fill(fill, 100, 200);
  stampPageCrc(data);
  return { id, data };
}

function entropy(seed: number): (n: number) => Uint8Array {
  const r = createRng(seed);
  return (n) => r.bytes(n);
}

function newWal(file: StorageFile, seed = 1): WalFile {
  return WalFile.reset(file, DB_ID, null, entropy(seed), createIoStats());
}

function header(file: StorageFile): WalHeader {
  const h = readWalHeader(file);
  if (h.kind !== 'valid') throw new Error('expected a valid header');
  return h.header;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CorruptionError) return e.code;
    throw e;
  }
  return 'no error';
}

/** Three committed transactions: {1,2}, {2,3}, {1}. */
function threeTxns(file: StorageFile): WalFile {
  const w = newWal(file);
  w.appendTxn([page(1, 11), page(2, 12)]);
  w.appendTxn([page(2, 22), page(3, 23)]);
  w.appendTxn([page(1, 31)]);
  return w;
}

describe('wal', () => {
  it('T-WAL-001 header roundtrip and an independently computed checksum chain', () => {
    const file = new MemoryVfs().open('w');
    const w = newWal(file);
    expect(file.size()).toBe(WAL_HEADER_SIZE);
    const h = header(file);
    expect(h).toEqual(w.header);
    expect(h.checkpointSeq).toBe(1);
    expect(h.dbId).toEqual(DB_ID);
    const raw = new Uint8Array(WAL_HEADER_SIZE);
    file.read(raw, 0);
    expect(readU32(raw, 44)).toBe(crc32(raw.subarray(0, 44)));

    w.appendTxn([page(1, 1), page(2, 2)]);
    expect(file.size()).toBe(WAL_HEADER_SIZE + 2 * WAL_FRAME_SIZE);
    let prev = h.headerCrc;
    for (let k = 0; k < 2; k++) {
      const f = new Uint8Array(WAL_FRAME_SIZE);
      file.read(f, walFrameOffset(k));
      // independent formula: CRC32(LE32(prev) ‖ frame[0..16) ‖ page)
      const buf = new Uint8Array(4 + 16 + PAGE_SIZE);
      writeU32(buf, 0, prev);
      buf.set(f.subarray(0, 16), 4);
      buf.set(f.subarray(24), 20);
      expect(readU32(f, 16)).toBe(crc32(buf));
      expect(frameChecksum(prev, f, f.subarray(24))).toBe(crc32(buf));
      expect(readU32(f, 4)).toBe(k === 1 ? 1 : 0);
      expect(readU32(f, 8)).toBe(h.salt1);
      expect(readU32(f, 12)).toBe(h.salt2);
      prev = readU32(f, 16);
    }
  });

  it('T-WAL-002 scan returns the latest committed frame per page', () => {
    const file = new MemoryVfs().open('w');
    threeTxns(file);
    const s = scanWal(file, header(file));
    expect([...s.committed.entries()].sort()).toEqual([
      [1, 4],
      [2, 2],
      [3, 3],
    ]);
    expect(s.txnsApplied).toBe(3);
    expect(s.committedFrames).toBe(5);
    expect(s.discardedTailBytes).toBe(0);
  });

  it('T-WAL-003 a transaction without its COMMIT frame is ignored', () => {
    const base = new MemoryVfs();
    // ops: truncate, sync, header write, sync, txn1 (2 writes + sync), txn2 frame 1 write, txn2 frame 2 write (crash)
    const fv = new FaultVfs(base, { crashAtOp: 9 });
    const file = fv.open('w');
    const w = newWal(file);
    w.appendTxn([page(1, 1), page(2, 2)]);
    expect(() => w.appendTxn([page(3, 3), page(4, 4)])).toThrow(SimulatedCrash);
    const img = base.crashImage('all-pending').open('w');
    const s = scanWal(img, header(img));
    expect([...s.committed.keys()].sort()).toEqual([1, 2]);
    expect(s.framesScanned).toBe(3);
    expect(s.discardedTailBytes).toBe(WAL_FRAME_SIZE);
  });

  it('T-WAL-004 a torn last frame leaves only the previous transactions', () => {
    // ops: reset = truncate(1) sync(2) header(3) sync(4); txn1 = write(5) sync(6); txn2 = write(7) sync(8); txn3 write = 9
    for (const torn of [1, 511, 512, 4096, WAL_FRAME_SIZE - 1]) {
      const base = new MemoryVfs();
      const fv = new FaultVfs(base, { crashAtOp: 9, tornBytes: torn });
      const file = fv.open('w');
      const w = newWal(file);
      w.appendTxn([page(1, 1)]);
      w.appendTxn([page(2, 2)]);
      expect(() => w.appendTxn([page(3, 3)])).toThrow(SimulatedCrash);
      for (const policy of ['all-pending', 'torn-only'] as const) {
        const img = base.crashImage(policy).open('w');
        const s = scanWal(img, header(img));
        expect([...s.committed.keys()].sort(), `${policy} torn=${torn}`).toEqual([1, 2]);
      }
    }
  });

  it('T-WAL-005 a frame with foreign salts stops the scan even if its checksum is consistent', () => {
    const file = new MemoryVfs().open('w');
    threeTxns(file);
    const h = header(file);
    // rewrite frame 2 (txn 2, first frame) with a different salt1 and a recomputed checksum
    const f1 = new Uint8Array(WAL_FRAME_SIZE);
    file.read(f1, walFrameOffset(1));
    const f2 = new Uint8Array(WAL_FRAME_SIZE);
    file.read(f2, walFrameOffset(2));
    writeU32(f2, 8, h.salt1 ^ 1);
    writeU32(f2, 16, frameChecksum(readU32(f1, 16), f2, f2.subarray(24)));
    file.write(f2, walFrameOffset(2));
    const s = scanWal(file, h);
    expect(s.txnsApplied).toBe(1);
    expect([...s.committed.keys()].sort()).toEqual([1, 2]);
  });

  it('T-WAL-006 a chain break in the middle keeps only the committed prefix', () => {
    const file = new MemoryVfs().open('w');
    threeTxns(file);
    const b = new Uint8Array(1);
    file.read(b, walFrameOffset(3) + 500);
    b[0] = (b[0] as number) ^ 0x10;
    file.write(b, walFrameOffset(3) + 500);
    const s = scanWal(file, header(file));
    expect(s.txnsApplied).toBe(1);
    expect(s.committed.get(1)).toBe(0);
    expect(s.committed.has(3)).toBe(false);
  });

  it('T-WAL-007 reset truncates, writes a new generation and hides old frames', () => {
    const file = new MemoryVfs().open('w');
    const w = threeTxns(file);
    const old = header(file);
    w.resetAfterCheckpoint(entropy(99));
    expect(file.size()).toBe(WAL_HEADER_SIZE);
    const h = header(file);
    expect(h.checkpointSeq).toBe(old.checkpointSeq + 1);
    expect([h.salt1, h.salt2]).not.toEqual([old.salt1, old.salt2]);
    expect(w.frames).toBe(0);
    expect(scanWal(file, h).committed.size).toBe(0);
    w.appendTxn([page(5, 5)]);
    expect([...scanWal(file, h).committed.keys()]).toEqual([5]);
  });

  it('T-WAL-008 invalid header: size ≤ 48 is an empty WAL, larger is WAL_HEADER_INVALID', () => {
    const vfs = new MemoryVfs();
    const empty = vfs.open('a');
    expect(readWalHeader(empty)).toEqual({ kind: 'empty' });
    empty.write(new Uint8Array(20).fill(7), 0);
    expect(readWalHeader(empty)).toEqual({ kind: 'empty' });
    empty.write(new Uint8Array(48).fill(7), 0);
    expect(readWalHeader(empty)).toEqual({ kind: 'empty' });

    const big = vfs.open('b');
    threeTxns(big);
    big.write(Uint8Array.of(0), 3);
    expect(codeOf(() => readWalHeader(big))).toBe('WAL_HEADER_INVALID');
  });

  it('T-WAL-010 a chain-valid frame with an invalid page CRC is corruption', () => {
    const file = new MemoryVfs().open('w');
    const w = newWal(file);
    const p = page(1, 1);
    p.data[300] = 0xee; // page CRC now wrong; appendTxn does not verify it
    w.appendTxn([p]);
    expect(codeOf(() => scanWal(file, header(file)))).toBe('WAL_FRAME_INVALID');
  });
});
