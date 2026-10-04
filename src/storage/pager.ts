import { dirname } from 'node:path';
import { invariant } from '../errors/assert.js';
import { CorruptionError, LimitError, MiniDbError, StorageError, TransactionError, UsageError } from '../errors/errors.js';
import { bytesEqual, readU32, writeU32 } from '../util/bytes.js';
import { initHeaderPage, parseHeaderPage, readHeaderFields, type FileHeader } from './file-header.js';
import {
  DEFAULT_CACHE_PAGES,
  DEFAULT_WAL_AUTOCHECKPOINT_FRAMES,
  DIRTY_RESERVE_PAGES,
  FH_CATALOG_ROOT,
  FH_FREELIST_COUNT,
  FH_FREELIST_HEAD,
  FH_PAGE_COUNT,
  FP_NEXT_FREE,
  MAX_CACHE_PAGES,
  MIN_CACHE_PAGES,
  PAGE_SIZE,
  PageType,
  WAL_FRAME_HEADER_SIZE,
  WAL_HEADER_SIZE,
  walFrameOffset,
} from './layout.js';
import { initPage, pageIdOf, pageTypeOf, stampPageCrc, verifyPage } from './page.js';
import { createIoStats, resetIoStats, type IoStats } from './stats.js';
import type { LockHandle, StorageFile, Vfs } from './vfs.js';
import { walPathOf } from './vfs.js';
import { readWalHeader, scanWal, WalFile, type WalHeader } from './wal.js';

export type PageId = number;

/** A pinned view of a cached page (E.4). `data` is the cache frame itself: call markDirty before mutating. */
export interface PageRef {
  readonly id: PageId;
  readonly data: Uint8Array;
}

export interface PagerOptions {
  cachePages: number;
  walAutoCheckpointFrames: number;
  entropy: (n: number) => Uint8Array;
  /** Runs inside the bootstrap transaction of a new database (DC-63). */
  initialize: (p: Pager) => void;
}

export interface PagerStats {
  io: IoStats;
  cache: { hits: number; misses: number; evictions: number; capacity: number; cached: number; dirty: number };
  txn: { commits: number; rollbacks: number; statementRollbacks: number; checkpoints: number };
  wal: { frames: number; bytes: number };
  recovery: { framesScanned: number; framesApplied: number; txnsApplied: number; discardedTailBytes: number };
}

export type PagerState = 'open' | 'failed' | 'closed';

interface Frame {
  data: Uint8Array;
  pins: number;
  dirty: boolean;
}

export function defaultPagerOptions(partial: Partial<PagerOptions> & Pick<PagerOptions, 'entropy'>): PagerOptions {
  return {
    cachePages: partial.cachePages ?? DEFAULT_CACHE_PAGES,
    walAutoCheckpointFrames: partial.walAutoCheckpointFrames ?? DEFAULT_WAL_AUTOCHECKPOINT_FRAMES,
    entropy: partial.entropy,
    initialize: partial.initialize ?? (() => {}),
  };
}

function readHeaderFrom(data: StorageFile): FileHeader {
  const buf = new Uint8Array(PAGE_SIZE);
  return parseHeaderPage(buf, data.read(buf, 0));
}

function tryReadHeader(data: StorageFile): FileHeader | null {
  try {
    return readHeaderFrom(data);
  } catch (e) {
    if (e instanceof CorruptionError) return null;
    throw e;
  }
}

/**
 * Page cache, no-steal transactions with statement savepoints, WAL commit, checkpoint and recovery
 * (DURABILITY.md G.1–G.11).
 */
export class Pager {
  private readonly frames = new Map<PageId, Frame>(); // insertion order = LRU order
  private _state: PagerState = 'open';
  private failure: unknown = undefined;

  private txnActive = false;
  private readonly txnDirty = new Set<PageId>();
  private headerBefore: Uint8Array | null = null;
  private stmtActive = false;
  private readonly savepoint = new Map<PageId, Uint8Array | null>();

  private wal!: WalFile;
  private readonly walIndex = new Map<PageId, number>();
  private _checkpointDue = false;

  private readonly io: IoStats = createIoStats();
  private readonly cacheStats = { hits: 0, misses: 0, evictions: 0 };
  private readonly txnStats = { commits: 0, rollbacks: 0, statementRollbacks: 0, checkpoints: 0 };
  private readonly recovery = { framesScanned: 0, framesApplied: 0, txnsApplied: 0, discardedTailBytes: 0 };

  private constructor(
    private readonly opts: PagerOptions,
    private readonly lock: LockHandle,
    private readonly data: StorageFile,
    private readonly walFile: StorageFile,
  ) {}

  // ---------------------------------------------------------------- open (G.7)

  static open(vfs: Vfs, path: string, options: PagerOptions): Pager {
    const opts = options;
    if (!Number.isInteger(opts.cachePages) || opts.cachePages < MIN_CACHE_PAGES || opts.cachePages > MAX_CACHE_PAGES) {
      throw new UsageError('INVALID_OPTION', `cachePages must be an integer in [${MIN_CACHE_PAGES}, ${MAX_CACHE_PAGES}]`);
    }
    if (!Number.isInteger(opts.walAutoCheckpointFrames) || opts.walAutoCheckpointFrames < 0) {
      throw new UsageError('INVALID_OPTION', 'walAutoCheckpointFrames must be a non-negative integer');
    }
    const lock = vfs.acquireLock(path);
    const walPath = walPathOf(path);
    let data: StorageFile | undefined;
    let walF: StorageFile | undefined;
    try {
      const newData = !vfs.exists(path);
      const newWal = !vfs.exists(walPath);
      data = vfs.open(path);
      walF = vfs.open(walPath);
      const pager = new Pager(opts, lock, data, walF);
      if (newData || newWal) {
        if (vfs.syncDir(dirname(path))) pager.io.dirSyncs++; // FSYNC-F1
      }
      pager.recoverOrCreate();
      return pager;
    } catch (e) {
      try {
        data?.close();
        walF?.close();
      } finally {
        lock.release();
      }
      throw e;
    }
  }

  private recoverOrCreate(): void {
    const data = this.data;
    const walF = this.walFile;
    const w = readWalHeader(walF);
    const walHeader: WalHeader | null = w.kind === 'valid' ? w.header : null;
    let header: FileHeader;
    let wal: WalFile | null = null;

    const scan = walHeader ? scanWal(walF, walHeader, this.io) : null;
    if (scan) {
      this.recovery.framesScanned = scan.framesScanned;
      this.recovery.discardedTailBytes = scan.discardedTailBytes;
    }
    if (walHeader && scan && scan.committed.size > 0) {
      const existing = tryReadHeader(data);
      if (existing && !bytesEqual(existing.dbId, walHeader.dbId)) {
        throw new CorruptionError('WAL_MISMATCH', 'the WAL belongs to a different database');
      }
      const buf = new Uint8Array(PAGE_SIZE);
      for (const id of [...scan.committed.keys()].sort((a, b) => a - b)) {
        this.walReadInto(walF, scan.committed.get(id) as number, id, buf);
        data.write(buf, id * PAGE_SIZE);
        this.io.dataPageWrites++;
      }
      data.sync(); // FSYNC-F5 (recovery)
      this.io.dataSyncs++;
      header = readHeaderFrom(data);
      if (!bytesEqual(header.dbId, walHeader.dbId)) throw new CorruptionError('WAL_MISMATCH', 'the WAL belongs to a different database');
      this.recovery.framesApplied = scan.committed.size;
      this.recovery.txnsApplied = scan.txnsApplied;
    } else if (data.size() === 0) {
      const dbId = this.opts.entropy(8);
      this.wal = WalFile.reset(walF, dbId, walHeader, this.opts.entropy, this.io);
      this.bootstrap(dbId);
      header = readHeaderFields((this.frames.get(0) as Frame).data);
      wal = this.wal;
    } else {
      header = readHeaderFrom(data);
    }

    if (wal === null) {
      if (walHeader && walF.size() === WAL_HEADER_SIZE && bytesEqual(walHeader.dbId, header.dbId)) {
        wal = new WalFile(walF, walHeader, this.io);
      } else {
        wal = WalFile.reset(walF, header.dbId, walHeader, this.opts.entropy, this.io);
      }
      this.wal = wal;
      if (data.size() < header.pageCount * PAGE_SIZE) {
        throw new CorruptionError('FILE_TRUNCATED', `data file has ${data.size()} bytes, expected at least ${header.pageCount * PAGE_SIZE}`);
      }
      const page0 = new Uint8Array(PAGE_SIZE);
      data.read(page0, 0);
      this.io.dataPageReads++;
      verifyPage(page0, 0, 'data file');
      this.frames.set(0, { data: page0, pins: 0, dirty: false });
    }
  }

  /** DC-63: page 0 + whatever `initialize` allocates, committed, then checkpointed. */
  private bootstrap(dbId: Uint8Array): void {
    this.txnActive = true;
    const page0 = new Uint8Array(PAGE_SIZE);
    initHeaderPage(page0, { pageCount: 1, freelistHead: 0, freelistCount: 0, catalogRoot: 0, dbId });
    this.frames.set(0, { data: page0, pins: 0, dirty: true });
    this.txnDirty.add(0);
    this.headerBefore = null;
    this.opts.initialize(this);
    this.commitTxn();
    this.checkpoint();
  }

  // ---------------------------------------------------------------- state

  get state(): PagerState {
    return this._state;
  }

  get checkpointDue(): boolean {
    return this._checkpointDue;
  }

  /** Throws DB_CLOSED / DB_FAILED unless the pager is open. */
  ensureUsable(): void {
    this.assertUsable();
  }

  private assertUsable(): void {
    if (this._state === 'closed') throw new UsageError('DB_CLOSED', 'database is closed');
    if (this._state === 'failed') {
      const cause = this.failure;
      const what = cause instanceof MiniDbError ? cause.code : String(cause);
      throw new StorageError('DB_FAILED', `database is in failed state; close and reopen (cause: ${what})`, { cause });
    }
  }

  /** DC-49: enter FAILED. The first cause is kept. */
  markFailed(cause: unknown): void {
    if (this._state === 'open') {
      this._state = 'failed';
      this.failure = cause;
    }
  }

  /** Runs `fn`; CorruptionError / InternalError / non-MiniDb errors put the pager in FAILED (DC-49, DC-51). */
  private guarded<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof MiniDbError) || e.name === 'CorruptionError' || e.name === 'InternalError') this.markFailed(e);
      throw e;
    }
  }

  private header0(): Uint8Array {
    return (this.frames.get(0) as Frame).data;
  }

  get pageCount(): number {
    return readU32(this.header0(), FH_PAGE_COUNT);
  }

  get freelistHead(): number {
    return readU32(this.header0(), FH_FREELIST_HEAD);
  }

  get freelistCount(): number {
    return readU32(this.header0(), FH_FREELIST_COUNT);
  }

  get dbId(): Uint8Array {
    return readHeaderFields(this.header0()).dbId;
  }

  getRootPointer(): number {
    return readU32(this.header0(), FH_CATALOG_ROOT);
  }

  setRootPointer(pageId: PageId): void {
    const h = this.pin(0);
    try {
      this.markDirty(h);
      writeU32(h.data, FH_CATALOG_ROOT, pageId);
    } finally {
      this.unpin(h);
    }
  }

  // ---------------------------------------------------------------- read path (G.2)

  private walReadInto(walF: StorageFile, frameNo: number, id: PageId, dst: Uint8Array): void {
    this.io.walFrameReads++;
    const n = walF.read(dst, walFrameOffset(frameNo) + WAL_FRAME_HEADER_SIZE);
    if (n < PAGE_SIZE) throw new CorruptionError('PAGE_OUT_OF_RANGE', `WAL frame ${frameNo} for page ${id} is truncated`);
    verifyPage(dst, id, 'wal');
  }

  private makeRoom(): void {
    while (this.frames.size >= this.opts.cachePages) {
      let victim: PageId | null = null;
      for (const [id, f] of this.frames) {
        if (id !== 0 && !f.dirty && f.pins === 0) {
          victim = id;
          break;
        }
      }
      if (victim === null) throw new LimitError('TXN_TOO_LARGE', 'page cache exhausted by dirty or pinned pages');
      this.frames.delete(victim);
      this.cacheStats.evictions++;
    }
  }

  pin(id: PageId): PageRef {
    this.assertUsable();
    return this.guarded(() => {
      const f = this.frames.get(id);
      if (f) {
        f.pins++;
        if (id !== 0) {
          this.frames.delete(id);
          this.frames.set(id, f);
        }
        this.cacheStats.hits++;
        return { id, data: f.data };
      }
      if (!Number.isInteger(id) || id < 0 || id >= this.pageCount) {
        throw new CorruptionError('PAGE_OUT_OF_RANGE', `page ${id} is outside the database (page count ${this.pageCount})`);
      }
      this.cacheStats.misses++;
      this.makeRoom();
      const buf = new Uint8Array(PAGE_SIZE);
      const frameNo = this.walIndex.get(id);
      if (frameNo !== undefined) {
        invariant(frameNo < this.wal.frames, `I15: WAL index frame ${frameNo} for page ${id} beyond ${this.wal.frames} frames`);
        this.walReadInto(this.walFile, frameNo, id, buf);
      } else {
        this.io.dataPageReads++;
        const n = this.data.read(buf, id * PAGE_SIZE);
        if (n < PAGE_SIZE) throw new CorruptionError('PAGE_OUT_OF_RANGE', `page ${id} lies beyond the end of the data file`);
        verifyPage(buf, id, 'data file');
      }
      this.frames.set(id, { data: buf, pins: 1, dirty: false });
      return { id, data: buf };
    });
  }

  unpin(ref: PageRef): void {
    const f = this.frames.get(ref.id);
    invariant(f !== undefined && f.data === ref.data, `unpin of a page that is not cached: ${ref.id}`);
    invariant(f.pins > 0, `unpin underflow on page ${ref.id}`);
    f.pins--;
  }

  /** Pins on pages other than page 0 (I13). */
  totalPins(): number {
    let n = 0;
    for (const [id, f] of this.frames) if (id !== 0) n += f.pins;
    return n;
  }

  // ---------------------------------------------------------------- modification (G.3)

  markDirty(ref: PageRef): void {
    this.assertUsable();
    const f = this.frames.get(ref.id);
    invariant(this.txnActive, `markDirty outside a transaction (page ${ref.id})`);
    invariant(f !== undefined && f.data === ref.data && f.pins > 0, `markDirty on an unpinned page ${ref.id}`);
    const id = ref.id;
    if (!this.txnDirty.has(id) && this.txnDirty.size + 1 > this.opts.cachePages - DIRTY_RESERVE_PAGES) {
      throw new LimitError('TXN_TOO_LARGE', `transaction exceeds ${this.opts.cachePages - DIRTY_RESERVE_PAGES} dirty pages; increase cachePages`);
    }
    if (this.stmtActive && !this.savepoint.has(id)) {
      this.savepoint.set(id, this.txnDirty.has(id) ? Uint8Array.from(f.data) : null);
    }
    if (id === 0 && !this.txnDirty.has(0)) this.headerBefore = Uint8Array.from(f.data);
    this.txnDirty.add(id);
    f.dirty = true;
  }

  allocate(type: PageType): PageRef {
    this.assertUsable();
    return this.guarded(() => {
      const h = this.pin(0);
      try {
        this.markDirty(h);
        const head = readU32(h.data, FH_FREELIST_HEAD);
        let ref: PageRef;
        if (head !== 0) {
          ref = this.pin(head);
          try {
            if (pageTypeOf(ref.data) !== PageType.FREE) {
              throw new CorruptionError('FREELIST_INVALID', `freelist page ${head} is not a FREE page`);
            }
            this.markDirty(ref);
          } catch (e) {
            this.unpin(ref);
            throw e;
          }
          writeU32(h.data, FH_FREELIST_HEAD, readU32(ref.data, FP_NEXT_FREE));
          writeU32(h.data, FH_FREELIST_COUNT, readU32(h.data, FH_FREELIST_COUNT) - 1);
        } else {
          const id = readU32(h.data, FH_PAGE_COUNT);
          invariant(id < 0xffffffff, 'page id space exhausted');
          this.makeRoom();
          const f: Frame = { data: new Uint8Array(PAGE_SIZE), pins: 1, dirty: false };
          this.frames.set(id, f);
          ref = { id, data: f.data };
          try {
            this.markDirty(ref);
          } catch (e) {
            this.frames.delete(id);
            throw e;
          }
          writeU32(h.data, FH_PAGE_COUNT, id + 1);
        }
        initPage(ref.data, type, ref.id);
        return ref;
      } finally {
        this.unpin(h);
      }
    });
  }

  free(id: PageId): void {
    this.assertUsable();
    this.guarded(() => {
      invariant(Number.isInteger(id) && id >= 1 && id < this.pageCount, `free of invalid page ${id}`);
      const h = this.pin(0);
      try {
        const ref = this.pin(id);
        try {
          this.markDirty(h);
          this.markDirty(ref);
          initPage(ref.data, PageType.FREE, id);
          writeU32(ref.data, FP_NEXT_FREE, readU32(h.data, FH_FREELIST_HEAD));
          writeU32(h.data, FH_FREELIST_HEAD, id);
          writeU32(h.data, FH_FREELIST_COUNT, readU32(h.data, FH_FREELIST_COUNT) + 1);
        } finally {
          this.unpin(ref);
        }
      } finally {
        this.unpin(h);
      }
    });
  }

  /** Walks the freelist (I4). Throws FREELIST_INVALID on cycles, wrong types or a count mismatch. */
  freelistPages(): PageId[] {
    const out: PageId[] = [];
    const seen = new Set<PageId>();
    let id = this.freelistHead;
    while (id !== 0) {
      if (seen.has(id) || id >= this.pageCount) throw new CorruptionError('FREELIST_INVALID', `freelist is cyclic or out of range at page ${id}`);
      seen.add(id);
      out.push(id);
      const ref = this.pin(id);
      try {
        if (pageTypeOf(ref.data) !== PageType.FREE) throw new CorruptionError('FREELIST_INVALID', `freelist page ${id} is not FREE`);
        id = readU32(ref.data, FP_NEXT_FREE);
      } finally {
        this.unpin(ref);
      }
    }
    if (out.length !== this.freelistCount) {
      throw new CorruptionError('FREELIST_INVALID', `freelist has ${out.length} pages but the header says ${this.freelistCount}`);
    }
    return out;
  }

  // ---------------------------------------------------------------- transactions (G.4, G.5)

  inTxn(): boolean {
    return this.txnActive;
  }

  inStatement(): boolean {
    return this.stmtActive;
  }

  beginTxn(): void {
    this.assertUsable();
    invariant(!this.txnActive, 'beginTxn while a transaction is active');
    invariant(this.txnDirty.size === 0 && this.headerBefore === null, 'I14: dirty state outside a transaction');
    this.txnActive = true;
  }

  beginStatement(): void {
    this.assertUsable();
    invariant(this.txnActive && !this.stmtActive, 'beginStatement requires an active transaction and no statement');
    this.stmtActive = true;
    this.savepoint.clear();
  }

  private checkNoPins(): void {
    const pins = this.totalPins();
    if (pins !== 0) {
      this.guarded(() => invariant(false, `I13: ${pins} page pin(s) held at statement end`));
    }
  }

  releaseStatement(): void {
    invariant(this.stmtActive, 'releaseStatement without a statement');
    this.checkNoPins();
    this.savepoint.clear();
    this.stmtActive = false;
  }

  rollbackStatement(): void {
    invariant(this.stmtActive, 'rollbackStatement without a statement');
    this.stmtActive = false;
    this.checkNoPins();
    for (const [id, img] of this.savepoint) {
      const f = this.frames.get(id);
      if (img !== null) {
        invariant(f !== undefined, `savepoint page ${id} vanished from the cache`);
        f.data.set(img);
      } else if (id === 0) {
        // Page 0 stays resident (G.1): restore the last committed image in place (rev1).
        invariant(f !== undefined && this.headerBefore !== null, 'page 0 savepoint without headerBefore');
        f.data.set(this.headerBefore);
        f.dirty = false;
        this.txnDirty.delete(0);
        this.headerBefore = null;
      } else {
        this.frames.delete(id);
        this.txnDirty.delete(id);
      }
    }
    this.savepoint.clear();
    this.txnStats.statementRollbacks++;
  }

  rollbackTxn(): void {
    invariant(this.txnActive, 'rollbackTxn without a transaction');
    this.checkNoPins();
    for (const id of this.txnDirty) {
      if (id === 0) {
        const f = this.frames.get(0) as Frame;
        invariant(this.headerBefore !== null, 'dirty page 0 without headerBefore');
        f.data.set(this.headerBefore);
        f.dirty = false;
      } else {
        this.frames.delete(id);
      }
    }
    this.endTxn();
    this.txnStats.rollbacks++;
  }

  private endTxn(): void {
    this.txnDirty.clear();
    this.headerBefore = null;
    this.savepoint.clear();
    this.stmtActive = false;
    this.txnActive = false;
  }

  commitTxn(): void {
    this.assertUsable();
    invariant(this.txnActive && !this.stmtActive, 'commitTxn requires an active transaction and no open statement');
    this.checkNoPins();
    if (this.txnDirty.size === 0) {
      this.endTxn();
      return;
    }
    const ids = [...this.txnDirty].sort((a, b) => a - b);
    const pages = ids.map((id) => {
      const f = this.frames.get(id) as Frame;
      invariant(pageIdOf(f.data) === id, `page ${id} carries page id ${pageIdOf(f.data)}`);
      stampPageCrc(f.data);
      return { id, data: f.data };
    });
    let first: number;
    try {
      first = this.wal.appendTxn(pages);
    } catch (e) {
      if (!(e instanceof MiniDbError)) {
        this.markFailed(e);
        throw e;
      }
      const err = new StorageError('IO_COMMIT_UNKNOWN', 'commit failed during WAL write; the transaction may or may not be durable', { cause: e });
      this.markFailed(err);
      throw err;
    }
    ids.forEach((id, i) => {
      this.walIndex.set(id, first + i);
      (this.frames.get(id) as Frame).dirty = false;
    });
    this.endTxn();
    this.txnStats.commits++;
    if (this.opts.walAutoCheckpointFrames > 0 && this.wal.frames >= this.opts.walAutoCheckpointFrames) {
      this._checkpointDue = true;
    }
  }

  // ---------------------------------------------------------------- checkpoint (G.6)

  checkpoint(): void {
    this.assertUsable();
    if (this.txnActive) throw new TransactionError('TXN_ACTIVE', 'checkpoint is not allowed inside a transaction');
    if (this.wal.frames === 0) {
      this._checkpointDue = false;
      return;
    }
    try {
      const tmp = new Uint8Array(PAGE_SIZE);
      for (const id of [...this.walIndex.keys()].sort((a, b) => a - b)) {
        const cached = this.frames.get(id);
        let img: Uint8Array;
        if (cached) {
          invariant(!cached.dirty, `dirty page ${id} at checkpoint`);
          img = cached.data;
        } else {
          this.walReadInto(this.walFile, this.walIndex.get(id) as number, id, tmp);
          img = tmp;
        }
        this.data.write(img, id * PAGE_SIZE); // I16: data-file writes only in checkpoint/recovery
        this.io.dataPageWrites++;
      }
      this.data.sync(); // FSYNC-F5
      this.io.dataSyncs++;
      this.wal.resetAfterCheckpoint(this.opts.entropy);
    } catch (e) {
      this.markFailed(e);
      throw e;
    }
    this.walIndex.clear();
    this._checkpointDue = false;
    this.txnStats.checkpoints++;
  }

  /** Runs a due auto-checkpoint when no transaction is active (DC-26). */
  maybeCheckpoint(): void {
    if (this._checkpointDue && !this.txnActive) this.checkpoint();
  }

  // ---------------------------------------------------------------- close (G.8)

  close(): void {
    if (this._state === 'closed') return;
    try {
      if (this._state === 'open') {
        if (this.txnActive) {
          if (this.stmtActive) this.rollbackStatement();
          this.rollbackTxn();
        }
        this.checkpoint();
      }
    } finally {
      this._state = 'closed';
      this.frames.clear();
      try {
        this.data.close();
        this.walFile.close();
      } finally {
        this.lock.release();
      }
    }
  }

  // ---------------------------------------------------------------- stats

  stats(): PagerStats {
    return {
      io: { ...this.io },
      cache: {
        ...this.cacheStats,
        capacity: this.opts.cachePages,
        cached: this.frames.size,
        dirty: this.txnDirty.size,
      },
      txn: { ...this.txnStats },
      wal: { frames: this.wal.frames, bytes: walFrameOffset(this.wal.frames) },
      recovery: { ...this.recovery },
    };
  }

  resetStats(): void {
    resetIoStats(this.io);
    Object.assign(this.cacheStats, { hits: 0, misses: 0, evictions: 0 });
    Object.assign(this.txnStats, { commits: 0, rollbacks: 0, statementRollbacks: 0, checkpoints: 0 });
  }

  /** Physical size of the data file (I1). */
  dataFileSize(): number {
    this.assertUsable();
    return this.data.size();
  }

  /** Test/introspection helper: is the page currently cached? */
  isCached(id: PageId): boolean {
    return this.frames.has(id);
  }

  /** Test/introspection helper: frame number of the page's latest committed WAL image, if any. */
  walFrameOf(id: PageId): number | undefined {
    return this.walIndex.get(id);
  }

  /** Header fields as currently cached (including uncommitted changes). */
  headerFields(): FileHeader {
    return readHeaderFields(this.header0());
  }

}
