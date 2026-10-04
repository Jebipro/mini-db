import { describe, expect, it } from 'vitest';
import { BTree } from '../../src/btree/btree.js';
import { encodeKey } from '../../src/btree/key-codec.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { Database } from '../../src/engine/database.js';
import { checkIntegrity, type IntegrityReport } from '../../src/engine/integrity.js';
import { HeapFile } from '../../src/record/heap-file.js';
import { hp } from '../../src/record/heap-page.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { deterministicEntropy } from '../support/db.js';
import { inTxn, openPager } from '../support/pager-harness.js';

/**
 * REVIEW-INT-001: I11 must compare the index entry multiset, not only its size. The existing T-INTEG-002 case
 * deletes an entry (count changes), so a count-only I11 survives the whole suite (mutation M11). These cases keep
 * the entry count identical. Also I3 PAGE_MULTI_OWNED (two tables sharing a heap page).
 */

function image(): MemoryVfs {
  const vfs = new MemoryVfs();
  const db = Database.open('db', { vfs, entropy: deterministicEntropy(3) });
  db.executeScript('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT NOT NULL); CREATE INDEX ts ON t (s); CREATE TABLE u (a INTEGER);');
  for (let i = 0; i < 40; i++) db.execute(`INSERT INTO t VALUES (${i}, 's${i % 7}')`);
  db.execute('INSERT INTO u VALUES (1)');
  expect(db.integrityCheck().issues).toEqual([]);
  db.close();
  return vfs;
}

function damage(fn: (p: Pager, pk: BTree, si: BTree, cat: Catalog) => void): IntegrityReport {
  const pager = openPager(image(), 'db', { initialize: Catalog.initialize });
  const cat = Catalog.load(pager);
  const t = cat.getTable('t');
  if (!t) throw new Error('no t');
  const pk = new BTree(pager, (t.indexes.find((i) => i.auto) as { root: number }).root, true);
  const si = new BTree(pager, (t.indexes.find((i) => !i.auto) as { root: number }).root, false);
  inTxn(pager, () => fn(pager, pk, si, cat));
  const r = checkIntegrity(pager, pager.stats().wal.frames);
  pager.close();
  return r;
}

const codes = (r: IntegrityReport): string[] => [...new Set(r.issues.map((i) => i.code))];

describe('REVIEW-INT-001 integrity check sensitivity', () => {
  it('I11: same entry count, entry RID points at a dead slot of a live page', () => {
    const r = damage((_p, _pk, si) => {
      const c = si.scan(null, null);
      const a = c.next();
      const b = c.next();
      if (!a || !b) throw new Error('entries');
      si.delete(a);
      si.insert({ key: a.key, rid: { pageId: b.rid.pageId, slot: b.rid.slot + 1000 } }); // live page, dead slot
    });
    expect(codes(r)).toContain('INDEX_HEAP_MISMATCH');
  });

  it('I11: same entry count, wrong key in the unique PK index', () => {
    const r = damage((_p, pk) => {
      const c = pk.scan(null, null);
      const a = c.next();
      if (!a) throw new Error('entries');
      pk.delete(a);
      pk.insert({ key: encodeKey('INTEGER', 999_999), rid: a.rid });
    });
    expect(codes(r)).toContain('INDEX_HEAP_MISMATCH');
  });

  it('I3: a heap page reachable from two tables is PAGE_MULTI_OWNED', () => {
    const r = damage((p, _pk, _si, cat) => {
      const t = cat.getTable('t') as { heapHead: number };
      const u = cat.getTable('u') as { heapHead: number };
      const tPages = new HeapFile(p, t.heapHead, ['INTEGER', 'TEXT']).pageIds();
      const last = tPages[tPages.length - 1] as number;
      const ref = p.pin(u.heapHead);
      p.markDirty(ref);
      hp.setNext(ref.data, last); // u's chain now continues into t's last page
      hp.setTail(ref.data, last);
      p.unpin(ref);
    });
    expect(codes(r)).toContain('PAGE_MULTI_OWNED');
  });
});
