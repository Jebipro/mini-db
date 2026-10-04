import { describe, expect, it } from 'vitest';
import { BTree, type KeyBound } from '../../src/btree/btree.js';
import { compareEntry, encodeKey, type Entry } from '../../src/btree/key-codec.js';
import { nd, writeLeaf } from '../../src/btree/node.js';
import { InternalError, LimitError } from '../../src/errors/errors.js';
import type { ColumnType, Value } from '../../src/record/value.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { compareBytes } from '../../src/util/bytes.js';
import { createRng, type Rng } from '../../src/util/prng.js';
import { inTxn, openPager } from '../support/pager-harness.js';

const MAX = Number.MAX_SAFE_INTEGER;

function setup(cachePages = 4096): { pager: Pager; vfs: MemoryVfs } {
  const vfs = new MemoryVfs();
  return { vfs, pager: openPager(vfs, 'db', { cachePages }) };
}

function newTree(p: Pager, unique: boolean): BTree {
  return new BTree(p, inTxn(p, () => BTree.create(p)), unique);
}

const intKey = (v: number): Uint8Array => encodeKey('INTEGER', v);
const rid = (n: number): { pageId: number; slot: number } => ({ pageId: 2 + (n >> 8), slot: n & 0xff });

function all(t: BTree, lo: KeyBound | null = null, hi: KeyBound | null = null): Entry[] {
  const c = t.scan(lo, hi);
  const out: Entry[] = [];
  for (let e = c.next(); e !== null; e = c.next()) out.push(e);
  return out;
}

/** Plain JS value order used as the model (independent of the key codec). */
function valueCmp(a: Value, b: Value): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return Buffer.compare(Buffer.from(a as string, 'utf8'), Buffer.from(b as string, 'utf8'));
}

function expectValid(t: BTree): Entry[] {
  const r = t.check('idx');
  expect(r.issues).toEqual([]);
  return r.entries;
}

describe('key codec', () => {
  it('T-KEY-001 key byte order equals value order (integers across the sign boundary, text, booleans)', () => {
    const r = createRng(5);
    const ints = [0, -1, 1, MAX, -MAX, MAX - 1, -(MAX - 1), 255, 256, -256, 2 ** 32, -(2 ** 32)];
    const texts = ['', 'a', 'ab', 'b', 'B', 'é', '한', '😀', 'ｱ', 'a\u0000', 'zz'];
    const pairs: Array<[ColumnType, Value, Value]> = [];
    for (let i = 0; i < 3000; i++) {
      pairs.push(['INTEGER', r.chance(0.3) ? r.pick(ints) : r.nextInt(-1e15, 1e15), r.chance(0.3) ? r.pick(ints) : r.nextInt(-1e15, 1e15)]);
      pairs.push(['TEXT', r.pick(texts), r.pick(texts)]);
    }
    pairs.push(['BOOLEAN', false, true], ['BOOLEAN', true, false], ['BOOLEAN', true, true]);
    for (const [t, a, b] of pairs) {
      const ka = encodeKey(t, a as Exclude<Value, null>);
      const kb = encodeKey(t, b as Exclude<Value, null>);
      expect(Math.sign(compareBytes(ka, kb)), `${t} ${String(a)} vs ${String(b)}`).toBe(Math.sign(valueCmp(a, b)));
    }
    expect(Array.from(encodeKey('INTEGER', -1))).toEqual([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(Array.from(encodeKey('INTEGER', 0))).toEqual([0x80, 0, 0, 0, 0, 0, 0, 0]);
    // non-unique entries: ('a', rid big) < ('ab', rid small) — the tuple comparator avoids the prefix pitfall
    expect(compareEntry({ key: encodeKey('TEXT', 'a'), rid: { pageId: 999, slot: 9 } }, { key: encodeKey('TEXT', 'ab'), rid: { pageId: 1, slot: 0 } }, false)).toBe(-1);
  });

  it('T-KEY-002 TEXT keys: 512 bytes encode, 513 is KEY_TOO_LARGE', () => {
    expect(encodeKey('TEXT', 'x'.repeat(512)).length).toBe(512);
    expect(() => encodeKey('TEXT', 'x'.repeat(513))).toThrow(LimitError);
    try {
      encodeKey('TEXT', '한'.repeat(171)); // 513 bytes
    } catch (e) {
      expect((e as LimitError).code).toBe('KEY_TOO_LARGE');
    }
  });
});

describe('B+tree', () => {
  it('T-BT-001 small tree insert, point lookup and scan', () => {
    const { pager } = setup();
    const t = newTree(pager, true);
    inTxn(pager, () => {
      for (const v of [5, 1, 3, -2]) t.insert({ key: intKey(v), rid: rid(v + 10) });
    });
    expect(t.findUnique(intKey(3))).toEqual(rid(13));
    expect(t.findUnique(intKey(4))).toBeNull();
    expect(all(t).map((e) => e.rid)).toEqual([rid(8), rid(11), rid(13), rid(15)]);
    expect(() => inTxn(pager, () => t.insert({ key: intKey(3), rid: rid(99) }))).toThrow(InternalError);
    expectValid(t);
    pager.close();
  });

  function randomOps(seed: number, unique: boolean, ops: number, keySpace: () => Uint8Array, r: Rng, p: Pager, t: BTree): void {
    const model: Entry[] = [];
    const sortModel = (): void => {
      model.sort((a, b) => compareEntry(a, b, unique));
    };
    for (let i = 0; i < ops; i += 50) {
      inTxn(p, () => {
        for (let j = 0; j < 50; j++) {
          if (model.length > 0 && r.chance(0.35)) {
            const k = r.nextInt(0, model.length - 1);
            const e = model[k] as Entry;
            t.delete(e);
            model.splice(k, 1);
          } else {
            const e = { key: keySpace(), rid: rid(r.nextInt(0, 60000)) };
            if (model.some((m) => compareEntry(m, e, unique) === 0)) continue;
            t.insert(e);
            model.push(e);
          }
        }
      });
      sortModel();
      const got = expectValid(t);
      expect(got.length, `seed ${seed} op ${i}`).toBe(model.length);
      expect(got.map((e) => compareEntry(e, model[got.indexOf(e)] as Entry, unique))).toEqual(got.map(() => 0));
    }
    expect(all(t).length).toBe(model.length);
  }

  it('T-BT-002 random insert/delete matches a sorted-array model (unique and non-unique), checker every 50 ops', () => {
    for (const [seed, unique] of [
      [1, true],
      [2, false],
      [3, true],
      [4, false],
    ] as const) {
      const r = createRng(seed);
      const { pager } = setup();
      const t = newTree(pager, unique);
      const keySpace = unique ? () => intKey(r.nextInt(-5000, 5000)) : () => encodeKey('TEXT', 'k'.repeat(r.nextInt(0, 40)) + String(r.nextInt(0, 30)));
      randomOps(seed, unique, 2000, keySpace, r, pager, t);
      pager.close();
    }
  });

  it('T-BT-003 512-byte keys force ≥3 levels; leaf and internal root splits keep the root page id', () => {
    const { pager } = setup();
    const t = newTree(pager, true);
    const root = t.root;
    const big = (i: number): Uint8Array => encodeKey('TEXT', `${String(i).padStart(6, '0')}${'x'.repeat(506)}`);
    for (let batch = 0; batch < 12; batch++) {
      inTxn(pager, () => {
        for (let i = batch * 25; i < batch * 25 + 25; i++) t.insert({ key: big((i * 7919) % 300), rid: rid(i) });
      });
      expectValid(t);
    }
    const depth = t.height();
    expect(depth).toBeGreaterThanOrEqual(3);
    expect(t.root).toBe(root);
    expect(all(t).length).toBe(300);
    for (let i = 0; i < 300; i += 37) expect(t.findUnique(big(i))).not.toBeNull();
    pager.close();
  });

  it('T-BT-004 range scans with every bound combination match the model', () => {
    const { pager } = setup();
    const t = newTree(pager, false);
    const r = createRng(11);
    const vals: number[] = [];
    inTxn(pager, () => {
      for (let i = 0; i < 600; i++) {
        const v = r.nextInt(-50, 50);
        vals.push(v);
        t.insert({ key: intKey(v), rid: rid(i) });
      }
    });
    const bounds = [-60, -50, -1, 0, 7, 50, 60];
    for (const lo of [null, ...bounds]) {
      for (const hi of [null, ...bounds]) {
        for (const loInc of [true, false]) {
          for (const hiInc of [true, false]) {
            const want = vals.filter(
              (v) => (lo === null || (loInc ? v >= lo : v > lo)) && (hi === null || (hiInc ? v <= hi : v < hi)),
            ).length;
            const got = all(t, lo === null ? null : { key: intKey(lo), inclusive: loInc }, hi === null ? null : { key: intKey(hi), inclusive: hiInc });
            expect(got.length, `${lo}${loInc ? '[' : '('} ${hi}${hiInc ? ']' : ')'}`).toBe(want);
            for (let i = 1; i < got.length; i++) expect(compareEntry(got[i - 1] as Entry, got[i] as Entry, false)).toBe(-1);
          }
        }
      }
    }
    pager.close();
  });

  it('T-BT-005 non-unique: hundreds of equal keys across leaves; seek finds the first', () => {
    const { pager } = setup();
    const t = newTree(pager, false);
    const key = encodeKey('TEXT', 'same'.repeat(30));
    inTxn(pager, () => {
      for (let i = 0; i < 500; i++) t.insert({ key, rid: rid((i * 37) % 500) });
      for (let i = 0; i < 100; i++) t.insert({ key: encodeKey('TEXT', 'a'), rid: rid(i) });
      for (let i = 0; i < 100; i++) t.insert({ key: encodeKey('TEXT', 'z'), rid: rid(i) });
    });
    const eq = all(t, { key, inclusive: true }, { key, inclusive: true });
    expect(eq.length).toBe(500);
    expect(eq.map((e) => e.rid)).toEqual(Array.from({ length: 500 }, (_, i) => rid(i)));
    expect(all(t, { key, inclusive: false }, null).length).toBe(100);
    expect(expectValid(t).length).toBe(700);
    pager.close();
  });

  it('T-BT-006 deleting everything leaves empty leaves; scans are empty and reinsertion works', () => {
    const { pager } = setup();
    const t = newTree(pager, true);
    inTxn(pager, () => {
      for (let i = 0; i < 2000; i++) t.insert({ key: intKey(i), rid: rid(i) });
    });
    const pagesBefore = t.pageIds().length;
    expect(pagesBefore).toBeGreaterThan(5);
    inTxn(pager, () => {
      for (let i = 0; i < 2000; i++) t.delete({ key: intKey(i), rid: rid(i) });
    });
    expect(all(t)).toEqual([]);
    expect(all(t, { key: intKey(500), inclusive: true }, null)).toEqual([]);
    expect(t.findUnique(intKey(5))).toBeNull();
    expect(t.pageIds().length).toBe(pagesBefore); // lazy: nothing shrinks
    expectValid(t);
    inTxn(pager, () => {
      for (let i = 1000; i < 1100; i++) t.insert({ key: intKey(i), rid: rid(i) });
    });
    expect(all(t).length).toBe(100);
    expect(all(t, { key: intKey(1050), inclusive: true }, null).length).toBe(50);
    expectValid(t);
    pager.close();
  });

  it('T-BT-007 the checker detects unsorted keys, a broken leaf chain and wrong depths', () => {
    const build = (): { pager: Pager; t: BTree; leaves: number[] } => {
      const { pager } = setup();
      const t = newTree(pager, true);
      inTxn(pager, () => {
        for (let i = 0; i < 1500; i++) t.insert({ key: intKey(i), rid: rid(i) });
      });
      const leaves = t.pageIds().filter((id) => {
        const ref = pager.pin(id);
        const leaf = nd.isLeaf(ref.data);
        pager.unpin(ref);
        return leaf;
      });
      return { pager, t, leaves };
    };
    const edit = (pager: Pager, id: number, fn: (p: Uint8Array) => void): void => {
      inTxn(pager, () => {
        const ref = pager.pin(id);
        pager.markDirty(ref);
        fn(ref.data);
        pager.unpin(ref);
      });
    };
    {
      const { pager, t, leaves } = build();
      edit(pager, leaves[1] as number, (p) => writeLeaf(p, leaves[1] as number, [{ key: intKey(9999), rid: rid(1) }, { key: intKey(5), rid: rid(2) }], nd.rightPtr(p)));
      expect(t.check('i').issues.map((i) => i.code)).toContain('BTREE_ORDER_INVALID');
      pager.close();
    }
    {
      const { pager, t, leaves } = build();
      edit(pager, leaves[2] as number, (p) => nd.setRightPtr(p, leaves[4] as number));
      expect(t.check('i').issues.map((i) => i.code)).toContain('BTREE_SHAPE_INVALID');
      pager.close();
    }
    {
      // root's right pointer redirected straight to a leaf two levels down → leaves at different depths
      const { pager } = setup();
      const t3 = newTree(pager, true);
      const big = (i: number): Uint8Array => encodeKey('TEXT', `${String(i).padStart(6, '0')}${'x'.repeat(506)}`);
      for (let batch = 0; batch < 12; batch++) {
        inTxn(pager, () => {
          for (let i = batch * 25; i < batch * 25 + 25; i++) t3.insert({ key: big(i), rid: rid(i) });
        });
      }
      expect(t3.height()).toBeGreaterThanOrEqual(3);
      expect(t3.check('i').issues).toEqual([]);
      const leaf = t3.pageIds().find((id) => {
        const ref = pager.pin(id);
        const isLeaf = nd.isLeaf(ref.data);
        pager.unpin(ref);
        return isLeaf;
      }) as number;
      edit(pager, t3.root, (p) => nd.setRightPtr(p, leaf));
      expect(t3.check('i').issues.map((i) => i.code)).toContain('BTREE_SHAPE_INVALID');
      pager.close();
    }
  });

  it('T-BT-008 destroy frees every node page', () => {
    const { pager } = setup();
    const t = newTree(pager, false);
    inTxn(pager, () => {
      for (let i = 0; i < 1500; i++) t.insert({ key: encodeKey('TEXT', `k${i}`.repeat(5)), rid: rid(i) });
    });
    const pages = t.pageIds();
    expect(pages.length).toBeGreaterThan(10);
    const before = pager.freelistCount;
    inTxn(pager, () => t.destroy());
    expect(pager.freelistCount - before).toBe(pages.length);
    expect(new Set(pager.freelistPages())).toEqual(new Set(pages));
    pager.close();
  });
});
