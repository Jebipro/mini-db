import { PageType } from '../../src/storage/layout.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { defaultPagerOptions, Pager, type PagerOptions, type PageId } from '../../src/storage/pager.js';
import type { Vfs } from '../../src/storage/vfs.js';
import { createRng } from '../../src/util/prng.js';

/** Payload area used by page-level tests (inside a HEAP-typed page, past the common header). */
export const PAYLOAD_OFF = 64;
export const PAYLOAD_LEN = 32;

export function seededEntropy(seed: number): (n: number) => Uint8Array {
  const r = createRng(seed);
  return (n) => r.bytes(n);
}

export function openPager(vfs: Vfs, path = 'db', opts: Partial<PagerOptions> = {}): Pager {
  return Pager.open(vfs, path, defaultPagerOptions({ entropy: seededEntropy(1234), ...opts }));
}

export function newMemPager(opts: Partial<PagerOptions> = {}): { vfs: MemoryVfs; pager: Pager } {
  const vfs = new MemoryVfs();
  return { vfs, pager: openPager(vfs, 'db', opts) };
}

export function payloadOf(fill: number): Uint8Array {
  return new Uint8Array(PAYLOAD_LEN).fill(fill & 0xff);
}

export function writePayload(p: Pager, id: PageId, payload: Uint8Array): void {
  const ref = p.pin(id);
  try {
    p.markDirty(ref);
    ref.data.set(payload, PAYLOAD_OFF);
  } finally {
    p.unpin(ref);
  }
}

export function readPayload(p: Pager, id: PageId): Uint8Array {
  const ref = p.pin(id);
  try {
    return Uint8Array.from(ref.data.subarray(PAYLOAD_OFF, PAYLOAD_OFF + PAYLOAD_LEN));
  } finally {
    p.unpin(ref);
  }
}

export function allocWithPayload(p: Pager, payload: Uint8Array): PageId {
  const ref = p.allocate(PageType.HEAP);
  try {
    ref.data.set(payload, PAYLOAD_OFF);
    return ref.id;
  } finally {
    p.unpin(ref);
  }
}

/** Runs fn in its own committed transaction + statement. */
export function inTxn<T>(p: Pager, fn: () => T): T {
  p.beginTxn();
  p.beginStatement();
  let out: T;
  try {
    out = fn();
  } catch (e) {
    p.rollbackStatement();
    p.rollbackTxn();
    throw e;
  }
  p.releaseStatement();
  p.commitTxn();
  return out;
}

/** Copy of a page's current cached bytes (pin + copy + unpin). */
export function pageBytes(p: Pager, id: PageId): Uint8Array {
  const ref = p.pin(id);
  try {
    return Uint8Array.from(ref.data);
  } finally {
    p.unpin(ref);
  }
}
