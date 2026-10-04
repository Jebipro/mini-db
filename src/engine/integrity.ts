import { Catalog, CATALOG_TYPES } from '../catalog/catalog.js';
import { MiniDbError } from '../errors/errors.js';
import { HeapFile } from '../record/heap-file.js';
import { checkOwnership, type IntegrityIssue, type PageOwner } from '../storage/issues.js';
import { CATALOG_ROOT_PAGE, PAGE_SIZE } from '../storage/layout.js';
import type { Pager } from '../storage/pager.js';
import { columnTypes } from '../catalog/schema.js';
import { BTree } from '../btree/btree.js';
import { keyOf } from '../exec/indexes.js';
import { toHex } from '../util/bytes.js';

export type { IntegrityIssue, IntegrityCode } from '../storage/issues.js';

export interface IntegrityReport {
  ok: boolean;
  issues: IntegrityIssue[];
  summary: {
    pageCount: number;
    freePages: number;
    heapPages: number;
    btreePages: number;
    tables: number;
    indexes: number;
    rows: number;
    indexEntries: number;
  };
}

const MAX_ISSUES = 100;

function isCorruption(e: unknown): e is MiniDbError {
  return e instanceof MiniDbError && e.name === 'CorruptionError';
}

/**
 * db.integrityCheck() (E.4, G.10 I1–I12). Reports findings instead of throwing; a CorruptionError raised
 * while reading pages is reported as PAGE_CORRUPT (and, per DC-49, leaves the pager FAILED).
 */
export function checkIntegrity(pager: Pager, walFrames: number): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const add = (i: IntegrityIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(i);
  };
  const pageCount = pager.pageCount;
  const summary: IntegrityReport['summary'] = {
    pageCount,
    freePages: 0,
    heapPages: 0,
    btreePages: 0,
    tables: 0,
    indexes: 0,
    rows: 0,
    indexEntries: 0,
  };
  const report = (): IntegrityReport => ({ ok: issues.length === 0, issues, summary });

  // I1 header
  const h = pager.headerFields();
  if (h.catalogRoot !== CATALOG_ROOT_PAGE) add({ code: 'HEADER_INVALID', pageId: 0, message: `catalogRoot is ${h.catalogRoot}` });
  if (pageCount < 2) add({ code: 'HEADER_INVALID', pageId: 0, message: `pageCount is ${pageCount}` });
  const fileSize = pager.dataFileSize();
  if (walFrames === 0 && fileSize !== pageCount * PAGE_SIZE) {
    add({ code: 'FILE_SIZE_MISMATCH', message: `data file is ${fileSize} bytes, expected ${pageCount * PAGE_SIZE}` });
  }

  // I2 every page readable and valid
  for (let id = 0; id < pageCount; id++) {
    try {
      pager.unpin(pager.pin(id));
    } catch (e) {
      if (!isCorruption(e)) throw e;
      add({ code: 'PAGE_CORRUPT', pageId: id, message: e.message });
      return report(); // the pager is FAILED now (DC-49)
    }
  }

  const owners: PageOwner[] = [];
  // I4 freelist
  try {
    const free = pager.freelistPages();
    summary.freePages = free.length;
    owners.push({ owner: 'freelist', pages: free });
  } catch (e) {
    if (!isCorruption(e)) throw e;
    add({ code: 'FREELIST_INVALID', message: e.message });
  }

  // I12 catalog, then I5–I7 for every heap
  let catalog: Catalog;
  try {
    catalog = Catalog.load(pager);
  } catch (e) {
    if (!isCorruption(e)) throw e;
    add({ code: 'CATALOG_INVALID', message: e.message });
    return report();
  }
  const cat = new HeapFile(pager, CATALOG_ROOT_PAGE, CATALOG_TYPES).check('mdb_catalog');
  cat.issues.forEach(add);
  owners.push({ owner: 'mdb_catalog', pages: cat.pages });
  summary.heapPages += cat.pages.length;
  for (const t of catalog.tables()) {
    summary.tables++;
    const res = new HeapFile(pager, t.heapHead, columnTypes(t)).check(
      t.name,
      t.columns.map((c) => c.notNull),
    );
    res.issues.forEach(add);
    owners.push({ owner: t.name, pages: res.pages });
    summary.heapPages += res.pages.length;
    summary.rows += res.rows;
    if (res.issues.length > 0) continue;
    // I8–I10 per index, I11 index ↔ heap
    let expected: string[] | null = null;
    for (const idx of t.indexes) {
      summary.indexes++;
      const bt = new BTree(pager, idx.root, idx.unique).check(idx.name);
      bt.issues.forEach(add);
      owners.push({ owner: idx.name, pages: bt.pages });
      summary.btreePages += bt.pages.length;
      summary.indexEntries += bt.entries.length;
      if (bt.issues.length > 0) continue;
      expected = [];
      const cursor = new HeapFile(pager, t.heapHead, columnTypes(t)).scan();
      for (let r = cursor.next(); r !== null; r = cursor.next()) {
        const k = keyOf(t, idx, r.values);
        if (k !== null) expected.push(`${toHex(k)}|${r.rid.pageId}:${r.rid.slot}`);
      }
      const got = bt.entries.map((e) => `${toHex(e.key)}|${e.rid.pageId}:${e.rid.slot}`);
      expected.sort();
      got.sort();
      if (expected.length !== got.length || expected.some((x, i) => x !== got[i])) {
        add({ code: 'INDEX_HEAP_MISMATCH', object: idx.name, message: `index ${idx.name} has ${got.length} entries, the table implies ${expected.length} (or they differ)` });
      }
    }
  }

  // I3 ownership
  checkOwnership(pageCount, owners).forEach(add);
  return report();
}
