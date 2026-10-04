import { invariant } from '../errors/assert.js';
import { CorruptionError } from '../errors/errors.js';
import { HeapFile } from '../record/heap-file.js';
import type { ColumnType, Rid, Value } from '../record/value.js';
import { CATALOG_ROOT_PAGE, MAX_COLUMNS, MAX_IDENTIFIER_BYTES, PageType } from '../storage/layout.js';
import { pageTypeOf } from '../storage/page.js';
import type { Pager, PageId } from '../storage/pager.js';
import {
  IDENTIFIER_RE,
  PK_INDEX_PREFIX,
  pkIndexName,
  primaryKeyColumn,
  type ColumnSchema,
  type IndexSchema,
  type TableSchema,
} from './schema.js';

/** Fixed schema of `mdb_catalog` (D.7). */
export const CATALOG_TYPES: readonly ColumnType[] = [
  'TEXT', // kind
  'TEXT', // name
  'TEXT', // table_name
  'INTEGER', // position
  'TEXT', // data_type
  'BOOLEAN', // not_null
  'BOOLEAN', // primary_key
  'BOOLEAN', // is_unique
  'INTEGER', // root_page
  'TEXT', // column_name
];

/**
 * D.7: every table with a PRIMARY KEY has its automatic unique index mdb_pk_<table> (enabled in P13).
 */
export const REQUIRE_PK_INDEX = true;

type CatalogRow = [string, string, string, number, string | null, boolean | null, boolean | null, boolean | null, number | null, string | null];

function invalid(message: string): CorruptionError {
  return new CorruptionError('CATALOG_INVALID', `catalog: ${message}`);
}

function validName(name: string, allowAuto = false): boolean {
  const limit = allowAuto ? MAX_IDENTIFIER_BYTES + PK_INDEX_PREFIX.length : MAX_IDENTIFIER_BYTES;
  return IDENTIFIER_RE.test(name) && name.length <= limit;
}

/**
 * Self-describing catalog (D.7): rows for tables, columns and indexes in the heap at page 1.
 * Rows are only inserted or deleted, never updated, so their RIDs are stable and cached here.
 */
export class Catalog {
  private readonly tablesByName = new Map<string, TableSchema>();
  private readonly indexesByName = new Map<string, IndexSchema>();
  /** Catalog row RIDs per table name (table, column and index rows of that table). */
  private readonly rowsOfTable = new Map<string, Rid[]>();
  private readonly rowOfIndex = new Map<string, Rid>();

  private constructor(
    private readonly pager: Pager,
    private readonly heap: HeapFile,
  ) {}

  /** Bootstrap hook (DC-63): the catalog heap head is page 1. */
  static initialize(pager: Pager): void {
    const head = HeapFile.create(pager);
    invariant(head === CATALOG_ROOT_PAGE, `catalog head allocated at page ${head}`);
    pager.setRootPointer(head);
  }

  static heapOf(pager: Pager): HeapFile {
    return new HeapFile(pager, CATALOG_ROOT_PAGE, CATALOG_TYPES);
  }

  /** Loads and validates the catalog (D.7). Throws CorruptionError CATALOG_INVALID. */
  static load(pager: Pager): Catalog {
    if (pager.getRootPointer() !== CATALOG_ROOT_PAGE) throw invalid(`catalog root is ${pager.getRootPointer()}, expected ${CATALOG_ROOT_PAGE}`);
    if (pager.pageCount < 2) throw invalid(`page count ${pager.pageCount} < 2`);
    const cat = new Catalog(pager, Catalog.heapOf(pager));
    const tableRows: Array<{ rid: Rid; row: CatalogRow }> = [];
    const columnRows: Array<{ rid: Rid; row: CatalogRow }> = [];
    const indexRows: Array<{ rid: Rid; row: CatalogRow }> = [];
    const cursor = cat.heap.scan();
    for (let r = cursor.next(); r !== null; r = cursor.next()) {
      const row = r.values as CatalogRow;
      if (row[0] === null || row[1] === null || row[2] === null || row[3] === null) throw invalid('NULL in a NOT NULL catalog column');
      if (row[0] === 'table') tableRows.push({ rid: r.rid, row });
      else if (row[0] === 'column') columnRows.push({ rid: r.rid, row });
      else if (row[0] === 'index') indexRows.push({ rid: r.rid, row });
      else throw invalid(`unknown kind '${row[0]}'`);
    }

    const names = new Set<string>();
    for (const { rid, row } of tableRows) {
      const [, name, tableName, count, , , , , root] = row;
      if (!validName(name) || name !== tableName || name.startsWith('mdb_')) throw invalid(`bad table name '${name}'`);
      if (names.has(name)) throw invalid(`duplicate object name '${name}'`);
      names.add(name);
      if (!Number.isInteger(count) || count < 1 || count > MAX_COLUMNS) throw invalid(`table ${name} has column count ${count}`);
      if (root === null) throw invalid(`table ${name} has no heap page`);
      cat.checkRoot(root, name, [PageType.HEAP]);
      cat.tablesByName.set(name, { name, columns: new Array<ColumnSchema>(count), heapHead: root, indexes: [] });
      cat.rowsOfTable.set(name, [rid]);
    }
    for (const { rid, row } of columnRows) {
      const [, name, tableName, position, dataType, notNull, primaryKey] = row;
      const t = cat.tablesByName.get(tableName);
      if (!t) throw invalid(`column ${name} belongs to unknown table ${tableName}`);
      if (!validName(name)) throw invalid(`bad column name '${name}'`);
      if (!Number.isInteger(position) || position < 0 || position >= t.columns.length || t.columns[position] !== undefined) {
        throw invalid(`table ${tableName} column position ${position} invalid or duplicated`);
      }
      if (dataType !== 'INTEGER' && dataType !== 'TEXT' && dataType !== 'BOOLEAN') throw invalid(`column ${tableName}.${name} has type ${dataType}`);
      if (notNull === null || primaryKey === null) throw invalid(`column ${tableName}.${name} lacks flags`);
      t.columns[position] = { name, type: dataType, notNull, primaryKey, position };
      (cat.rowsOfTable.get(tableName) as Rid[]).push(rid);
    }
    for (const t of cat.tablesByName.values()) {
      for (let i = 0; i < t.columns.length; i++) if (t.columns[i] === undefined) throw invalid(`table ${t.name} is missing column ${i}`);
      const seen = new Set<string>();
      for (const c of t.columns) {
        if (seen.has(c.name)) throw invalid(`table ${t.name} has duplicate column ${c.name}`);
        seen.add(c.name);
      }
      const pks = t.columns.filter((c) => c.primaryKey);
      if (pks.length > 1) throw invalid(`table ${t.name} has ${pks.length} primary key columns`);
      if (pks[0] && !pks[0].notNull) throw invalid(`primary key ${t.name}.${pks[0].name} is nullable`);
    }
    for (const { rid, row } of indexRows) {
      const [, name, tableName, position, , , , unique, root, columnName] = row;
      const auto = name.startsWith(PK_INDEX_PREFIX);
      if (!validName(name, auto) || (name.startsWith('mdb_') && !auto)) throw invalid(`bad index name '${name}'`);
      if (names.has(name)) throw invalid(`duplicate object name '${name}'`);
      names.add(name);
      const t = cat.tablesByName.get(tableName);
      if (!t) throw invalid(`index ${name} on unknown table ${tableName}`);
      if (position !== 0 || unique === null || root === null || columnName === null) throw invalid(`index ${name} has malformed fields`);
      const col = t.columns.find((c) => c.name === columnName);
      if (!col) throw invalid(`index ${name} on unknown column ${tableName}.${columnName}`);
      if (auto && (name !== pkIndexName(tableName) || !col.primaryKey || !unique)) throw invalid(`auto index ${name} does not match the primary key`);
      cat.checkRoot(root, name, [PageType.BTREE_LEAF, PageType.BTREE_INTERNAL]);
      const idx: IndexSchema = { name, table: tableName, column: columnName, unique, root, auto };
      t.indexes.push(idx);
      cat.indexesByName.set(name, idx);
      cat.rowOfIndex.set(name, rid);
      (cat.rowsOfTable.get(tableName) as Rid[]).push(rid);
    }
    for (const t of cat.tablesByName.values()) {
      t.indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const pk = primaryKeyColumn(t);
      if (REQUIRE_PK_INDEX && pk && !cat.indexesByName.has(pkIndexName(t.name))) throw invalid(`table ${t.name} lacks its primary key index`);
    }
    return cat;
  }

  private checkRoot(root: number, owner: string, types: number[]): void {
    if (!Number.isInteger(root) || root < 2 || root >= this.pager.pageCount) throw invalid(`${owner} root page ${root} out of range`);
    const ref = this.pager.pin(root);
    let ok: boolean;
    try {
      ok = types.includes(pageTypeOf(ref.data));
    } finally {
      this.pager.unpin(ref);
    }
    if (!ok) throw invalid(`${owner} root page ${root} has the wrong page type`);
  }

  getTable(name: string): TableSchema | undefined {
    return this.tablesByName.get(name);
  }

  getIndex(name: string): IndexSchema | undefined {
    return this.indexesByName.get(name);
  }

  /** Tables and indexes share one namespace (DC-44). */
  objectExists(name: string): boolean {
    return this.tablesByName.has(name) || this.indexesByName.has(name);
  }

  tables(): TableSchema[] {
    return [...this.tablesByName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  indexes(): IndexSchema[] {
    return [...this.indexesByName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private insertRow(row: CatalogRow): Rid {
    return this.heap.insert(row as unknown as Value[]);
  }

  /** Writes table + column rows (inside the caller's transaction). */
  addTable(t: { name: string; columns: ColumnSchema[]; heapHead: PageId }): TableSchema {
    invariant(!this.objectExists(t.name), `addTable: ${t.name} exists`);
    const rids = [this.insertRow(['table', t.name, t.name, t.columns.length, null, null, null, null, t.heapHead, null])];
    t.columns.forEach((c, i) => {
      invariant(c.position === i, 'column positions must be 0..n-1');
      rids.push(this.insertRow(['column', c.name, t.name, i, c.type, c.notNull, c.primaryKey, null, null, null]));
    });
    const schema: TableSchema = { name: t.name, columns: t.columns.map((c) => ({ ...c })), heapHead: t.heapHead, indexes: [] };
    this.tablesByName.set(t.name, schema);
    this.rowsOfTable.set(t.name, rids);
    return schema;
  }

  addIndex(i: IndexSchema): void {
    const t = this.tablesByName.get(i.table);
    invariant(t !== undefined && !this.objectExists(i.name), `addIndex: bad index ${i.name}`);
    const rid = this.insertRow(['index', i.name, i.table, 0, null, null, null, i.unique, i.root, i.column]);
    const idx = { ...i };
    t.indexes.push(idx);
    t.indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.indexesByName.set(i.name, idx);
    this.rowOfIndex.set(i.name, rid);
    (this.rowsOfTable.get(i.table) as Rid[]).push(rid);
  }

  /** Deletes the index row; freeing its pages is the caller's job. */
  dropIndex(name: string): void {
    const idx = this.indexesByName.get(name);
    const rid = this.rowOfIndex.get(name);
    invariant(idx !== undefined && rid !== undefined, `dropIndex: no index ${name}`);
    this.heap.delete(rid);
    const t = this.tablesByName.get(idx.table) as TableSchema;
    t.indexes = t.indexes.filter((x) => x.name !== name);
    this.indexesByName.delete(name);
    this.rowOfIndex.delete(name);
    this.rowsOfTable.set(
      idx.table,
      (this.rowsOfTable.get(idx.table) as Rid[]).filter((r) => r.pageId !== rid.pageId || r.slot !== rid.slot),
    );
  }

  /** Deletes all catalog rows of the table (and its indexes); freeing pages is the caller's job. */
  dropTable(name: string): void {
    const t = this.tablesByName.get(name);
    invariant(t !== undefined, `dropTable: no table ${name}`);
    for (const rid of this.rowsOfTable.get(name) as Rid[]) this.heap.delete(rid);
    for (const i of t.indexes) {
      this.indexesByName.delete(i.name);
      this.rowOfIndex.delete(i.name);
    }
    this.tablesByName.delete(name);
    this.rowsOfTable.delete(name);
  }

}
