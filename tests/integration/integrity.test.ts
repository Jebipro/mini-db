import { describe, expect, it } from 'vitest';
import { BTree } from '../../src/btree/btree.js';
import { encodeKey } from '../../src/btree/key-codec.js';
import { nd, writeLeaf } from '../../src/btree/node.js';
import { Catalog, CATALOG_TYPES } from '../../src/catalog/catalog.js';
import { Database } from '../../src/engine/database.js';
import { checkIntegrity, type IntegrityReport } from '../../src/engine/integrity.js';
import { HeapFile } from '../../src/record/heap-file.js';
import { hp } from '../../src/record/heap-page.js';
import { encodeRow } from '../../src/record/row-codec.js';
import { FH_CATALOG_ROOT, FH_FREELIST_COUNT, HP_FRAGMENTED, BT_FRAGMENTED, PAGE_SIZE, PageType } from '../../src/storage/layout.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { compareBytes, readU16, writeU16, writeU32 } from '../../src/util/bytes.js';
import { deterministicEntropy } from '../support/db.js';
import { inTxn, openPager } from '../support/pager-harness.js';

/** A database with a PK table (heap over several pages), a secondary index and one free page. */
function baseImage(): MemoryVfs {
  const vfs = new MemoryVfs();
  const db = Database.open('db', { vfs, entropy: deterministicEntropy(3) });
  db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT NOT NULL, pad TEXT)');
  db.execute('CREATE INDEX is_ ON t (s)');
  for (let i = 0; i < 300; i++) db.execute(`INSERT INTO t VALUES (${i}, 's${i % 50}', '${'p'.repeat(40)}')`);
  db.execute('CREATE TABLE gone (a INTEGER)');
  db.execute('DROP TABLE gone');
  expect(db.integrityCheck().issues).toEqual([]);
  db.close();
  return vfs;
}

interface Ctx {
  pager: Pager;
  cat: Catalog;
  heapPages: number[];
  pkTree: BTree;
  sTree: BTree;
}

/** Applies a structural change through the pager (pages are re-stamped with valid CRCs at commit), then checks. */
function damage(fn: (c: Ctx) => void): IntegrityReport {
  const vfs = baseImage();
  const pager = openPager(vfs, 'db', { initialize: Catalog.initialize });
  const cat = Catalog.load(pager);
  const t = cat.getTable('t');
  if (!t) throw new Error('no table');
  const heap = new HeapFile(pager, t.heapHead, ['INTEGER', 'TEXT', 'TEXT']);
  const pk = t.indexes.find((i) => i.auto);
  const si = t.indexes.find((i) => !i.auto);
  if (!pk || !si) throw new Error('indexes missing');
  const ctx: Ctx = { pager, cat, heapPages: heap.pageIds(), pkTree: new BTree(pager, pk.root, true), sTree: new BTree(pager, si.root, false) };
  inTxn(pager, () => fn(ctx));
  const report = checkIntegrity(pager, pager.stats().wal.frames);
  pager.close();
  return report;
}

function edit(p: Pager, id: number, fn: (b: Uint8Array) => void): void {
  const ref = p.pin(id);
  p.markDirty(ref);
  fn(ref.data);
  p.unpin(ref);
}

const codes = (r: IntegrityReport): string[] => [...new Set(r.issues.map((i) => i.code))];

describe('integrity check', () => {
  it('T-INTEG-002 each invariant violation (valid CRCs) is reported with its issue code', () => {
    // I1
    expect(codes(damage(({ pager }) => edit(pager, 0, (b) => writeU32(b, FH_CATALOG_ROOT, 2))))).toContain('HEADER_INVALID');
    // I3 leak / double use
    expect(codes(damage(({ pager }) => pager.unpin(pager.allocate(PageType.HEAP))))).toContain('PAGE_LEAKED');
    expect(
      codes(
        damage(({ pager, heapPages, sTree }) => {
          const victim = sTree.pageIds()[0] as number;
          edit(pager, heapPages[heapPages.length - 1] as number, (b) => hp.setNext(b, victim));
        }),
      ),
    ).toEqual(expect.arrayContaining(['HEAP_CHAIN_INVALID']));
    // I4
    expect(codes(damage(({ pager }) => edit(pager, 0, (b) => writeU32(b, FH_FREELIST_COUNT, 7))))).toContain('FREELIST_INVALID');
    // I5
    expect(codes(damage(({ pager, heapPages }) => edit(pager, heapPages[0] as number, (b) => hp.setTail(b, heapPages[1] as number))))).toContain('HEAP_CHAIN_INVALID');
    // I6
    expect(codes(damage(({ pager, heapPages }) => edit(pager, heapPages[1] as number, (b) => writeU16(b, HP_FRAGMENTED, readU16(b, HP_FRAGMENTED) + 3))))).toContain('SLOTTED_PAGE_INVALID');
    // I7: a NULL in a NOT NULL column, encoded validly
    expect(
      codes(
        damage(({ pager, heapPages }) => {
          edit(pager, heapPages[0] as number, (b) => {
            const off = readU16(b, 32);
            const len = readU16(b, 34);
            const rec = encodeRow(['INTEGER', 'TEXT', 'TEXT'], [0, null, 'x'.repeat(len - 1 - 1 - 8 - 2)]);
            expect(rec.length).toBe(len);
            b.set(rec, off);
          });
        }),
      ),
    ).toContain('RECORD_INVALID');
    // I8: leaf chain broken
    expect(
      codes(
        damage(({ pager, pkTree }) => {
          const leaves = pkTree.pageIds().filter((id) => {
            const r = pager.pin(id);
            const leaf = nd.isLeaf(r.data);
            pager.unpin(r);
            return leaf;
          });
          edit(pager, leaves[0] as number, (b) => nd.setRightPtr(b, leaves[2] as number));
        }),
      ),
    ).toContain('BTREE_SHAPE_INVALID');
    // I9: entries out of order
    expect(
      codes(
        damage(({ pager, pkTree }) => {
          const leaf = pkTree.pageIds().find((id) => {
            const r = pager.pin(id);
            const isLeaf = nd.isLeaf(r.data);
            pager.unpin(r);
            return isLeaf;
          }) as number;
          edit(pager, leaf, (b) => writeLeaf(b, leaf, [{ key: encodeKey('INTEGER', 5), rid: { pageId: 2, slot: 0 } }, { key: encodeKey('INTEGER', 1), rid: { pageId: 2, slot: 1 } }], nd.rightPtr(b)));
        }),
      ),
    ).toContain('BTREE_ORDER_INVALID');
    // I10
    expect(codes(damage(({ pager, sTree }) => edit(pager, sTree.root, (b) => writeU16(b, BT_FRAGMENTED, readU16(b, BT_FRAGMENTED) + 1))))).toContain('BTREE_PAGE_INVALID');
    // I11: an index entry removed behind the table's back
    expect(
      codes(
        damage(({ sTree }) => {
          const c = sTree.scan(null, null);
          const e = c.next();
          if (e) sTree.delete(e);
        }),
      ),
    ).toContain('INDEX_HEAP_MISMATCH');
    // I12
    expect(codes(damage(({ pager }) => new HeapFile(pager, 1, CATALOG_TYPES).insert(['index', 'ghost', 'nope', 0, null, null, null, false, 3, 'x'])))).toContain('CATALOG_INVALID');
    // I2: a raw bit flip (invalid CRC)
    const vfs = baseImage();
    const bytes = vfs.fileBytes('db');
    bytes[3 * PAGE_SIZE + 77] = (bytes[3 * PAGE_SIZE + 77] as number) ^ 4;
    vfs.setFileBytes('db', bytes);
    const p = openPager(vfs, 'db', { initialize: Catalog.initialize });
    const report = checkIntegrity(p, 0);
    expect(codes(report)).toEqual(['PAGE_CORRUPT']);
    expect(p.state).toBe('failed');
    p.close();
    // I1 file size
    const vfs2 = baseImage();
    vfs2.setFileBytes('db', new Uint8Array([...vfs2.fileBytes('db'), ...new Uint8Array(PAGE_SIZE)]));
    const db = Database.open('db', { vfs: vfs2 });
    expect(codes(db.integrityCheck())).toEqual(['FILE_SIZE_MISMATCH']);
    db.close();
  });

  it('T-INTEG-004 I11 compares entry contents, not only counts (same count, wrong RID / wrong key)', () => {
    const replaceFirst = (tree: BTree, make: (e: { key: Uint8Array; rid: { pageId: number; slot: number } }) => { key: Uint8Array; rid: { pageId: number; slot: number } }): void => {
      const e = tree.scan(null, null).next();
      if (!e) throw new Error('empty index');
      tree.delete(e);
      tree.insert(make(e));
    };
    // secondary index: same key, RID of a dead slot on a live heap page (dangling)
    const dangling = damage(({ sTree }) => replaceFirst(sTree, (e) => ({ key: e.key, rid: { pageId: e.rid.pageId, slot: e.rid.slot + 1000 } })));
    expect(dangling.summary.indexEntries).toBe(600);
    expect(codes(dangling)).toEqual(['INDEX_HEAP_MISMATCH']);
    // secondary index: same key, RID of another live row whose value differs (wrong mapping)
    const swapped = damage(({ sTree }) => {
      const c = sTree.scan(null, null);
      const first = c.next();
      let other = c.next();
      while (first && other && compareBytes(other.key, first.key) === 0) other = c.next();
      if (!first || !other) throw new Error('entries');
      const live = other.rid;
      replaceFirst(sTree, (e) => ({ key: e.key, rid: live }));
    });
    expect(codes(swapped)).toEqual(['INDEX_HEAP_MISMATCH']);
    // PK index: same RID, a key that no row has (wrong PK mapping)
    const wrongKey = damage(({ pkTree }) => replaceFirst(pkTree, (e) => ({ key: encodeKey('INTEGER', 999_999), rid: e.rid })));
    expect(wrongKey.summary.indexEntries).toBe(600);
    expect(codes(wrongKey)).toEqual(['INDEX_HEAP_MISMATCH']);
  });

  it('T-INTEG-003 report format: ok flag, summary counts and the 100-issue cap', () => {
    const vfs = baseImage();
    const db = Database.open('db', { vfs });
    const ok = db.integrityCheck();
    expect(ok.ok).toBe(true);
    expect(ok.summary).toMatchObject({ tables: 1, indexes: 2, rows: 300, indexEntries: 600, freePages: 1 });
    expect(ok.summary.pageCount).toBe(ok.summary.freePages + ok.summary.heapPages + ok.summary.btreePages + 1);
    db.close();
    const report = damage(({ pager }) => {
      for (let i = 0; i < 150; i++) pager.unpin(pager.allocate(PageType.HEAP));
    });
    expect(report.ok).toBe(false);
    expect(report.issues.length).toBe(100);
    expect(report.issues[0]).toEqual({ code: 'PAGE_LEAKED', pageId: expect.any(Number), message: expect.stringMatching(/not reachable/) });
  });
});
