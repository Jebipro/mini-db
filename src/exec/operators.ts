import { assertNever } from '../errors/assert.js';
import { HeapFile } from '../record/heap-file.js';
import type { Rid, Value } from '../record/value.js';
import type { Pager } from '../storage/pager.js';
import type { BTreeCursor, KeyBound } from '../btree/btree.js';
import { encodeKey } from '../btree/key-codec.js';
import { columnTypes, type ColumnSchema } from '../catalog/schema.js';
import { CorruptionError } from '../errors/errors.js';
import { treeOf } from './indexes.js';
import { compareNullable, evaluate, isTrue, type EvalContext } from './eval.js';
import type { PlanNode, ScanBound } from './plan.js';

/** Volcano iterator (F.9). Rows are copies; no page pin is held between next() calls. */
export interface RowSource {
  open(): void;
  next(): Row | null;
  close(): void;
}

export interface Row {
  rid: Rid | null;
  values: Value[];
}

export interface ExecContext extends EvalContext {
  pager: Pager;
}

export function buildOperator(node: PlanNode, ctx: ExecContext): RowSource {
  switch (node.kind) {
    case 'seqScan': {
      const heap = new HeapFile(ctx.pager, node.table.heapHead, columnTypes(node.table));
      let cursor: ReturnType<HeapFile['scan']> | null = null;
      return {
        open: () => {
          cursor = heap.scan();
        },
        next: () => cursor?.next() ?? null,
        close: () => {
          cursor = null;
        },
      };
    }
    case 'indexScan': {
      const heap = new HeapFile(ctx.pager, node.table.heapHead, columnTypes(node.table));
      const type = (node.table.columns[node.column] as ColumnSchema).type;
      const bound = (b: ScanBound | null): KeyBound | null => (b === null ? null : { key: encodeKey(type, b.value), inclusive: b.inclusive });
      let cursor: BTreeCursor | null = null;
      return {
        open: () => {
          cursor = treeOf(ctx.pager, node.index).scan(bound(node.lo), bound(node.hi));
        },
        next: () => {
          const e = cursor?.next() ?? null;
          if (e === null) return null;
          const values = heap.get(e.rid);
          if (values === null) {
            throw new CorruptionError('INDEX_HEAP_MISMATCH', `index ${node.index.name} points at missing row ${e.rid.pageId}:${e.rid.slot}`);
          }
          return { rid: e.rid, values };
        },
        close: () => {
          cursor = null;
        },
      };
    }
    case 'filter': {
      const child = buildOperator(node.child, ctx);
      return {
        open: () => child.open(),
        next: () => {
          for (let r = child.next(); r !== null; r = child.next()) {
            if (isTrue(evaluate(node.predicate, r.values, ctx))) return r;
          }
          return null;
        },
        close: () => child.close(),
      };
    }
    case 'sort': {
      const child = buildOperator(node.child, ctx);
      let rows: Row[] = [];
      let i = 0;
      return {
        open: () => {
          child.open();
          rows = [];
          for (let r = child.next(); r !== null; r = child.next()) rows.push(r);
          // Array.prototype.sort is stable (ES2019); ties keep scan order, which SPEC leaves unspecified
          rows.sort((a, b) => {
            for (const k of node.keys) {
              const c = compareNullable(a.values[k.index] as Value, b.values[k.index] as Value);
              if (c !== 0) return k.desc ? -c : c;
            }
            return 0;
          });
          i = 0;
        },
        next: () => rows[i++] ?? null,
        close: () => {
          rows = [];
          child.close();
        },
      };
    }
    case 'limit': {
      const child = buildOperator(node.child, ctx);
      let opened = false;
      let returned = 0;
      return {
        open: () => {
          returned = 0;
          if (node.limit > 0) {
            child.open();
            opened = true;
            for (let skipped = 0; skipped < node.offset; skipped++) if (child.next() === null) break;
          }
        },
        next: () => {
          if (!opened || returned >= node.limit) return null;
          const r = child.next();
          if (r !== null) returned++;
          return r;
        },
        close: () => {
          if (opened) child.close();
          opened = false;
        },
      };
    }
    case 'project': {
      const child = buildOperator(node.child, ctx);
      return {
        open: () => child.open(),
        next: () => {
          const r = child.next();
          return r === null ? null : { rid: r.rid, values: node.columns.map((c) => r.values[c] as Value) };
        },
        close: () => child.close(),
      };
    }
    default:
      return assertNever(node, 'plan node');
  }
}

/** Runs a plan to completion; close() is always called (F.9). */
export function collectRows(node: PlanNode, ctx: ExecContext): Row[] {
  const op = buildOperator(node, ctx);
  const out: Row[] = [];
  op.open();
  try {
    for (let r = op.next(); r !== null; r = op.next()) out.push(r);
  } finally {
    op.close();
  }
  return out;
}
