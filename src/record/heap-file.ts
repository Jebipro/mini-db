import { invariant } from '../errors/assert.js';
import { CorruptionError, MiniDbError } from '../errors/errors.js';
import type { IntegrityIssue } from '../storage/issues.js';
import { PageType } from '../storage/layout.js';
import { expectPageType } from '../storage/page.js';
import type { Pager, PageId, PageRef } from '../storage/pager.js';
import {
  canInsert,
  canUpdate,
  checkHeapPage,
  deleteRecord,
  getRecord,
  hp,
  initHeapPage,
  insertRecord,
  isLive,
  updateRecord,
} from './heap-page.js';
import { decodeRow, encodeRow } from './row-codec.js';
import type { ColumnType, Rid, Value } from './value.js';

export interface HeapRow {
  rid: Rid;
  values: Value[];
}

/** Cursor over live rows (G.12): holds (pageId, slot) only, never a pin between next() calls. */
export interface HeapCursor {
  next(): HeapRow | null;
}

/**
 * Table heap: a chain of slotted pages starting at a fixed head page whose `tailPage` names the last page
 * (D.3, DC-61). Rows are inserted into the tail page or a new page appended to the chain.
 */
export class HeapFile {
  constructor(
    private readonly pager: Pager,
    readonly headPage: PageId,
    private readonly types: readonly ColumnType[],
  ) {}

  static create(pager: Pager): PageId {
    const ref = pager.allocate(PageType.HEAP);
    try {
      initHeapPage(ref.data, ref.id);
      hp.setTail(ref.data, ref.id);
      return ref.id;
    } finally {
      pager.unpin(ref);
    }
  }

  private pinHeap(id: PageId): PageRef {
    const ref = this.pager.pin(id);
    try {
      expectPageType(ref.data, id, PageType.HEAP);
    } catch (e) {
      this.pager.unpin(ref);
      throw e;
    }
    return ref;
  }

  private withPage<T>(id: PageId, fn: (ref: PageRef) => T): T {
    const ref = this.pinHeap(id);
    try {
      return fn(ref);
    } finally {
      this.pager.unpin(ref);
    }
  }

  insert(values: readonly Value[]): Rid {
    return this.insertEncoded(encodeRow(this.types, values));
  }

  private insertEncoded(rec: Uint8Array): Rid {
    const head = this.pinHeap(this.headPage);
    try {
      const tailId = hp.tail(head.data);
      if (tailId === 0) throw new CorruptionError('PAGE_TYPE_MISMATCH', `heap head ${this.headPage} has no tail pointer`);
      const tail = this.pinHeap(tailId);
      try {
        if (canInsert(tail.data, rec.length)) {
          this.pager.markDirty(tail);
          return { pageId: tailId, slot: insertRecord(tail.data, rec) };
        }
        const fresh = this.pager.allocate(PageType.HEAP);
        try {
          initHeapPage(fresh.data, fresh.id);
          this.pager.markDirty(tail);
          hp.setNext(tail.data, fresh.id);
          this.pager.markDirty(head);
          hp.setTail(head.data, fresh.id);
          invariant(canInsert(fresh.data, rec.length), 'record does not fit an empty page');
          return { pageId: fresh.id, slot: insertRecord(fresh.data, rec) };
        } finally {
          this.pager.unpin(fresh);
        }
      } finally {
        this.pager.unpin(tail);
      }
    } finally {
      this.pager.unpin(head);
    }
  }

  get(rid: Rid): Value[] | null {
    if (!Number.isInteger(rid.pageId) || rid.pageId < 1 || rid.pageId >= this.pager.pageCount) return null;
    return this.withPage(rid.pageId, (ref) => {
      const rec = getRecord(ref.data, rid.slot, rid.pageId);
      return rec === null ? null : decodeRow(this.types, rec);
    });
  }

  /** G.12: same RID when the row fits its page, otherwise moved to another page (new RID). */
  update(rid: Rid, values: readonly Value[]): Rid {
    const rec = encodeRow(this.types, values);
    const moved = this.withPage(rid.pageId, (ref) => {
      invariant(isLive(ref.data, rid.slot), `update of a missing row ${rid.pageId}:${rid.slot}`);
      this.pager.markDirty(ref);
      if (canUpdate(ref.data, rid.slot, rec.length)) {
        updateRecord(ref.data, rid.slot, rec);
        return false;
      }
      deleteRecord(ref.data, rid.slot);
      return true;
    });
    return moved ? this.insertEncoded(rec) : rid;
  }

  delete(rid: Rid): void {
    this.withPage(rid.pageId, (ref) => {
      invariant(isLive(ref.data, rid.slot), `delete of a missing row ${rid.pageId}:${rid.slot}`);
      this.pager.markDirty(ref);
      deleteRecord(ref.data, rid.slot);
    });
  }

  scan(): HeapCursor {
    let pageId: PageId = this.headPage;
    let slot = 0;
    let visited = 0;
    const limit = this.pager.pageCount;
    return {
      next: (): HeapRow | null => {
        while (pageId !== 0) {
          const found = this.withPage(pageId, (ref): HeapRow | 'next' => {
            const n = hp.slotCount(ref.data);
            while (slot < n) {
              const rec = getRecord(ref.data, slot, pageId);
              const s = slot++;
              if (rec !== null) return { rid: { pageId, slot: s }, values: decodeRow(this.types, rec) };
            }
            const nextId = hp.next(ref.data);
            if (++visited > limit) throw new CorruptionError('RECORD_MALFORMED', `heap chain from page ${this.headPage} is cyclic`);
            pageId = nextId;
            slot = 0;
            return 'next';
          });
          if (found !== 'next') return found;
        }
        return null;
      },
    };
  }

  /** Pages of the chain, head first. Throws on cycles or wrong page types. */
  pageIds(): PageId[] {
    const out: PageId[] = [];
    const seen = new Set<PageId>();
    let id = this.headPage;
    while (id !== 0) {
      if (seen.has(id)) throw new CorruptionError('RECORD_MALFORMED', `heap chain from page ${this.headPage} is cyclic at page ${id}`);
      seen.add(id);
      out.push(id);
      id = this.withPage(id, (ref) => hp.next(ref.data));
    }
    return out;
  }

  destroy(): void {
    for (const id of this.pageIds()) this.pager.free(id);
  }

  /**
   * I5 (chain), I6 (geometry), I7 (records decode, NOT NULL when `notNull` is given).
   * Returns the pages it owns for the ownership check (I3).
   */
  check(object: string, notNull?: readonly boolean[]): { pages: PageId[]; rows: number; issues: IntegrityIssue[] } {
    const issues: IntegrityIssue[] = [];
    const pages: PageId[] = [];
    const chain = (message: string, pageId?: number): void => {
      issues.push({ code: 'HEAP_CHAIN_INVALID', object, message, ...(pageId === undefined ? {} : { pageId }) });
    };
    let rows = 0;
    const seen = new Set<PageId>();
    let id = this.headPage;
    let last = id;
    let headTail = -1;
    while (id !== 0) {
      if (seen.has(id)) {
        chain(`heap chain is cyclic at page ${id}`, id);
        break;
      }
      if (id >= this.pager.pageCount) {
        chain(`heap chain points outside the database (page ${id})`, id);
        break;
      }
      seen.add(id);
      let ref: PageRef;
      try {
        ref = this.pager.pin(id);
      } catch (e) {
        if (e instanceof MiniDbError && e.name === 'CorruptionError') {
          issues.push({ code: 'PAGE_CORRUPT', pageId: id, object, message: e.message });
          break;
        }
        throw e;
      }
      try {
        pages.push(id);
        if (ref.data[0] !== PageType.HEAP) {
          chain(`page ${id} in heap chain has type ${ref.data[0]}`, id);
          break;
        }
        if (id === this.headPage) headTail = hp.tail(ref.data);
        else if (hp.tail(ref.data) !== 0) chain(`non-head page ${id} has tailPage ${hp.tail(ref.data)}`, id);
        const geo = checkHeapPage(ref.data, id, object);
        issues.push(...geo);
        if (geo.length === 0) {
          const n = hp.slotCount(ref.data);
          for (let s = 0; s < n; s++) {
            const rec = getRecord(ref.data, s, id);
            if (rec === null) continue;
            rows++;
            try {
              const values = decodeRow(this.types, rec);
              notNull?.forEach((nn, i) => {
                if (nn && values[i] === null) {
                  issues.push({ code: 'RECORD_INVALID', pageId: id, object, message: `row ${id}:${s} has NULL in NOT NULL column ${i}` });
                }
              });
            } catch (e) {
              if (!(e instanceof CorruptionError)) throw e;
              issues.push({ code: 'RECORD_INVALID', pageId: id, object, message: `row ${id}:${s}: ${e.message}` });
            }
          }
        }
        last = id;
        id = hp.next(ref.data);
      } finally {
        this.pager.unpin(ref);
      }
    }
    if (headTail !== -1 && headTail !== last) chain(`head tailPage ${headTail} but the chain ends at ${last}`, this.headPage);
    return { pages, rows, issues };
  }
}
