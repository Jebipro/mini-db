import type { IndexSchema, TableSchema } from '../catalog/schema.js';
import type { Value } from '../record/value.js';
import type { BExpr, BoundSelect, CmpOp } from '../sql/bound.js';
import { MAX_KEY_BYTES } from '../util/limits.js';
import { utf8Length } from '../util/utf8.js';
import { compareValues } from './eval.js';
import { indexColumn } from './indexes.js';
import type { PlanNode, PlanOptions, ScanBound } from './plan.js';

/** A WHERE conjunct usable by an index: `column op constant` (F.8 rule 3). */
interface Sargable {
  column: number;
  op: '=' | '<' | '<=' | '>' | '>=';
  value: Exclude<Value, null>;
}

const FLIP: Record<Sargable['op'], Sargable['op']> = { '=': '=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

function conjuncts(e: BExpr): BExpr[] {
  return e.kind === 'logic' && e.op === 'AND' ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
}

/** NULL-free literal or `-` integer literal. */
function constantOf(e: BExpr): Exclude<Value, null> | null {
  if (e.kind === 'const') return e.value;
  if (e.kind === 'neg' && e.operand.kind === 'const' && typeof e.operand.value === 'number') return e.operand.value === 0 ? 0 : -e.operand.value;
  return null;
}

function sargable(e: BExpr): Sargable | null {
  if (e.kind !== 'cmp' || e.op === '<>') return null;
  const op = e.op as Exclude<CmpOp, '<>'>;
  let col: BExpr = e.left;
  let k = constantOf(e.right);
  let normalized: Sargable['op'] = op;
  if (col.kind !== 'col' || k === null) {
    col = e.right;
    k = constantOf(e.left);
    normalized = FLIP[op];
  }
  if (col.kind !== 'col' || k === null) return null;
  if (typeof k === 'string' && utf8Length(k) > MAX_KEY_BYTES) return null; // unencodable as a key: leave it to the filter
  return { column: col.index, op: normalized, value: k };
}

function tighterLower(a: ScanBound | null, b: ScanBound): ScanBound {
  if (a === null) return b;
  const c = compareValues(b.value, a.value);
  if (c > 0) return b;
  if (c === 0 && !b.inclusive) return b; // exclusive wins ties
  return a;
}

function tighterUpper(a: ScanBound | null, b: ScanBound): ScanBound {
  if (a === null) return b;
  const c = compareValues(b.value, a.value);
  if (c < 0) return b;
  if (c === 0 && !b.inclusive) return b;
  return a;
}

/** Access path for a table + WHERE (F.8 rules 1–6). The whole WHERE stays as a Filter (DC-70). */
export function planScan(table: TableSchema, where: BExpr | null, opts: PlanOptions): PlanNode {
  let scan: PlanNode = { kind: 'seqScan', table };
  if (where && !opts.forceSeqScan && table.indexes.length > 0) {
    const preds = conjuncts(where).map(sargable).filter((s): s is Sargable => s !== null);
    const byName = [...table.indexes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rank = (idx: IndexSchema): number => {
      const ps = preds.filter((p) => p.column === indexColumn(table, idx));
      if (ps.length === 0) return 0;
      const eq = ps.some((p) => p.op === '=');
      return eq ? (idx.unique ? 3 : 2) : 1;
    };
    let best: IndexSchema | null = null;
    let bestRank = 0;
    for (const idx of byName) {
      const r = rank(idx);
      if (r > bestRank) {
        best = idx;
        bestRank = r;
      }
    }
    if (best) {
      const column = indexColumn(table, best);
      let lo: ScanBound | null = null;
      let hi: ScanBound | null = null;
      for (const p of preds.filter((x) => x.column === column)) {
        if (p.op === '=' || p.op === '>' || p.op === '>=') lo = tighterLower(lo, { value: p.value, inclusive: p.op !== '>' });
        if (p.op === '=' || p.op === '<' || p.op === '<=') hi = tighterUpper(hi, { value: p.value, inclusive: p.op !== '<' });
      }
      scan = { kind: 'indexScan', table, index: best, column, lo, hi };
    }
  }
  return where ? { kind: 'filter', predicate: where, child: scan } : scan;
}

/** F.8 rule 7: Project → Limit → Sort → Filter → scan. */
export function planSelect(s: BoundSelect, opts: PlanOptions): PlanNode {
  let node = planScan(s.table, s.where, opts);
  if (s.orderBy.length > 0) node = { kind: 'sort', keys: s.orderBy, child: node };
  if (s.limit !== null) node = { kind: 'limit', limit: s.limit, offset: s.offset, child: node };
  return { kind: 'project', columns: s.columns, child: node };
}
