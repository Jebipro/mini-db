import { describe, expect, it } from 'vitest';
import {
  canInsert,
  canUpdate,
  checkHeapPage,
  compact,
  deleteRecord,
  getRecord,
  hp,
  initHeapPage,
  insertRecord,
  recordStart,
  slotOffset,
  totalFree,
  updateRecord,
} from '../../src/record/heap-page.js';
import { PAGE_SIZE } from '../../src/storage/layout.js';
import { createRng } from '../../src/util/prng.js';

function freshPage(): Uint8Array {
  const p = new Uint8Array(PAGE_SIZE);
  initHeapPage(p, 3);
  return p;
}

const rec = (len: number, fill: number): Uint8Array => new Uint8Array(len).fill(fill);

function expectGeometryOk(p: Uint8Array): void {
  expect(checkHeapPage(p, 3, 't')).toEqual([]);
}

describe('slotted heap page', () => {
  it('T-HP-001 insert, get, update and delete', () => {
    const p = freshPage();
    const a = insertRecord(p, rec(10, 1));
    const b = insertRecord(p, rec(20, 2));
    expect([a, b]).toEqual([0, 1]);
    expect(getRecord(p, a, 3)).toEqual(rec(10, 1));
    updateRecord(p, a, rec(5, 7));
    expect(getRecord(p, a, 3)).toEqual(rec(5, 7));
    updateRecord(p, a, rec(50, 8));
    expect(getRecord(p, a, 3)).toEqual(rec(50, 8));
    deleteRecord(p, a);
    expect(getRecord(p, a, 3)).toBeNull();
    expect(getRecord(p, 9, 3)).toBeNull();
    expect(getRecord(p, b, 3)).toEqual(rec(20, 2));
    expectGeometryOk(p);
  });

  it('T-HP-002 random operations keep the geometry invariant and match a slot model', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = createRng(seed);
      const p = freshPage();
      const model = new Map<number, Uint8Array>();
      for (let i = 0; i < 2000; i++) {
        const live = [...model.keys()];
        const op = r.nextFloat();
        const len = r.chance(0.1) ? r.nextInt(500, 2000) : r.nextInt(1, 120);
        const data = rec(len, r.nextInt(0, 255));
        if (op < 0.45) {
          if (canInsert(p, len)) {
            const slot = insertRecord(p, data);
            expect(model.has(slot)).toBe(false);
            model.set(slot, data);
          } else {
            expect(totalFree(p) < len + 4).toBe(true);
          }
        } else if (op < 0.75 && live.length > 0) {
          const slot = r.pick(live);
          if (canUpdate(p, slot, len)) {
            updateRecord(p, slot, data);
            model.set(slot, data);
          }
        } else if (live.length > 0) {
          const slot = r.pick(live);
          deleteRecord(p, slot);
          model.delete(slot);
        }
        const geo = checkHeapPage(p, 3, 't');
        if (geo.length > 0) expect(geo, `seed ${seed} op ${i}`).toEqual([]);
        if (i % 10 === 0) {
          for (const [slot, bytes] of model) {
            const got = getRecord(p, slot, 3);
            if (got === null || got.length !== bytes.length || got[0] !== bytes[0]) expect(got, `seed ${seed} op ${i} slot ${slot}`).toEqual(bytes);
          }
          const n = model.size === 0 ? 0 : Math.max(...model.keys()) + 1;
          if (hp.slotCount(p) !== n) expect(hp.slotCount(p)).toBe(n);
        }
      }
    }
  });

  it('T-HP-003 compaction keeps slot numbers and contents; the lowest tombstone is reused', () => {
    const p = freshPage();
    for (let i = 0; i < 6; i++) insertRecord(p, rec(100, i + 1));
    deleteRecord(p, 1);
    deleteRecord(p, 3);
    const before = [0, 2, 4, 5].map((s) => getRecord(p, s, 3));
    compact(p);
    expect([0, 2, 4, 5].map((s) => getRecord(p, s, 3))).toEqual(before);
    expect(slotOffset(p, 1)).toBe(0);
    expect(recordStart(p)).toBe(PAGE_SIZE - 400);
    expectGeometryOk(p);
    expect(insertRecord(p, rec(10, 9))).toBe(1);
    expect(insertRecord(p, rec(10, 9))).toBe(3);
    expect(insertRecord(p, rec(10, 9))).toBe(6);
  });

  it('T-HP-004 boundaries: exact fit, need+1 compaction or no space, failed update leaves bytes unchanged', () => {
    const p = freshPage();
    // empty page: 4096 - 32 - 4 = 4060 bytes for one record
    expect(canInsert(p, 4060)).toBe(true);
    expect(canInsert(p, 4061)).toBe(false);
    insertRecord(p, rec(4060, 1));
    expect(canInsert(p, 1)).toBe(false);
    expectGeometryOk(p);

    const q = freshPage();
    insertRecord(q, rec(2000, 1));
    insertRecord(q, rec(1000, 2));
    deleteRecord(q, 0); // tombstone kept? no: slot 0 is not last, so the tombstone stays
    // contiguous = 4096 - 3000 - (32 + 8) = 1056; fragmented = 2000; reuse tombstone → need = len
    expect(canInsert(q, 3056)).toBe(true);
    expect(canInsert(q, 3057)).toBe(false);
    insertRecord(q, rec(3056, 3)); // requires compaction
    expect(totalFree(q)).toBe(0);
    expectGeometryOk(q);
    const before = Uint8Array.from(q);
    expect(canUpdate(q, 1, 1001)).toBe(false);
    expect(q).toEqual(before);
    expect(canUpdate(q, 1, 1000)).toBe(true);
  });

  it('T-HP-005 trailing tombstones are trimmed from the slot directory', () => {
    const p = freshPage();
    for (let i = 0; i < 4; i++) insertRecord(p, rec(10, i));
    deleteRecord(p, 1);
    expect(hp.slotCount(p)).toBe(4);
    deleteRecord(p, 3);
    expect(hp.slotCount(p)).toBe(3);
    deleteRecord(p, 2);
    expect(hp.slotCount(p)).toBe(1);
    deleteRecord(p, 0);
    expect(hp.slotCount(p)).toBe(0);
    expectGeometryOk(p);
  });
});
