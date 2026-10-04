import { CorruptionError } from '../errors/errors.js';
import { invariant } from '../errors/assert.js';
import { bytesEqual, readU16, readU32, writeU16, writeU32 } from '../util/bytes.js';
import { crc32 } from '../util/crc32.js';
import {
  DB_ID_SIZE,
  PAGE_SIZE,
  WAL_FLAG_COMMIT,
  WAL_FRAME_HEADER_SIZE,
  WAL_FRAME_SIZE,
  WAL_HEADER_SIZE,
  WAL_MAGIC,
  WAL_VERSION,
  walFrameOffset,
  WF_CHECKSUM,
  WF_FLAGS,
  WF_PAGE_ID,
  WF_RESERVED,
  WF_SALT1,
  WF_SALT2,
  WH_CHECKPOINT_SEQ,
  WH_CRC,
  WH_DB_ID,
  WH_MAGIC,
  WH_PAGE_SIZE,
  WH_SALT1,
  WH_SALT2,
  WH_VERSION,
} from './layout.js';
import { computePageCrc, pageIdOf } from './page.js';
import type { IoStats } from './stats.js';
import type { StorageFile } from './vfs.js';

/** D.8 WAL header. */
export interface WalHeader {
  checkpointSeq: number;
  dbId: Uint8Array;
  salt1: number;
  salt2: number;
  /** CRC32 of bytes [0, 44); seeds the frame checksum chain. */
  headerCrc: number;
}

export type WalHeaderRead = { kind: 'valid'; header: WalHeader } | { kind: 'empty' };

export function encodeWalHeader(h: Omit<WalHeader, 'headerCrc'>): { bytes: Uint8Array; header: WalHeader } {
  const b = new Uint8Array(WAL_HEADER_SIZE);
  b.set(WAL_MAGIC, WH_MAGIC);
  writeU16(b, WH_VERSION, WAL_VERSION);
  writeU32(b, WH_PAGE_SIZE, PAGE_SIZE);
  writeU32(b, WH_CHECKPOINT_SEQ, h.checkpointSeq);
  b.set(h.dbId.subarray(0, DB_ID_SIZE), WH_DB_ID);
  writeU32(b, WH_SALT1, h.salt1);
  writeU32(b, WH_SALT2, h.salt2);
  const headerCrc = crc32(b, 0, 0, WH_CRC);
  writeU32(b, WH_CRC, headerCrc);
  return { bytes: b, header: { ...h, dbId: Uint8Array.from(h.dbId), headerCrc } };
}

function decodeWalHeader(b: Uint8Array): WalHeader | null {
  if (!bytesEqual(b.subarray(WH_MAGIC, WH_MAGIC + 4), WAL_MAGIC)) return null;
  if (readU16(b, WH_VERSION) !== WAL_VERSION) return null;
  if (readU32(b, WH_PAGE_SIZE) !== PAGE_SIZE) return null;
  const headerCrc = readU32(b, WH_CRC);
  if (crc32(b, 0, 0, WH_CRC) !== headerCrc) return null;
  return {
    checkpointSeq: readU32(b, WH_CHECKPOINT_SEQ),
    dbId: Uint8Array.from(b.subarray(WH_DB_ID, WH_DB_ID + DB_ID_SIZE)),
    salt1: readU32(b, WH_SALT1),
    salt2: readU32(b, WH_SALT2),
    headerCrc,
  };
}

/**
 * DC-22: invalid header ∧ size ≤ 48 → empty WAL (crash during reset);
 * invalid header ∧ size > 48 → WAL_HEADER_INVALID.
 */
export function readWalHeader(file: StorageFile): WalHeaderRead {
  const size = file.size();
  const b = new Uint8Array(WAL_HEADER_SIZE);
  const n = file.read(b, 0);
  const header = n === WAL_HEADER_SIZE ? decodeWalHeader(b) : null;
  if (header) return { kind: 'valid', header };
  if (size <= WAL_HEADER_SIZE) return { kind: 'empty' };
  throw new CorruptionError('WAL_HEADER_INVALID', `WAL header is invalid but the WAL holds ${size} bytes`);
}

/** Frame checksum (DC-18): CRC32(LE32(prev) ‖ frameHeader[0..16) ‖ page). */
export function frameChecksum(prev: number, frameHeader: Uint8Array, page: Uint8Array): number {
  const p = new Uint8Array(4);
  writeU32(p, 0, prev);
  let c = crc32(p);
  c = crc32(frameHeader, c, 0, WF_CHECKSUM);
  return crc32(page, c, 0, PAGE_SIZE);
}

export interface WalScan {
  /** pageId → frame number of its latest committed image. */
  committed: Map<number, number>;
  framesScanned: number;
  /** Frames up to and including the last COMMIT frame. */
  committedFrames: number;
  txnsApplied: number;
  discardedTailBytes: number;
}

/** G.7 scanWal: accepts frames up to the last COMMIT frame of an unbroken chain (D5). */
export function scanWal(file: StorageFile, header: WalHeader, stats?: IoStats): WalScan {
  const size = file.size();
  const committed = new Map<number, number>();
  let pending: Array<[number, number]> = [];
  let prev = header.headerCrc;
  let k = 0;
  let committedFrames = 0;
  let txnsApplied = 0;
  const frame = new Uint8Array(WAL_FRAME_SIZE);
  for (;;) {
    const off = walFrameOffset(k);
    if (size - off < WAL_FRAME_SIZE) break;
    if (file.read(frame, off) < WAL_FRAME_SIZE) break;
    if (stats) stats.walFrameReads++;
    const flags = readU32(frame, WF_FLAGS);
    if (readU32(frame, WF_SALT1) !== header.salt1 || readU32(frame, WF_SALT2) !== header.salt2) break;
    if ((flags & ~WAL_FLAG_COMMIT) !== 0 || readU32(frame, WF_RESERVED) !== 0) break;
    const page = frame.subarray(WAL_FRAME_HEADER_SIZE);
    if (frameChecksum(prev, frame, page) !== readU32(frame, WF_CHECKSUM)) break;
    const pageId = readU32(frame, WF_PAGE_ID);
    if (readU32(page, 4) !== computePageCrc(page) || pageIdOf(page) !== pageId) {
      throw new CorruptionError('WAL_FRAME_INVALID', `WAL frame ${k} has a valid checksum chain but an invalid page image`);
    }
    pending.push([pageId, k]);
    prev = readU32(frame, WF_CHECKSUM);
    k++;
    if (flags & WAL_FLAG_COMMIT) {
      for (const [id, n] of pending) committed.set(id, n);
      pending = [];
      txnsApplied++;
      committedFrames = k;
    }
  }
  return {
    committed,
    framesScanned: k,
    committedFrames,
    txnsApplied,
    discardedTailBytes: Math.max(0, size - walFrameOffset(committedFrames)),
  };
}

export interface WalPage {
  id: number;
  /** Complete 4096-byte image with its page CRC already stamped. */
  data: Uint8Array;
}

/**
 * An open WAL generation. After open/recovery the WAL is always empty (G.7), so a session appends from frame 0
 * and every frame position is written exactly once per generation (D4).
 */
export class WalFile {
  private _header: WalHeader;
  private _frames = 0;
  private lastChecksum: number;

  constructor(
    readonly file: StorageFile,
    header: WalHeader,
    private readonly stats: IoStats,
  ) {
    this._header = header;
    this.lastChecksum = header.headerCrc;
  }

  get header(): WalHeader {
    return this._header;
  }

  get frames(): number {
    return this._frames;
  }

  /**
   * Writes a new generation header (G.7 walReset): truncate(0) → fsync [F2] → header → fsync [F3].
   * `previous` is the prior valid header, if any, to continue the checkpoint sequence.
   */
  static reset(
    file: StorageFile,
    dbId: Uint8Array,
    previous: WalHeader | null,
    entropy: (n: number) => Uint8Array,
    stats: IoStats,
  ): WalFile {
    file.truncate(0);
    stats.walTruncates++;
    file.sync(); // FSYNC-F2
    stats.walSyncs++;
    const salts = entropy(8);
    const { bytes, header } = encodeWalHeader({
      checkpointSeq: previous ? (previous.checkpointSeq + 1) >>> 0 : 1,
      dbId,
      salt1: readU32(salts, 0),
      salt2: readU32(salts, 4),
    });
    file.write(bytes, 0);
    file.sync(); // FSYNC-F3
    stats.walSyncs++;
    return new WalFile(file, header, stats);
  }

  /** G.4 steps 3–4: one write per frame, COMMIT on the last, then fsync [F4]. Pages must be sorted by id. */
  appendTxn(pages: readonly WalPage[]): number {
    invariant(pages.length > 0, 'appendTxn with no pages');
    const first = this._frames;
    let prev = this.lastChecksum;
    const frame = new Uint8Array(WAL_FRAME_SIZE);
    pages.forEach((p, i) => {
      invariant(i === 0 || p.id > (pages[i - 1] as WalPage).id, 'WAL frames must be in ascending page order');
      invariant(p.data.length === PAGE_SIZE && pageIdOf(p.data) === p.id, `bad page image for WAL frame (page ${p.id})`);
      frame.fill(0, 0, WAL_FRAME_HEADER_SIZE);
      writeU32(frame, WF_PAGE_ID, p.id);
      writeU32(frame, WF_FLAGS, i === pages.length - 1 ? WAL_FLAG_COMMIT : 0);
      writeU32(frame, WF_SALT1, this._header.salt1);
      writeU32(frame, WF_SALT2, this._header.salt2);
      frame.set(p.data, WAL_FRAME_HEADER_SIZE);
      prev = frameChecksum(prev, frame, p.data);
      writeU32(frame, WF_CHECKSUM, prev);
      this.file.write(frame, walFrameOffset(first + i));
      this.stats.walFrameWrites++;
    });
    this.file.sync(); // FSYNC-F4 (commit point)
    this.stats.walSyncs++;
    this._frames += pages.length;
    this.lastChecksum = prev;
    return first;
  }

  /** Reads the page image of frame `frameNo` into `dst` (verification is the caller's job). */
  readFramePage(frameNo: number, dst: Uint8Array): number {
    this.stats.walFrameReads++;
    return this.file.read(dst, walFrameOffset(frameNo) + WAL_FRAME_HEADER_SIZE);
  }

  /** Starts a new generation after a checkpoint (DC-21). */
  resetAfterCheckpoint(entropy: (n: number) => Uint8Array): void {
    const next = WalFile.reset(this.file, this._header.dbId, this._header, entropy, this.stats);
    this._header = next._header;
    this._frames = 0;
    this.lastChecksum = next.lastChecksum;
  }
}
