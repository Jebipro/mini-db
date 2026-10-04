import { invariant } from '../errors/assert.js';
import { CorruptionError, MiniDbError } from '../errors/errors.js';
import type { Rid } from '../record/value.js';
import type { IntegrityIssue } from '../storage/issues.js';
import { PageType } from '../storage/layout.js';
import { pageTypeOf } from '../storage/page.js';
import type { Pager, PageId, PageRef } from '../storage/pager.js';
import { compareBytes } from '../util/bytes.js';
import { compareEntry, type Entry } from './key-codec.js';
import {
  checkNodeGeometry,
  fits,
  initNode,
  insertCell,
  internalCellSize,
  leafCellSize,
  nd,
  readChild,
  readEntry,
  readInternal,
  removeCell,
  setChild,
  writeInternal,
  writeLeaf,
  type InternalCell,
} from './node.js';

export interface KeyBound {
  key: Uint8Array;
  inclusive: boolean;
}

export interface BTreeCursor {
  next(): Entry | null;
}

const MAX_DEPTH = 64;
const MIN_RID: Rid = { pageId: 0, slot: 0 };

interface PathStep {
  page: PageId;
  /** Index of the child pointer taken (cellCount = rightPtr). */
  childIdx: number;
}

/**
 * Disk B+tree (G.13): fixed root page id (DC-29), splits by byte size, lazy deletion (DC-30).
 * Unique trees compare keys only; non-unique trees compare (key, rid). Pins are held only inside a call.
 */
export class BTree {
  constructor(
    private readonly pager: Pager,
    readonly root: PageId,
    readonly unique: boolean,
  ) {}

  static create(pager: Pager): PageId {
    const ref = pager.allocate(PageType.BTREE_LEAF);
    try {
      initNode(ref.data, ref.id, true);
      return ref.id;
    } finally {
      pager.unpin(ref);
    }
  }

  private cmp(a: Entry, b: Entry): -1 | 0 | 1 {
    return compareEntry(a, b, this.unique);
  }

  private pinNode(id: PageId): PageRef {
    const ref = this.pager.pin(id);
    const t = pageTypeOf(ref.data);
    if (t !== PageType.BTREE_LEAF && t !== PageType.BTREE_INTERNAL) {
      this.pager.unpin(ref);
      throw new CorruptionError('PAGE_TYPE_MISMATCH', `page ${id} in B+tree ${this.root} has type ${t}`);
    }
    return ref;
  }

  private withNode<T>(id: PageId, fn: (p: Uint8Array) => T): T {
    const ref = this.pinNode(id);
    try {
      return fn(ref.data);
    } finally {
      this.pager.unpin(ref);
    }
  }

  /** First index in the leaf whose entry is ≥ target. */
  private lowerBound(p: Uint8Array, id: PageId, target: Entry): number {
    let lo = 0;
    let hi = nd.count(p);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cmp(readEntry(p, mid, id), target) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Internal routing: first separator with target < sep, else the right pointer. */
  private route(p: Uint8Array, id: PageId, target: Entry): number {
    let lo = 0;
    let hi = nd.count(p);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cmp(target, readEntry(p, mid, id)) < 0) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private descend(target: Entry): { leaf: PageId; path: PathStep[] } {
    const path: PathStep[] = [];
    let id = this.root;
    for (let depth = 0; ; depth++) {
      if (depth > MAX_DEPTH) throw new CorruptionError('BTREE_MALFORMED', `B+tree ${this.root} is deeper than ${MAX_DEPTH}`);
      const next = this.withNode(id, (p) => {
        if (nd.isLeaf(p)) return null;
        const childIdx = this.route(p, id, target);
        path.push({ page: id, childIdx });
        return readChild(p, childIdx, id);
      });
      if (next === null) return { leaf: id, path };
      id = next;
    }
  }

  findUnique(key: Uint8Array): Rid | null {
    const target: Entry = { key, rid: MIN_RID };
    const { leaf } = this.descend(target);
    return this.withNode(leaf, (p) => {
      const i = this.lowerBound(p, leaf, target);
      if (i < nd.count(p)) {
        const e = readEntry(p, i, leaf);
        if (compareBytes(e.key, key) === 0) return e.rid;
      }
      return null;
    });
  }

  insert(e: Entry): void {
    const { leaf, path } = this.descend(e);
    const ref = this.pinNode(leaf);
    try {
      const p = ref.data;
      const pos = this.lowerBound(p, leaf, e);
      if (pos < nd.count(p) && this.cmp(readEntry(p, pos, leaf), e) === 0) {
        invariant(false, `duplicate B+tree entry in ${this.unique ? 'unique ' : ''}index rooted at ${this.root}`);
      }
      this.pager.markDirty(ref);
      if (fits(p, true, e.key.length)) {
        insertCell(p, leaf, pos, e);
        return;
      }
      const entries: Entry[] = [];
      for (let i = 0; i < nd.count(p); i++) entries.push(readEntry(p, i, leaf));
      entries.splice(pos, 0, e);
      const m = splitPoint(entries.map((x) => leafCellSize(x.key.length) + 2), 1, entries.length - 1);
      const sep = entries[m] as Entry;
      if (leaf === this.root) {
        this.splitRoot(ref, (L, R) => {
          writeLeaf(L.data, L.id, entries.slice(0, m), R.id);
          writeLeaf(R.data, R.id, entries.slice(m), 0);
        }, sep);
        return;
      }
      const right = this.pager.allocate(PageType.BTREE_LEAF);
      try {
        const oldNext = nd.rightPtr(p);
        writeLeaf(right.data, right.id, entries.slice(m), oldNext);
        writeLeaf(p, leaf, entries.slice(0, m), right.id);
        this.insertIntoParent(path, leaf, sep, right.id);
      } finally {
        this.pager.unpin(right);
      }
    } finally {
      this.pager.unpin(ref);
    }
  }

  /** DC-29: the root keeps its page id; its content moves into two new children. */
  private splitRoot(rootRef: PageRef, fill: (L: PageRef, R: PageRef) => void, sep: Entry): void {
    const L = this.pager.allocate(PageType.BTREE_LEAF);
    try {
      const R = this.pager.allocate(PageType.BTREE_LEAF);
      try {
        fill(L, R);
        writeInternal(rootRef.data, rootRef.id, [{ ...sep, child: L.id }], R.id);
      } finally {
        this.pager.unpin(R);
      }
    } finally {
      this.pager.unpin(L);
    }
  }

  private insertIntoParent(path: PathStep[], left: PageId, sep: Entry, right: PageId): void {
    const step = path.pop();
    invariant(step !== undefined, 'split of a non-root node without a parent');
    const ref = this.pinNode(step.page);
    try {
      const p = ref.data;
      const id = step.page;
      this.pager.markDirty(ref);
      const n = nd.count(p);
      invariant(readChild(p, step.childIdx, id) === left, 'parent does not point at the split child');
      if (fits(p, false, sep.key.length)) {
        // (left, sep) goes before the pointer that used to reach `left`; that pointer now reaches `right`
        insertCell(p, id, step.childIdx, sep, left);
        setChild(p, step.childIdx + 1, right);
        return;
      }
      const cells: InternalCell[] = [];
      for (let i = 0; i < n; i++) cells.push(readInternal(p, i, id));
      let rightmost = nd.rightPtr(p);
      if (step.childIdx < n) (cells[step.childIdx] as InternalCell).child = right;
      else rightmost = right;
      cells.splice(step.childIdx, 0, { ...sep, child: left });
      const m = splitPoint(cells.map((c) => internalCellSize(c.key.length) + 2), 1, cells.length - 2);
      const up = cells[m] as InternalCell;
      const leftCells = cells.slice(0, m);
      const rightCells = cells.slice(m + 1);
      if (id === this.root) {
        const L = this.pager.allocate(PageType.BTREE_INTERNAL);
        try {
          const R = this.pager.allocate(PageType.BTREE_INTERNAL);
          try {
            writeInternal(L.data, L.id, leftCells, up.child);
            writeInternal(R.data, R.id, rightCells, rightmost);
            writeInternal(p, id, [{ key: up.key, rid: up.rid, child: L.id }], R.id);
          } finally {
            this.pager.unpin(R);
          }
        } finally {
          this.pager.unpin(L);
        }
        return;
      }
      const R = this.pager.allocate(PageType.BTREE_INTERNAL);
      try {
        writeInternal(R.data, R.id, rightCells, rightmost);
        writeInternal(p, id, leftCells, up.child);
        this.insertIntoParent(path, id, { key: up.key, rid: up.rid }, R.id);
      } finally {
        this.pager.unpin(R);
      }
    } finally {
      this.pager.unpin(ref);
    }
  }

  /** Lazy delete (DC-30): remove the exact entry from its leaf; separators and empty leaves stay. */
  delete(e: Entry): void {
    const { leaf } = this.descend(e);
    const ref = this.pinNode(leaf);
    try {
      const p = ref.data;
      const pos = this.lowerBound(p, leaf, e);
      const found = pos < nd.count(p) ? readEntry(p, pos, leaf) : null;
      invariant(
        found !== null && compareBytes(found.key, e.key) === 0 && found.rid.pageId === e.rid.pageId && found.rid.slot === e.rid.slot,
        `B+tree entry to delete not found in index rooted at ${this.root}`,
      );
      this.pager.markDirty(ref);
      removeCell(p, leaf, pos);
    } finally {
      this.pager.unpin(ref);
    }
  }

  /** Range scan in key order (G.13). Bounds compare keys only. */
  scan(lo: KeyBound | null, hi: KeyBound | null): BTreeCursor {
    let leaf: PageId;
    let pos: number;
    if (lo) {
      const target: Entry = { key: lo.key, rid: MIN_RID };
      leaf = this.descend(target).leaf;
      pos = this.withNode(leaf, (p) => this.lowerBound(p, leaf, target));
    } else {
      leaf = this.leftmostLeaf();
      pos = 0;
    }
    let done = false;
    let hops = 0;
    const limit = this.pager.pageCount;
    return {
      next: (): Entry | null => {
        while (!done) {
          const r = this.withNode(leaf, (p): Entry | 'next' | 'end' => {
            if (!nd.isLeaf(p)) throw new CorruptionError('BTREE_MALFORMED', `leaf chain reaches internal page ${leaf}`);
            if (pos < nd.count(p)) return readEntry(p, pos++, leaf);
            const next = nd.rightPtr(p);
            if (next === 0) return 'end';
            if (++hops > limit) throw new CorruptionError('BTREE_MALFORMED', `leaf chain of ${this.root} is cyclic`);
            leaf = next;
            pos = 0;
            return 'next';
          });
          if (r === 'end') {
            done = true;
            break;
          }
          if (r === 'next') continue;
          if (lo && !lo.inclusive && compareBytes(r.key, lo.key) === 0) continue;
          if (hi) {
            const c = compareBytes(r.key, hi.key);
            if (c > 0 || (c === 0 && !hi.inclusive)) {
              done = true;
              break;
            }
          }
          return r;
        }
        return null;
      },
    };
  }

  private leftmostLeaf(): PageId {
    let id = this.root;
    for (let depth = 0; ; depth++) {
      if (depth > MAX_DEPTH) throw new CorruptionError('BTREE_MALFORMED', `B+tree ${this.root} is deeper than ${MAX_DEPTH}`);
      const next = this.withNode(id, (p) => (nd.isLeaf(p) ? null : readChild(p, 0, id)));
      if (next === null) return id;
      id = next;
    }
  }

  /** Number of levels (1 = the root is a leaf). */
  height(): number {
    let id = this.root;
    for (let depth = 1; ; depth++) {
      if (depth > MAX_DEPTH) throw new CorruptionError('BTREE_MALFORMED', `B+tree ${this.root} is deeper than ${MAX_DEPTH}`);
      const next = this.withNode(id, (p) => (nd.isLeaf(p) ? null : readChild(p, 0, id)));
      if (next === null) return depth;
      id = next;
    }
  }

  /** All node pages (pre-order). */
  pageIds(): PageId[] {
    const out: PageId[] = [];
    const seen = new Set<PageId>();
    const visit = (id: PageId, depth: number): void => {
      if (depth > MAX_DEPTH || seen.has(id)) throw new CorruptionError('BTREE_MALFORMED', `B+tree ${this.root} has a cycle at page ${id}`);
      seen.add(id);
      out.push(id);
      const children = this.withNode(id, (p) => (nd.isLeaf(p) ? [] : Array.from({ length: nd.count(p) + 1 }, (_, i) => readChild(p, i, id))));
      for (const c of children) visit(c, depth + 1);
    };
    visit(this.root, 0);
    return out;
  }

  destroy(): void {
    for (const id of this.pageIds()) this.pager.free(id);
  }

  /** I8–I10. Returns owned pages and all entries in key order for the index ↔ heap check (I11). */
  check(object: string): { pages: PageId[]; entries: Entry[]; issues: IntegrityIssue[] } {
    const issues: IntegrityIssue[] = [];
    const pages: PageId[] = [];
    const entries: Entry[] = [];
    const leaves: PageId[] = [];
    const leafDepths = new Set<number>();
    const seen = new Set<PageId>();
    const add = (code: IntegrityIssue['code'], pageId: number, message: string): void => {
      issues.push({ code, pageId, object, message: `page ${pageId}: ${message}` });
    };
    const visit = (id: PageId, depth: number, lo: Entry | null, hi: Entry | null): void => {
      if (depth > MAX_DEPTH || seen.has(id) || id <= 0 || id >= this.pager.pageCount) {
        add('BTREE_SHAPE_INVALID', id, 'cycle, excessive depth or out-of-range child');
        return;
      }
      seen.add(id);
      pages.push(id);
      let ref: PageRef;
      try {
        ref = this.pager.pin(id);
      } catch (e) {
        if (e instanceof MiniDbError && e.name === 'CorruptionError') {
          issues.push({ code: 'PAGE_CORRUPT', pageId: id, object, message: e.message });
          return;
        }
        throw e;
      }
      let children: Array<{ id: PageId; lo: Entry | null; hi: Entry | null }> = [];
      try {
        const p = ref.data;
        const t = pageTypeOf(p);
        if (t !== PageType.BTREE_LEAF && t !== PageType.BTREE_INTERNAL) {
          add('BTREE_SHAPE_INVALID', id, `page type ${t} inside the tree`);
          return;
        }
        const geo = checkNodeGeometry(p, id, object);
        issues.push(...geo);
        if (geo.length > 0) return;
        const n = nd.count(p);
        const es: Entry[] = [];
        for (let i = 0; i < n; i++) es.push(readEntry(p, i, id));
        for (let i = 0; i < n; i++) {
          const e = es[i] as Entry;
          if (i > 0 && this.cmp(es[i - 1] as Entry, e) >= 0) add('BTREE_ORDER_INVALID', id, `entries ${i - 1} and ${i} out of order`);
          if (lo && this.cmp(e, lo) < 0) add('BTREE_ORDER_INVALID', id, `entry ${i} below the separator bound`);
          if (hi && this.cmp(e, hi) >= 0) add('BTREE_ORDER_INVALID', id, `entry ${i} not below the separator bound`);
        }
        if (nd.isLeaf(p)) {
          leaves.push(id);
          leafDepths.add(depth);
          entries.push(...es);
        } else {
          if (n < 1) add('BTREE_SHAPE_INVALID', id, 'internal node without cells');
          children = es.map((e, i) => ({ id: readChild(p, i, id), lo: i === 0 ? lo : (es[i - 1] as Entry), hi: e }));
          children.push({ id: nd.rightPtr(p), lo: n > 0 ? (es[n - 1] as Entry) : lo, hi });
        }
      } finally {
        this.pager.unpin(ref);
      }
      for (const c of children) visit(c.id, depth + 1, c.lo, c.hi);
    };
    visit(this.root, 0, null, null);
    if (leafDepths.size > 1) add('BTREE_SHAPE_INVALID', this.root, `leaves at different depths ${[...leafDepths].join(',')}`);
    // leaf chain: from the leftmost leaf, rightPtr visits exactly the leaves in order and ends with 0
    if (issues.length === 0 && leaves.length > 0) {
      let id = leaves[0] as PageId;
      for (let i = 0; i < leaves.length; i++) {
        if (id !== leaves[i]) {
          add('BTREE_SHAPE_INVALID', leaves[i] as PageId, `leaf chain reaches page ${id} instead of ${leaves[i]}`);
          break;
        }
        id = this.withNode(id, (p) => nd.rightPtr(p));
        if (i === leaves.length - 1 && id !== 0) add('BTREE_SHAPE_INVALID', leaves[i] as PageId, `last leaf points to ${id}`);
      }
    }
    if (this.unique) {
      for (let i = 1; i < entries.length; i++) {
        if (compareBytes((entries[i - 1] as Entry).key, (entries[i] as Entry).key) === 0) {
          add('BTREE_ORDER_INVALID', this.root, 'duplicate key in a unique index');
          break;
        }
      }
    }
    return { pages, entries, issues };
  }
}

/** Smallest m in [min, max] whose prefix size reaches half of the total (G.13). */
function splitPoint(sizes: number[], min: number, max: number): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  let acc = 0;
  let m = min;
  for (let i = 0; i < sizes.length; i++) {
    acc += sizes[i] as number;
    if (acc >= total / 2) {
      m = i + 1;
      break;
    }
  }
  return Math.max(min, Math.min(max, m));
}
