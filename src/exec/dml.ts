import { ConstraintError, LimitError, MiniDbError, type SourcePosition } from '../errors/errors.js';
import { columnTypes, type IndexSchema, type TableSchema } from '../catalog/schema.js';
import { HeapFile } from '../record/heap-file.js';
import { encodeRow } from '../record/row-codec.js';
import { ridEquals, ridKey, type Rid, type Value } from '../record/value.js';
import type { BoundDelete, BoundInsert, BoundUpdate } from '../sql/bound.js';
import { evaluate } from './eval.js';
import { indexColumn, keyOf, orderedIndexes, treeOf } from './indexes.js';
import { collectRows, type ExecContext } from './operators.js';
import { planScan } from './planner.js';
import type { PlanOptions } from './plan.js';
import { toHex } from '../util/bytes.js';

/** INSERT / UPDATE / DELETE with index maintenance (G.14). Errors leave the statement for the engine to roll back. */

function at(e: unknown, pos: SourcePosition, ctx: ExecContext): unknown {
  // position-less limit errors (row/key size) are reported at the row / statement (H.4)
  if (e instanceof LimitError && e.position === undefined) return new LimitError(e.code as never, e.message, { position: pos, source: ctx.source });
  return e;
}

function checkRow(table: TableSchema, values: Value[], pos: SourcePosition, ctx: ExecContext): void {
  for (const c of table.columns) {
    if (c.notNull && values[c.position] === null) {
      throw new ConstraintError('NOT_NULL_VIOLATION', `NULL in NOT NULL column ${table.name}.${c.name}`, { position: pos, source: ctx.source });
    }
  }
  try {
    encodeRow(columnTypes(table), values);
  } catch (e) {
    throw e instanceof MiniDbError ? at(e, pos, ctx) : e;
  }
}

function key(table: TableSchema, idx: IndexSchema, row: readonly Value[], pos: SourcePosition, ctx: ExecContext): Uint8Array | null {
  try {
    return keyOf(table, idx, row);
  } catch (e) {
    throw at(e, pos, ctx);
  }
}

function uniqueViolation(table: TableSchema, idx: IndexSchema, value: Value, pos: SourcePosition, ctx: ExecContext): ConstraintError {
  return new ConstraintError('UNIQUE_VIOLATION', `duplicate key ${String(value)} in index ${idx.name} (column ${idx.column})`, {
    position: pos,
    source: ctx.source,
  });
}

export function executeInsert(b: BoundInsert, ctx: ExecContext): number {
  const table = b.table;
  const heap = new HeapFile(ctx.pager, table.heapHead, columnTypes(table));
  const indexes = orderedIndexes(table);
  for (const row of b.rows) {
    const values: Value[] = table.columns.map(() => null);
    row.values.forEach((e, k) => {
      values[b.targets[k] as number] = evaluate(e, [], ctx);
    });
    checkRow(table, values, row.pos, ctx);
    const keys = indexes.map((idx) => {
      const k = key(table, idx, values, row.pos, ctx);
      if (k !== null && idx.unique && treeOf(ctx.pager, idx).findUnique(k) !== null) {
        throw uniqueViolation(table, idx, values[indexColumn(table, idx)] as Value, row.pos, ctx);
      }
      return k;
    });
    const rid = heap.insert(values);
    indexes.forEach((idx, i) => {
      const k = keys[i] as Uint8Array | null;
      if (k !== null) treeOf(ctx.pager, idx).insert({ key: k, rid });
    });
  }
  return b.rows.length;
}

interface Target {
  rid: Rid;
  values: Value[];
}

function collectTargets(table: TableSchema, where: BoundUpdate['where'], ctx: ExecContext, opts: PlanOptions): Target[] {
  // DC-62: materialize every target before changing anything (no Halloween problem)
  return collectRows(planScan(table, where, opts), ctx).map((r) => ({ rid: r.rid as Rid, values: r.values }));
}

export function executeUpdate(b: BoundUpdate, ctx: ExecContext, opts: PlanOptions): number {
  const table = b.table;
  const heap = new HeapFile(ctx.pager, table.heapHead, columnTypes(table));
  const targets = collectTargets(table, b.where, ctx, opts);
  const newRows = targets.map((t) => {
    const next = [...t.values];
    for (const a of b.assignments) next[a.index] = evaluate(a.value, t.values, ctx); // SET uses the old row (F.6)
    return next;
  });
  newRows.forEach((v) => checkRow(table, v, b.pos, ctx));

  const setCols = new Set(b.assignments.map((a) => a.index));
  const indexes = orderedIndexes(table);
  const touched = indexes.filter((idx) => setCols.has(indexColumn(table, idx)));
  const newKeys = new Map<IndexSchema, Array<Uint8Array | null>>();
  for (const idx of touched) newKeys.set(idx, newRows.map((v) => key(table, idx, v, b.pos, ctx)));

  // DC-31: statement-level uniqueness — duplicates among new keys, or a new key owned by a non-target row
  const targetRids = new Set(targets.map((t) => ridKey(t.rid)));
  for (const idx of touched) {
    if (!idx.unique) continue;
    const keys = newKeys.get(idx) as Array<Uint8Array | null>;
    const seen = new Set<string>();
    keys.forEach((k, i) => {
      if (k === null) return;
      const value = (newRows[i] as Value[])[indexColumn(table, idx)] as Value;
      const hex = toHex(k);
      if (seen.has(hex)) throw uniqueViolation(table, idx, value, b.pos, ctx);
      seen.add(hex);
      const owner = treeOf(ctx.pager, idx).findUnique(k);
      if (owner !== null && !targetRids.has(ridKey(owner))) throw uniqueViolation(table, idx, value, b.pos, ctx);
    });
  }

  // apply: heap first (rows may move), then per index delete all old entries before inserting new ones
  const newRids = targets.map((t, i) => heap.update(t.rid, newRows[i] as Value[]));
  for (const idx of indexes) {
    const changed = setCols.has(indexColumn(table, idx));
    const tree = treeOf(ctx.pager, idx);
    const moves: Array<{ oldKey: Uint8Array | null; oldRid: Rid; newKey: Uint8Array | null; newRid: Rid }> = [];
    targets.forEach((t, i) => {
      const newRid = newRids[i] as Rid;
      if (!changed && ridEquals(t.rid, newRid)) return;
      const oldKey = keyOf(table, idx, t.values);
      const newKey = changed ? ((newKeys.get(idx) as Array<Uint8Array | null>)[i] as Uint8Array | null) : oldKey;
      moves.push({ oldKey, oldRid: t.rid, newKey, newRid });
    });
    for (const m of moves) if (m.oldKey !== null) tree.delete({ key: m.oldKey, rid: m.oldRid });
    for (const m of moves) if (m.newKey !== null) tree.insert({ key: m.newKey, rid: m.newRid });
  }
  return targets.length;
}

export function executeDelete(b: BoundDelete, ctx: ExecContext, opts: PlanOptions): number {
  const table = b.table;
  const heap = new HeapFile(ctx.pager, table.heapHead, columnTypes(table));
  const indexes = orderedIndexes(table);
  const targets = collectTargets(table, b.where, ctx, opts);
  for (const t of targets) {
    for (const idx of indexes) {
      const k = keyOf(table, idx, t.values);
      if (k !== null) treeOf(ctx.pager, idx).delete({ key: k, rid: t.rid });
    }
    heap.delete(t.rid);
  }
  return targets.length;
}
