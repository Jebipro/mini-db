import { describe, expect, it } from 'vitest';
import { HeapFile } from '../../src/record/heap-file.js';
import { hp } from '../../src/record/heap-page.js';
import { ridKey, type ColumnType, type Rid, type Value } from '../../src/record/value.js';
import { checkOwnership } from '../../src/storage/issues.js';
import { PageType } from '../../src/storage/layout.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { createRng } from '../../src/util/prng.js';
import { inTxn, openPager } from '../support/pager-harness.js';

const TYPES: ColumnType[] = ['INTEGER', 'TEXT', 'BOOLEAN'];

function setup(): { vfs: MemoryVfs; pager: Pager; head: number } {
  const vfs = new MemoryVfs();
  const pager = openPager(vfs);
  const head = inTxn(pager, () => HeapFile.create(pager));
  return { vfs, pager, head };
}

function scanAll(h: HeapFile): Map<string, Value[]> {
  const out = new Map<string, Value[]>();
  const c = h.scan();
  for (let r = c.next(); r !== null; r = c.next()) out.set(ridKey(r.rid), r.values);
  return out;
}

describe('heap file', () => {
  it('T-HEAP-001 random insert/update/delete/scan match an array model across pages and reopen', () => {
    for (const seed of [1, 2, 3]) {
      const r = createRng(seed);
      const s = setup();
      const { vfs, head } = s;
      let pager = s.pager;
      const model = new Map<string, { rid: Rid; values: Value[] }>();
      for (let round = 0; round < 12; round++) {
        let heap = new HeapFile(pager, head, TYPES);
        inTxn(pager, () => {
          for (let i = 0; i < 40; i++) {
            const keys = [...model.keys()];
            const x = r.nextFloat();
            const values: Value[] = [r.nextInt(-1e6, 1e6), 'v'.repeat(r.chance(0.1) ? r.nextInt(500, 3500) : r.nextInt(0, 60)), r.chance(0.3) ? null : r.chance(0.5)];
            if (x < 0.5 || keys.length === 0) {
              const rid = heap.insert(values);
              expect(model.has(ridKey(rid))).toBe(false);
              model.set(ridKey(rid), { rid, values });
            } else if (x < 0.8) {
              const k = r.pick(keys);
              const old = model.get(k) as { rid: Rid };
              const rid = heap.update(old.rid, values);
              model.delete(k);
              model.set(ridKey(rid), { rid, values });
            } else {
              const k = r.pick(keys);
              heap.delete((model.get(k) as { rid: Rid }).rid);
              model.delete(k);
            }
          }
        });
        const got = scanAll(heap);
        expect(new Map([...got].sort())).toEqual(new Map([...model].map(([k, v]) => [k, v.values] as const).sort()));
        for (const { rid, values } of model.values()) expect(heap.get(rid)).toEqual(values);
        const check = heap.check('t');
        expect(check.issues).toEqual([]);
        expect(check.rows).toBe(model.size);
        if (round % 4 === 3) {
          pager.close();
          pager = openPager(vfs);
          heap = new HeapFile(pager, head, TYPES);
          expect(scanAll(heap).size).toBe(model.size);
        }
      }
      expect(new HeapFile(pager, head, TYPES).pageIds().length).toBeGreaterThan(3);
      pager.close();
    }
  });

  it('T-HEAP-002 an update that does not fit moves the row to another page with a new RID', () => {
    const { pager, head } = setup();
    const heap = new HeapFile(pager, head, ['TEXT']);
    const rids = inTxn(pager, () => [heap.insert(['a'.repeat(1900)]), heap.insert(['b'.repeat(1900)])]);
    const [r0] = rids as [Rid, Rid];
    const moved = inTxn(pager, () => heap.update(r0, ['c'.repeat(3000)]));
    expect(moved.pageId).not.toBe(r0.pageId);
    expect(heap.get(r0)).toBeNull();
    expect(heap.get(moved)).toEqual(['c'.repeat(3000)]);
    const same = inTxn(pager, () => heap.update(moved, ['d']));
    expect(same).toEqual(moved);
    expect(heap.check('t').issues).toEqual([]);
    pager.close();
  });

  it('T-HEAP-003 structure checks detect a cycle, a wrong tail pointer and leaked / shared pages', () => {
    const { pager, head } = setup();
    const heap = new HeapFile(pager, head, ['TEXT']);
    inTxn(pager, () => {
      for (let i = 0; i < 6; i++) heap.insert(['x'.repeat(1500)]);
    });
    const pages = heap.pageIds();
    expect(pages.length).toBe(3);
    // ownership: a page allocated but not linked anywhere is leaked; a page claimed twice is shared
    const leaked = inTxn(pager, () => {
      const ref = pager.allocate(PageType.HEAP);
      pager.unpin(ref);
      return ref.id;
    });
    expect(checkOwnership(pager.pageCount, [{ owner: 't', pages }])).toEqual([
      expect.objectContaining({ code: 'PAGE_LEAKED', pageId: leaked }),
    ]);
    expect(checkOwnership(pager.pageCount, [{ owner: 't', pages }, { owner: 'u', pages: [pages[1] as number, leaked] }])).toEqual([
      expect.objectContaining({ code: 'PAGE_MULTI_OWNED', pageId: pages[1] }),
    ]);

    // wrong tail pointer (pages are re-stamped at commit, so this is valid-CRC structural damage)
    inTxn(pager, () => {
      const ref = pager.pin(head);
      pager.markDirty(ref);
      hp.setTail(ref.data, pages[1] as number);
      pager.unpin(ref);
    });
    expect(heap.check('t').issues).toEqual([expect.objectContaining({ code: 'HEAP_CHAIN_INVALID' })]);
    // cycle: last page points back to the head
    inTxn(pager, () => {
      const ref = pager.pin(pages[2] as number);
      pager.markDirty(ref);
      hp.setNext(ref.data, head);
      pager.unpin(ref);
    });
    expect(heap.check('t').issues.map((i) => i.code)).toContain('HEAP_CHAIN_INVALID');
    expect(() => heap.pageIds()).toThrow(/cyclic/);
    pager.close();
  });
});
