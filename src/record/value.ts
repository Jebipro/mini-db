import type { PageId } from '../storage/pager.js';

export type ColumnType = 'INTEGER' | 'TEXT' | 'BOOLEAN';
export type Value = number | string | boolean | null;

/** Record identifier (DC-27). */
export interface Rid {
  pageId: PageId;
  slot: number;
}

export function ridEquals(a: Rid, b: Rid): boolean {
  return a.pageId === b.pageId && a.slot === b.slot;
}

export function compareRid(a: Rid, b: Rid): -1 | 0 | 1 {
  if (a.pageId !== b.pageId) return a.pageId < b.pageId ? -1 : 1;
  if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
  return 0;
}

export function ridKey(r: Rid): string {
  return `${r.pageId}:${r.slot}`;
}

