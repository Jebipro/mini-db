import { BTree } from '../btree/btree.js';
import type { Catalog } from '../catalog/catalog.js';
import { columnTypes, pkIndexName, primaryKeyColumn, type IndexSchema } from '../catalog/schema.js';
import { ConstraintError, LimitError } from '../errors/errors.js';
import { HeapFile } from '../record/heap-file.js';
import type { Value } from '../record/value.js';
import type { BoundCreateIndex, BoundCreateTable, BoundDropIndex, BoundDropTable } from '../sql/bound.js';
import { keyOf, treeOf } from './indexes.js';
import type { ExecContext } from './operators.js';

/** DDL (G.14). Pages are freed inside the statement (DC-46); a failed statement is rolled back (DC-47). */

export function executeCreateTable(b: BoundCreateTable, ctx: ExecContext, catalog: Catalog): void {
  const heapHead = HeapFile.create(ctx.pager);
  const t = catalog.addTable({ name: b.name, columns: b.columns, heapHead });
  const pk = primaryKeyColumn(t);
  if (pk) {
    catalog.addIndex({ name: pkIndexName(t.name), table: t.name, column: pk.name, unique: true, root: BTree.create(ctx.pager), auto: true });
  }
}

export function executeDropTable(b: BoundDropTable, ctx: ExecContext, catalog: Catalog): void {
  for (const idx of b.table.indexes) treeOf(ctx.pager, idx).destroy();
  new HeapFile(ctx.pager, b.table.heapHead, columnTypes(b.table)).destroy();
  catalog.dropTable(b.table.name);
}

/** Builds the index from existing rows; a duplicate (UNIQUE) or oversized key fails the statement. */
export function executeCreateIndex(b: BoundCreateIndex, ctx: ExecContext, catalog: Catalog): void {
  const table = b.table;
  const column = table.columns[b.column] as { name: string };
  const idx: IndexSchema = { name: b.name, table: table.name, column: column.name, unique: b.unique, root: BTree.create(ctx.pager), auto: false };
  const tree = treeOf(ctx.pager, idx);
  const cursor = new HeapFile(ctx.pager, table.heapHead, columnTypes(table)).scan();
  for (let r = cursor.next(); r !== null; r = cursor.next()) {
    let k: Uint8Array | null;
    try {
      k = keyOf(table, idx, r.values);
    } catch (e) {
      if (e instanceof LimitError) throw new LimitError(e.code as never, e.message, { position: b.pos, source: ctx.source });
      throw e;
    }
    if (k === null) continue;
    if (b.unique && tree.findUnique(k) !== null) {
      throw new ConstraintError('UNIQUE_VIOLATION', `cannot create unique index ${b.name}: duplicate key ${String(r.values[b.column] as Value)}`, {
        position: b.pos,
        source: ctx.source,
      });
    }
    tree.insert({ key: k, rid: r.rid });
  }
  catalog.addIndex(idx);
}

export function executeDropIndex(b: BoundDropIndex, ctx: ExecContext, catalog: Catalog): void {
  treeOf(ctx.pager, b.index).destroy();
  catalog.dropIndex(b.index.name);
}
