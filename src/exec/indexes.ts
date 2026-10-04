import { BTree } from '../btree/btree.js';
import { encodeKey } from '../btree/key-codec.js';
import { columnIndex, type IndexSchema, type TableSchema } from '../catalog/schema.js';
import { invariant } from '../errors/assert.js';
import type { Value } from '../record/value.js';
import type { Pager } from '../storage/pager.js';

/** Index helpers shared by DML, DDL, the planner and the integrity check. */

/** Indexes in check order (G.14): the PRIMARY KEY index first, then by name. */
export function orderedIndexes(t: TableSchema): IndexSchema[] {
  return [...t.indexes].sort((a, b) => (a.auto !== b.auto ? (a.auto ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function indexColumn(t: TableSchema, idx: IndexSchema): number {
  const i = columnIndex(t, idx.column);
  invariant(i >= 0, `index ${idx.name} references missing column ${idx.column}`);
  return i;
}

export function treeOf(pager: Pager, idx: IndexSchema): BTree {
  return new BTree(pager, idx.root, idx.unique);
}

/** Index key of a row, or null when the column is NULL (NULLs are not indexed, DC-28). May throw KEY_TOO_LARGE. */
export function keyOf(t: TableSchema, idx: IndexSchema, row: readonly Value[]): Uint8Array | null {
  const ci = indexColumn(t, idx);
  const v = row[ci] as Value;
  if (v === null) return null;
  return encodeKey((t.columns[ci] as { type: 'INTEGER' | 'TEXT' | 'BOOLEAN' }).type, v);
}
