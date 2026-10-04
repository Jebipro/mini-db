import { describe, expect, it } from 'vitest';
import { BTree, type KeyBound } from '../../src/btree/btree.js';
import type { Entry } from '../../src/btree/key-codec.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { createRng, type Rng } from '../../src/util/prng.js';
import { openPager } from '../support/pager-harness.js';

/**
 * REVIEW-BT-001: independent randomized model of the B+tree (leaf/internal/root splits, lazy delete,
 * empty leaves, prefix keys, empty key, 512-byte keys, duplicates, inclusive/exclusive ranges, rollback).
 * The model is a sorted JS array compared with Buffer.compare; it does not use compareEntry/compareBytes.
 */

interface M {
  key: Buffer;
  page: number;
  slot: number;
}

function mcmp(a: M, b: M, unique: boolean): number {
  const c = Buffer.compare(a.key, b.key);
  if (c !== 0 || unique) return c;
  return a.page !== b.page ? a.page - b.page : a.slot - b.slot;
}

function genKey(r: Rng): Buffer {
  const x = r.nextFloat();
  if (x < 0.05) return Buffer.alloc(0); // empty TEXT key
  if (x < 0.35) return Buffer.from('a'.repeat(r.nextInt(1, 6)) + (r.chance(0.5) ? 'b' : ''), 'utf8'); // prefix family
  if (x < 0.65) return Buffer.from(`k${r.nextInt(0, 60)}`.padEnd(r.nextInt(300, 512), String.fromCharCode(97 + r.nextInt(0, 2))), 'utf8');
  if (x < 0.8) return Buffer.from(r.pick(['é', '한', '😀', 'ｱ', '\u0000', 'z']).repeat(r.nextInt(1, 3)), 'utf8');
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(r.nextInt(0, 40)));
  return b;
}

function toEntry(m: M): Entry {
  return { key: new Uint8Array(m.key), rid: { pageId: m.page, slot: m.slot } };
}

function fmt(e: Entry | M): string {
  const k = 'rid' in e ? Buffer.from(e.key) : e.key;
  const p = 'rid' in e ? e.rid.pageId : e.page;
  const s = 'rid' in e ? e.rid.slot : e.slot;
  return `${k.toString('hex').slice(0, 24)}#${k.length}@${p}:${s}`;
}

function scanAll(t: BTree, lo: KeyBound | null, hi: KeyBound | null): string[] {
  const c = t.scan(lo, hi);
  const out: string[] = [];
  for (let e = c.next(); e !== null; e = c.next()) out.push(fmt(e));
  return out;
}

let maxHeight = 0;
let maxEntries = 0;
function runSeed(seed: number, unique: boolean, steps: number): void {
  const r = createRng(seed);
  const vfs = new MemoryVfs();
  const p: Pager = openPager(vfs, 'db', { cachePages: 4096 });
  p.beginTxn();
  p.beginStatement();
  const root = BTree.create(p);
  p.releaseStatement();
  p.commitTxn();
  const t = new BTree(p, root, unique);
  let committed: M[] = [];
  let model: M[] = [];
  const begin = (): void => {
    p.beginTxn();
    p.beginStatement();
  };
  begin();
  for (let step = 0; step < steps; step++) {
    const x = r.nextFloat();
    const growing = step < steps * 0.7;
    if (x < (growing ? 0.75 : 0.35) || model.length === 0) {
      const m: M = { key: genKey(r), page: r.nextInt(1, 30), slot: r.nextInt(0, 20) };
      const exists = model.some((o) => mcmp(o, m, unique) === 0);
      if (exists) continue;
      t.insert(toEntry(m));
      model.push(m);
      model.sort((a, b) => mcmp(a, b, unique));
    } else if (x < (growing ? 0.85 : 0.85)) {
      // delete a random existing entry (sometimes runs of neighbours → empty leaves)
      const i = r.nextInt(0, model.length - 1);
      const n = r.chance(0.2) ? Math.min(model.length - i, r.nextInt(1, 30)) : 1;
      for (const m of model.splice(i, n)) t.delete(toEntry(m));
    } else if (x < 0.93) {
      const lo = r.chance(0.3) ? null : { key: genKey(r), inclusive: r.chance(0.5) };
      const hi = r.chance(0.3) ? null : { key: genKey(r), inclusive: r.chance(0.5) };
      const want = model
        .filter((m) => {
          if (lo) {
            const c = Buffer.compare(m.key, lo.key);
            if (c < 0 || (c === 0 && !lo.inclusive)) return false;
          }
          if (hi) {
            const c = Buffer.compare(m.key, hi.key);
            if (c > 0 || (c === 0 && !hi.inclusive)) return false;
          }
          return true;
        })
        .map(fmt);
      const got = scanAll(t, lo && { key: new Uint8Array(lo.key), inclusive: lo.inclusive }, hi && { key: new Uint8Array(hi.key), inclusive: hi.inclusive });
      expect(got, `seed ${seed} step ${step} range`).toEqual(want);
    } else if (x < 0.97) {
      if (unique) {
        const k = r.chance(0.5) && model.length > 0 ? (r.pick(model) as M).key : genKey(r);
        const hit = model.find((m) => Buffer.compare(m.key, k) === 0);
        const got = t.findUnique(new Uint8Array(k));
        expect(got && `${got.pageId}:${got.slot}`, `seed ${seed} step ${step} findUnique`).toEqual(hit ? `${hit.page}:${hit.slot}` : null);
      }
    } else {
      // end the transaction: commit or roll back, then validate the structure
      p.releaseStatement();
      if (r.chance(0.3)) {
        p.rollbackTxn();
        model = committed.slice();
      } else {
        p.commitTxn();
        committed = model.slice();
      }
      maxHeight = Math.max(maxHeight, t.height());
      maxEntries = Math.max(maxEntries, model.length);
      const chk = t.check('t');
      expect(chk.issues, `seed ${seed} step ${step} check`).toEqual([]);
      expect(chk.entries.map(fmt), `seed ${seed} step ${step} entries`).toEqual(model.map(fmt));
      if (r.chance(0.2)) p.checkpoint();
      begin();
    }
  }
  p.releaseStatement();
  p.commitTxn();
  const chk = t.check('t');
  expect(chk.issues).toEqual([]);
  expect(chk.entries.map(fmt)).toEqual(model.map(fmt));
  expect(scanAll(t, null, null)).toEqual(model.map(fmt));
  p.close();
}

describe('REVIEW-BT-001 B+tree vs independent model', () => {
  const seeds = Number(process.env.REVIEW_SEEDS ?? 40);
  it('unique trees', () => {
    for (let s = 1; s <= seeds; s++) runSeed(s, true, 3000);
  });
  it('non-unique trees', () => {
    for (let s = 1; s <= seeds; s++) runSeed(1000 + s, false, 3000);
  });
  it('reached multi-level trees', () => {
    console.log('maxHeight', maxHeight, 'maxEntries', maxEntries);
    expect(maxHeight).toBeGreaterThanOrEqual(3);
  });
});
