import { invariant } from '../errors/assert.js';
import { CorruptionError } from '../errors/errors.js';
import type { IntegrityIssue } from '../storage/issues.js';
import { BT_CELL_COUNT, BT_CELL_PTRS, BT_CELL_START, BT_FRAGMENTED, BT_PTR_SIZE, BT_RIGHT_PTR, PAGE_SIZE, PageType } from '../storage/layout.js';
import { initPage, pageTypeOf } from '../storage/page.js';
import { readU16, readU32, writeU16, writeU32 } from '../util/bytes.js';
import type { Entry } from './key-codec.js';

/**
 * B+tree node layout on raw page bytes (D.6). Leaf cell: u16 keyLen, key, u32 rid.pageId, u16 rid.slot.
 * Internal cell: u32 leftChild, then the same. Cell pointers (u16) are kept in key order.
 */

export interface InternalCell extends Entry {
  child: number;
}

export const nd = {
  isLeaf: (p: Uint8Array): boolean => pageTypeOf(p) === PageType.BTREE_LEAF,
  count: (p: Uint8Array): number => readU16(p, BT_CELL_COUNT),
  cellStart: (p: Uint8Array): number => readU16(p, BT_CELL_START),
  rightPtr: (p: Uint8Array): number => readU32(p, BT_RIGHT_PTR),
  setRightPtr: (p: Uint8Array, v: number): void => writeU32(p, BT_RIGHT_PTR, v),
  fragmented: (p: Uint8Array): number => readU16(p, BT_FRAGMENTED),
};

function ptrPos(i: number): number {
  return BT_CELL_PTRS + BT_PTR_SIZE * i;
}

export function cellOffset(p: Uint8Array, i: number): number {
  return readU16(p, ptrPos(i));
}

export function initNode(p: Uint8Array, id: number, leaf: boolean): void {
  initPage(p, leaf ? PageType.BTREE_LEAF : PageType.BTREE_INTERNAL, id);
  writeU16(p, BT_CELL_COUNT, 0);
  writeU16(p, BT_CELL_START, PAGE_SIZE);
  writeU16(p, BT_FRAGMENTED, 0);
  writeU32(p, BT_RIGHT_PTR, 0);
}

export function leafCellSize(keyLen: number): number {
  return 2 + keyLen + 6;
}

export function internalCellSize(keyLen: number): number {
  return 4 + 2 + keyLen + 6;
}

/** Size of cell i (validated against the page). */
export function cellSize(p: Uint8Array, i: number, pageId: number): number {
  const off = cellOffset(p, i);
  const leaf = nd.isLeaf(p);
  const keyLenOff = leaf ? off : off + 4;
  if (off < BT_CELL_PTRS || keyLenOff + 2 > PAGE_SIZE) throw malformed(pageId, `cell ${i} offset ${off}`);
  const keyLen = readU16(p, keyLenOff);
  const size = leaf ? leafCellSize(keyLen) : internalCellSize(keyLen);
  if (off + size > PAGE_SIZE) throw malformed(pageId, `cell ${i} overruns the page`);
  return size;
}

function malformed(pageId: number, why: string): CorruptionError {
  return new CorruptionError('BTREE_MALFORMED', `B+tree page ${pageId}: ${why}`);
}

export function readEntry(p: Uint8Array, i: number, pageId: number): Entry {
  cellSize(p, i, pageId);
  let off = cellOffset(p, i);
  if (!nd.isLeaf(p)) off += 4;
  const keyLen = readU16(p, off);
  const key = Uint8Array.from(p.subarray(off + 2, off + 2 + keyLen));
  const ridOff = off + 2 + keyLen;
  return { key, rid: { pageId: readU32(p, ridOff), slot: readU16(p, ridOff + 4) } };
}

export function readChild(p: Uint8Array, i: number, pageId: number): number {
  invariant(!nd.isLeaf(p), 'readChild on a leaf');
  if (i === nd.count(p)) return nd.rightPtr(p);
  cellSize(p, i, pageId);
  return readU32(p, cellOffset(p, i));
}

export function setChild(p: Uint8Array, i: number, child: number): void {
  if (i === nd.count(p)) nd.setRightPtr(p, child);
  else writeU32(p, cellOffset(p, i), child);
}

export function readInternal(p: Uint8Array, i: number, pageId: number): InternalCell {
  return { ...readEntry(p, i, pageId), child: readChild(p, i, pageId) };
}

function encodeCell(leaf: boolean, e: Entry, child = 0): Uint8Array {
  const size = leaf ? leafCellSize(e.key.length) : internalCellSize(e.key.length);
  const out = new Uint8Array(size);
  let off = 0;
  if (!leaf) {
    writeU32(out, 0, child);
    off = 4;
  }
  writeU16(out, off, e.key.length);
  out.set(e.key, off + 2);
  writeU32(out, off + 2 + e.key.length, e.rid.pageId);
  writeU16(out, off + 2 + e.key.length + 4, e.rid.slot);
  return out;
}

function contiguousFree(p: Uint8Array): number {
  return nd.cellStart(p) - ptrPos(nd.count(p));
}

export function freeSpace(p: Uint8Array): number {
  return contiguousFree(p) + nd.fragmented(p);
}

/** Bytes a new cell needs, including its pointer. */
export function cellFootprint(leaf: boolean, keyLen: number): number {
  return (leaf ? leafCellSize(keyLen) : internalCellSize(keyLen)) + BT_PTR_SIZE;
}

export function fits(p: Uint8Array, leaf: boolean, keyLen: number): boolean {
  return freeSpace(p) >= cellFootprint(leaf, keyLen);
}

function compactNode(p: Uint8Array, pageId: number): void {
  const n = nd.count(p);
  const cells: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const off = cellOffset(p, i);
    cells.push(Uint8Array.from(p.subarray(off, off + cellSize(p, i, pageId))));
  }
  let pos = PAGE_SIZE;
  cells.forEach((c, i) => {
    pos -= c.length;
    p.set(c, pos);
    writeU16(p, ptrPos(i), pos);
  });
  p.fill(0, ptrPos(n), pos);
  writeU16(p, BT_CELL_START, pos);
  writeU16(p, BT_FRAGMENTED, 0);
}

/** Inserts a cell at pointer index `at` (callers check `fits`). Internal cells carry `child`. */
export function insertCell(p: Uint8Array, pageId: number, at: number, e: Entry, child = 0): void {
  const leaf = nd.isLeaf(p);
  const cell = encodeCell(leaf, e, child);
  invariant(freeSpace(p) >= cell.length + BT_PTR_SIZE, 'insertCell without space');
  if (contiguousFree(p) < cell.length + BT_PTR_SIZE) compactNode(p, pageId);
  const n = nd.count(p);
  const start = nd.cellStart(p) - cell.length;
  p.set(cell, start);
  writeU16(p, BT_CELL_START, start);
  p.copyWithin(ptrPos(at + 1), ptrPos(at), ptrPos(n));
  writeU16(p, ptrPos(at), start);
  writeU16(p, BT_CELL_COUNT, n + 1);
}

export function removeCell(p: Uint8Array, pageId: number, at: number): void {
  const n = nd.count(p);
  invariant(at >= 0 && at < n, 'removeCell out of range');
  const size = cellSize(p, at, pageId);
  p.copyWithin(ptrPos(at), ptrPos(at + 1), ptrPos(n));
  writeU16(p, ptrPos(n - 1), 0);
  writeU16(p, BT_CELL_COUNT, n - 1);
  writeU16(p, BT_FRAGMENTED, nd.fragmented(p) + size);
}

/** Rebuilds a node from scratch (used by splits). */
export function writeLeaf(p: Uint8Array, id: number, entries: readonly Entry[], next: number): void {
  initNode(p, id, true);
  entries.forEach((e, i) => insertCell(p, id, i, e));
  nd.setRightPtr(p, next);
}

export function writeInternal(p: Uint8Array, id: number, cells: readonly InternalCell[], rightmost: number): void {
  initNode(p, id, false);
  cells.forEach((c, i) => insertCell(p, id, i, c, c.child));
  nd.setRightPtr(p, rightmost);
}

/** I10: cell pointers within the page, cells disjoint, fragmented-byte accounting. */
export function checkNodeGeometry(p: Uint8Array, pageId: number, object: string): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const bad = (m: string): void => {
    issues.push({ code: 'BTREE_PAGE_INVALID', pageId, object, message: `page ${pageId}: ${m}` });
  };
  const n = nd.count(p);
  const cs = nd.cellStart(p);
  if (ptrPos(n) > cs || cs > PAGE_SIZE) {
    bad(`pointer array end ${ptrPos(n)} / cell start ${cs} out of order`);
    return issues;
  }
  const spans: Array<[number, number]> = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const off = cellOffset(p, i);
    let size: number;
    try {
      size = cellSize(p, i, pageId);
    } catch {
      bad(`cell ${i} is malformed`);
      return issues;
    }
    if (off < cs) {
      bad(`cell ${i} at ${off} lies before the cell area ${cs}`);
      continue;
    }
    const keyLen = readU16(p, nd.isLeaf(p) ? off : off + 4);
    if (keyLen > 512) bad(`cell ${i} key length ${keyLen} > 512`);
    spans.push([off, off + size]);
    sum += size;
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if ((spans[i] as [number, number])[0] < (spans[i - 1] as [number, number])[1]) bad('cells overlap');
  if (nd.fragmented(p) !== PAGE_SIZE - cs - sum) bad(`fragmentedBytes ${nd.fragmented(p)} != ${PAGE_SIZE - cs - sum}`);
  return issues;
}
