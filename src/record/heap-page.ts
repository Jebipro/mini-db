import { invariant } from '../errors/assert.js';
import { CorruptionError } from '../errors/errors.js';
import { readU16, readU32, writeU16, writeU32 } from '../util/bytes.js';
import {
  HP_FRAGMENTED,
  HP_NEXT_PAGE,
  HP_RECORD_START,
  HP_SLOT_COUNT,
  HP_SLOT_DIR,
  HP_SLOT_SIZE,
  HP_TAIL_PAGE,
  PAGE_SIZE,
  PageType,
} from '../storage/layout.js';
import type { IntegrityIssue } from '../storage/issues.js';
import { initPage } from '../storage/page.js';

/**
 * Slotted heap page operations on raw page bytes (D.3, G.12). Callers pin the page and call
 * pager.markDirty before any mutating function. Every mutating function either succeeds or leaves the
 * page byte-for-byte unchanged (`canInsert` / `canUpdate` decide beforehand).
 */

export const hp = {
  slotCount: (p: Uint8Array): number => readU16(p, HP_SLOT_COUNT),
  next: (p: Uint8Array): number => readU32(p, HP_NEXT_PAGE),
  tail: (p: Uint8Array): number => readU32(p, HP_TAIL_PAGE),
  fragmented: (p: Uint8Array): number => readU16(p, HP_FRAGMENTED),
  setNext: (p: Uint8Array, v: number): void => writeU32(p, HP_NEXT_PAGE, v),
  setTail: (p: Uint8Array, v: number): void => writeU32(p, HP_TAIL_PAGE, v),
};

export function recordStart(p: Uint8Array): number {
  return readU16(p, HP_RECORD_START);
}
function setRecordStart(p: Uint8Array, v: number): void {
  writeU16(p, HP_RECORD_START, v);
}
function setSlotCount(p: Uint8Array, v: number): void {
  writeU16(p, HP_SLOT_COUNT, v);
}
function setFragmented(p: Uint8Array, v: number): void {
  writeU16(p, HP_FRAGMENTED, v);
}
function slotPos(i: number): number {
  return HP_SLOT_DIR + HP_SLOT_SIZE * i;
}
export function slotOffset(p: Uint8Array, i: number): number {
  return readU16(p, slotPos(i));
}
export function slotLength(p: Uint8Array, i: number): number {
  return readU16(p, slotPos(i) + 2);
}
function setSlot(p: Uint8Array, i: number, off: number, len: number): void {
  writeU16(p, slotPos(i), off);
  writeU16(p, slotPos(i) + 2, len);
}

export function initHeapPage(p: Uint8Array, pageId: number): void {
  initPage(p, PageType.HEAP, pageId);
  setSlotCount(p, 0);
  setRecordStart(p, PAGE_SIZE);
  setFragmented(p, 0);
}

function slotDirEnd(p: Uint8Array): number {
  return slotPos(hp.slotCount(p));
}
function contiguousFree(p: Uint8Array): number {
  return recordStart(p) - slotDirEnd(p);
}
export function totalFree(p: Uint8Array): number {
  return contiguousFree(p) + hp.fragmented(p);
}
function lowestTombstone(p: Uint8Array): number {
  const n = hp.slotCount(p);
  for (let i = 0; i < n; i++) if (slotOffset(p, i) === 0) return i;
  return -1;
}

export function isLive(p: Uint8Array, slot: number): boolean {
  return slot < hp.slotCount(p) && slotOffset(p, slot) !== 0;
}

/** Copy of a live record; validates the slot against the page geometry. */
export function getRecord(p: Uint8Array, slot: number, pageId: number): Uint8Array | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= hp.slotCount(p)) return null;
  const off = slotOffset(p, slot);
  if (off === 0) return null;
  const len = slotLength(p, slot);
  if (len < 1 || off < recordStart(p) || off + len > PAGE_SIZE) {
    throw new CorruptionError('RECORD_MALFORMED', `slot ${slot} of page ${pageId} points outside the record area`);
  }
  return Uint8Array.from(p.subarray(off, off + len));
}

export function canInsert(p: Uint8Array, len: number): boolean {
  const need = len + (lowestTombstone(p) < 0 ? HP_SLOT_SIZE : 0);
  return totalFree(p) >= need;
}

/** G.12 compaction: live records repacked at the page end in slot order; slot numbers kept. */
export function compact(p: Uint8Array): void {
  const n = hp.slotCount(p);
  const live: Array<{ i: number; bytes: Uint8Array }> = [];
  for (let i = 0; i < n; i++) {
    const off = slotOffset(p, i);
    if (off !== 0) live.push({ i, bytes: Uint8Array.from(p.subarray(off, off + slotLength(p, i))) });
  }
  let pos = PAGE_SIZE;
  for (const { i, bytes } of live) {
    pos -= bytes.length;
    p.set(bytes, pos);
    setSlot(p, i, pos, bytes.length);
  }
  p.fill(0, slotDirEnd(p), pos);
  setRecordStart(p, pos);
  setFragmented(p, 0);
}

function place(p: Uint8Array, rec: Uint8Array): number {
  const start = recordStart(p) - rec.length;
  p.set(rec, start);
  setRecordStart(p, start);
  return start;
}

/** Inserts a record; returns the slot. Precondition: canInsert. */
export function insertRecord(p: Uint8Array, rec: Uint8Array): number {
  invariant(rec.length >= 1, 'empty record');
  invariant(canInsert(p, rec.length), 'insertRecord without space');
  let slot = lowestTombstone(p);
  const need = rec.length + (slot < 0 ? HP_SLOT_SIZE : 0);
  if (contiguousFree(p) < need) compact(p);
  if (slot < 0) {
    slot = hp.slotCount(p);
    setSlotCount(p, slot + 1);
  }
  const off = place(p, rec);
  setSlot(p, slot, off, rec.length);
  return slot;
}

export function canUpdate(p: Uint8Array, slot: number, newLen: number): boolean {
  const oldLen = slotLength(p, slot);
  return newLen <= oldLen || contiguousFree(p) >= newLen || totalFree(p) + oldLen >= newLen;
}

/** Rewrites a live record in place (same slot, same RID). Precondition: canUpdate. */
export function updateRecord(p: Uint8Array, slot: number, rec: Uint8Array): void {
  invariant(isLive(p, slot), `update of dead slot ${slot}`);
  invariant(canUpdate(p, slot, rec.length), 'updateRecord without space');
  const off = slotOffset(p, slot);
  const oldLen = slotLength(p, slot);
  const newLen = rec.length;
  if (newLen <= oldLen) {
    p.set(rec, off);
    setSlot(p, slot, off, newLen);
    setFragmented(p, hp.fragmented(p) + oldLen - newLen);
    return;
  }
  if (contiguousFree(p) < newLen) {
    setSlot(p, slot, 0, 0); // temporarily dead so compaction drops the old bytes
    setFragmented(p, hp.fragmented(p) + oldLen);
    compact(p);
  } else {
    setFragmented(p, hp.fragmented(p) + oldLen);
  }
  const start = place(p, rec);
  setSlot(p, slot, start, newLen);
}

export function deleteRecord(p: Uint8Array, slot: number): void {
  invariant(isLive(p, slot), `delete of dead slot ${slot}`);
  setFragmented(p, hp.fragmented(p) + slotLength(p, slot));
  setSlot(p, slot, 0, 0);
  let n = hp.slotCount(p);
  while (n > 0 && slotOffset(p, n - 1) === 0) n--;
  setSlotCount(p, n);
}

/** I6 slotted-page geometry. */
export function checkHeapPage(p: Uint8Array, pageId: number, object: string): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const bad = (message: string): void => {
    issues.push({ code: 'SLOTTED_PAGE_INVALID', pageId, object, message: `page ${pageId}: ${message}` });
  };
  const n = hp.slotCount(p);
  const rs = recordStart(p);
  if (slotDirEnd(p) > rs || rs > PAGE_SIZE) {
    bad(`slot directory end ${slotDirEnd(p)} / record start ${rs} out of order`);
    return issues;
  }
  const live: Array<[number, number]> = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const off = slotOffset(p, i);
    const len = slotLength(p, i);
    if (off === 0) {
      if (len !== 0) bad(`tombstone slot ${i} has length ${len}`);
      continue;
    }
    if (len < 1 || off < rs || off + len > PAGE_SIZE) {
      bad(`slot ${i} (${off}, ${len}) outside [${rs}, ${PAGE_SIZE})`);
      continue;
    }
    live.push([off, off + len]);
    sum += len;
  }
  if (n > 0 && slotOffset(p, n - 1) === 0) bad('last slot is a tombstone');
  live.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < live.length; i++) {
    if ((live[i] as [number, number])[0] < (live[i - 1] as [number, number])[1]) bad('records overlap');
  }
  if (hp.fragmented(p) !== PAGE_SIZE - rs - sum) bad(`fragmentedBytes ${hp.fragmented(p)} != ${PAGE_SIZE - rs - sum}`);
  return issues;
}
