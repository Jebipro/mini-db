import { describe, expect, it } from 'vitest';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { createRng, type Rng } from '../../src/util/prng.js';
import { allocWithPayload, openPager, payloadOf, readPayload, writePayload } from '../support/pager-harness.js';

/** Page-level reference model: live pages with a payload byte, LIFO freelist, page count. */
interface ModelState {
  pages: Map<number, number>;
  free: number[]; // top of stack = freelist head
  pageCount: number;
}

const clone = (s: ModelState): ModelState => ({ pages: new Map(s.pages), free: [...s.free], pageCount: s.pageCount });

function verify(p: Pager, m: ModelState, ctx: string): void {
  expect(p.pageCount, ctx).toBe(m.pageCount);
  expect(p.freelistPages(), ctx).toEqual([...m.free].reverse());
  for (const [id, fill] of m.pages) expect(readPayload(p, id), `${ctx} page ${id}`).toEqual(payloadOf(fill));
}

function pickLive(r: Rng, m: ModelState): number | null {
  if (m.pages.size === 0) return null;
  return r.pick([...m.pages.keys()].sort((a, b) => a - b));
}

function runSeed(seed: number, steps: number): void {
  const r = createRng(seed);
  let vfs = new MemoryVfs();
  let p = openPager(vfs, 'db', { cachePages: 128, walAutoCheckpointFrames: 0 });
  let committed: ModelState = { pages: new Map(), free: [], pageCount: 1 };
  let txn: ModelState | null = null;

  for (let step = 0; step < steps; step++) {
    const ctx = `seed=${seed} step=${step}`;
    if (txn === null) {
      const x = r.nextFloat();
      if (x < 0.6) {
        p.beginTxn();
        txn = clone(committed);
      } else if (x < 0.7) {
        p.checkpoint();
      } else if (x < 0.75) {
        p.close();
        p = openPager(vfs, 'db', { cachePages: 128, walAutoCheckpointFrames: 0 });
      } else if (x < 0.8) {
        // lose the handle: committed transactions were fsynced, so they must survive
        vfs = vfs.crashImage(r.chance(0.5) ? 'durable-only' : 'all-pending');
        p = openPager(vfs, 'db', { cachePages: 128, walAutoCheckpointFrames: 0 });
      } else {
        verify(p, committed, ctx);
      }
      continue;
    }

    // one statement with 1–4 page operations
    const before = clone(txn);
    p.beginStatement();
    const n = r.nextInt(1, 4);
    for (let i = 0; i < n; i++) {
      const op = r.nextFloat();
      const live = pickLive(r, txn);
      if (op < 0.45 && live !== null) {
        const fill = r.nextInt(0, 255);
        writePayload(p, live, payloadOf(fill));
        txn.pages.set(live, fill);
      } else if (op < 0.8 || live === null) {
        const fill = r.nextInt(0, 255);
        const id = allocWithPayload(p, payloadOf(fill));
        const expected = txn.free.length > 0 ? (txn.free.pop() as number) : txn.pageCount++;
        expect(id, ctx).toBe(expected);
        txn.pages.set(id, fill);
      } else {
        p.free(live);
        txn.pages.delete(live);
        txn.free.push(live);
      }
    }
    if (r.chance(0.3)) {
      p.rollbackStatement();
      txn = before;
    } else {
      p.releaseStatement();
    }
    verify(p, txn, `${ctx} (in txn)`);

    const end = r.nextFloat();
    if (end < 0.3) {
      p.commitTxn();
      committed = txn;
      txn = null;
    } else if (end < 0.4) {
      p.rollbackTxn();
      txn = null;
      verify(p, committed, `${ctx} (after rollback)`);
    }
  }
  if (txn !== null) p.rollbackTxn();
  verify(p, committed, `seed=${seed} final`);
  p.close();
  const q = openPager(vfs, 'db');
  verify(q, committed, `seed=${seed} reopened`);
  q.close();
}

describe('pager model', () => {
  it('T-PGR-012 random page transactions match a Map model (rollback, savepoints, checkpoint, reopen)', () => {
    const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: 10 }, (_, i) => i + 1);
    for (const seed of seeds) {
      try {
        runSeed(seed, 300);
      } catch (e) {
        throw new Error(`${(e as Error).message}\nREPRO: SEED=${seed} npx vitest run tests/unit/pager-model.test.ts`, { cause: e });
      }
    }
  });
});
