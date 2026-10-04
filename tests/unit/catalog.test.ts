import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Catalog, CATALOG_TYPES } from '../../src/catalog/catalog.js';
import { pkIndexName, type ColumnSchema } from '../../src/catalog/schema.js';
import { BTree } from '../../src/btree/btree.js';
import { checkIntegrity } from '../../src/engine/integrity.js';
import { CorruptionError } from '../../src/errors/errors.js';
import { HeapFile } from '../../src/record/heap-file.js';
import type { ColumnType } from '../../src/record/value.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import { createRng } from '../../src/util/prng.js';
import { inTxn, openPager } from '../support/pager-harness.js';

function openDb(vfs: MemoryVfs, seed = 1234): Pager {
  const r = createRng(seed);
  return openPager(vfs, 'db', { initialize: Catalog.initialize, entropy: (n) => r.bytes(n) });
}

function cols(...defs: Array<[string, ColumnType, boolean?, boolean?]>): ColumnSchema[] {
  return defs.map(([name, type, notNull = false, primaryKey = false], position) => ({
    name,
    type,
    notNull: notNull || primaryKey,
    primaryKey,
    position,
  }));
}

function createTable(p: Pager, cat: Catalog, name: string, columns: ColumnSchema[]): void {
  inTxn(p, () => {
    cat.addTable({ name, columns, heapHead: HeapFile.create(p) });
    const pk = columns.find((c) => c.primaryKey);
    if (pk) cat.addIndex({ name: pkIndexName(name), table: name, column: pk.name, unique: true, root: BTree.create(p), auto: true });
  });
}

describe('catalog', () => {
  it('T-CAT-001 tables and indexes are created, looked up, dropped and persist across reopen', () => {
    const vfs = new MemoryVfs();
    let p = openDb(vfs);
    let cat = Catalog.load(p);
    expect(cat.tables()).toEqual([]);
    createTable(p, cat, 'users', cols(['id', 'INTEGER', true, true], ['name', 'TEXT', true], ['ok', 'BOOLEAN']));
    createTable(p, cat, 'logs', cols(['msg', 'TEXT']));
    const root = inTxn(p, () => {
      const root = BTree.create(p);
      cat.addIndex({ name: 'idx_name', table: 'users', column: 'name', unique: false, root, auto: false });
      return root;
    });
    p.close();
    p = openDb(vfs);
    cat = Catalog.load(p);
    expect(cat.tables().map((t) => t.name)).toEqual(['logs', 'users']);
    const users = cat.getTable('users');
    expect(users?.columns).toEqual(cols(['id', 'INTEGER', true, true], ['name', 'TEXT', true], ['ok', 'BOOLEAN']));
    expect(users?.indexes.map((i) => i.name)).toEqual(['idx_name', 'mdb_pk_users']);
    expect(users?.indexes[0]).toEqual({ name: 'idx_name', table: 'users', column: 'name', unique: false, root, auto: false });
    expect(checkIntegrity(p, p.stats().wal.frames).issues).toEqual([]);
    expect(cat.getIndex('idx_name')?.root).toBe(root);
    expect(cat.objectExists('idx_name')).toBe(true);
    inTxn(p, () => cat.dropIndex('idx_name'));
    inTxn(p, () => cat.dropTable('logs'));
    p.close();
    p = openDb(vfs);
    cat = Catalog.load(p);
    expect(cat.tables().map((t) => t.name)).toEqual(['users']);
    expect(cat.getTable('users')?.indexes.map((i) => i.name)).toEqual(['mdb_pk_users']);
    expect(cat.getIndex('idx_name')).toBeUndefined();
    p.close();
  });

  it('T-CAT-002 the shared namespace is checked by objectExists (names are normalized by the SQL layer)', () => {
    const vfs = new MemoryVfs();
    const p = openDb(vfs);
    const cat = Catalog.load(p);
    createTable(p, cat, 't', cols(['a', 'INTEGER']));
    expect(cat.objectExists('t')).toBe(true);
    expect(cat.objectExists('u')).toBe(false);
    expect(() => createTable(p, cat, 't', cols(['a', 'INTEGER']))).toThrow(/exists/);
    p.close();
  });

  it('T-CAT-003 semantically invalid catalog content (valid CRCs) is CATALOG_INVALID', () => {
    const bad: Array<[string, (h: HeapFile, p: Pager) => void]> = [
      ['unknown kind', (h) => h.insert(['view', 'v', 'v', 1, null, null, null, null, 2, null])],
      ['column of unknown table', (h) => h.insert(['column', 'a', 'nope', 0, 'INTEGER', false, false, null, null, null])],
      ['table without its columns', (h, p) => h.insert(['table', 'x', 'x', 2, null, null, null, null, HeapFile.create(p), null])],
      ['bad type', (h, p) => {
        h.insert(['table', 'x', 'x', 1, null, null, null, null, HeapFile.create(p), null]);
        h.insert(['column', 'a', 'x', 0, 'REAL', false, false, null, null, null]);
      }],
      ['root out of range', (h) => h.insert(['table', 'x', 'x', 1, null, null, null, null, 999, null])],
      ['nullable primary key', (h, p) => {
        h.insert(['table', 'x', 'x', 1, null, null, null, null, HeapFile.create(p), null]);
        h.insert(['column', 'a', 'x', 0, 'INTEGER', false, true, null, null, null]);
      }],
      ['index root of the wrong type', (h, p) => {
        h.insert(['table', 'x', 'x', 1, null, null, null, null, HeapFile.create(p), null]);
        h.insert(['column', 'a', 'x', 0, 'INTEGER', false, false, null, null, null]);
        h.insert(['index', 'i', 'x', 0, null, null, null, false, HeapFile.create(p), 'a']);
      }],
      ['uppercase name', (h, p) => {
        h.insert(['table', 'X', 'X', 1, null, null, null, null, HeapFile.create(p), null]);
        h.insert(['column', 'a', 'X', 0, 'INTEGER', false, false, null, null, null]);
      }],
    ];
    for (const [name, corrupt] of bad) {
      const vfs = new MemoryVfs();
      const p = openDb(vfs);
      inTxn(p, () => corrupt(new HeapFile(p, 1, CATALOG_TYPES), p));
      let err: unknown;
      try {
        Catalog.load(p);
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(CorruptionError);
      expect((err as CorruptionError).code, name).toBe('CATALOG_INVALID');
      p.close();
    }
  });

  it('T-CAT-004 dropping a table frees all its pages and the ownership check passes', () => {
    const vfs = new MemoryVfs();
    const p = openDb(vfs);
    const cat = Catalog.load(p);
    createTable(p, cat, 't', cols(['s', 'TEXT']));
    const t = cat.getTable('t');
    const heap = new HeapFile(p, t?.heapHead as number, ['TEXT']);
    inTxn(p, () => {
      for (let i = 0; i < 10; i++) heap.insert(['x'.repeat(1500)]);
    });
    const pages = heap.pageIds().length;
    expect(pages).toBe(5);
    expect(checkIntegrity(p, p.stats().wal.frames)).toMatchObject({ ok: true, summary: { tables: 1, rows: 10 } });
    const freeBefore = p.freelistCount;
    inTxn(p, () => {
      heap.destroy();
      cat.dropTable('t');
    });
    expect(p.freelistCount - freeBefore).toBe(pages);
    const report = checkIntegrity(p, p.stats().wal.frames);
    expect(report.issues).toEqual([]);
    expect(report.summary.freePages).toBe(pages);
    p.close();
    // after a checkpoint the file size must equal pageCount × 4096
    const q = openDb(vfs);
    expect(checkIntegrity(q, 0).ok).toBe(true);
    q.close();
  });

  it('T-FMT-002 an empty database built with fixed entropy matches the v1 fixture byte for byte', () => {
    const vfs = new MemoryVfs();
    openDb(vfs, 42).close();
    const bytes = vfs.fileBytes('db');
    expect(bytes.length).toBe(8192);
    const fixture = new URL('../fixtures/empty-v1.db', import.meta.url);
    if (process.env.UPDATE_FIXTURES === '1' || !existsSync(fixture)) {
      // creating or changing this fixture requires a format-version review recorded in DECISIONS.md (D.9)
      mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true });
      writeFileSync(fixture, bytes);
    }
    expect(bytes).toEqual(new Uint8Array(readFileSync(fixture)));
  });
});
