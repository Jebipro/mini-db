import type { IndexSchema, TableSchema } from '../catalog/schema.js';
import type { Value } from '../record/value.js';
import type { BExpr } from '../sql/bound.js';

export interface ScanBound {
  value: Exclude<Value, null>;
  inclusive: boolean;
}

/** Plan tree (F.8). Shape for SELECT: Project → Limit → Sort → Filter → scan. */
export type PlanNode =
  | { kind: 'seqScan'; table: TableSchema }
  | { kind: 'indexScan'; table: TableSchema; index: IndexSchema; column: number; lo: ScanBound | null; hi: ScanBound | null }
  | { kind: 'filter'; predicate: BExpr; child: PlanNode }
  | { kind: 'sort'; keys: Array<{ index: number; desc: boolean }>; child: PlanNode }
  | { kind: 'limit'; limit: number; offset: number; child: PlanNode }
  | { kind: 'project'; columns: number[]; child: PlanNode };

export interface PlanOptions {
  /** Testing/learning aid (DC-59): never use an index. */
  forceSeqScan: boolean;
}
