import { dirname } from 'node:path';
import { InternalError, StorageError } from '../errors/errors.js';
import type { Rng } from '../util/prng.js';
import type { LockHandle, StorageFile, Vfs } from './vfs.js';

/**
 * In-memory VFS that tracks durability (J.5):
 * - `current`: what reads see now,
 * - `durable`: content as of the last sync,
 * - `pending`: write/truncate operations since the last sync, in order,
 * - `dirSynced`: whether the file's creation has been made durable by syncDir.
 * `crashImage(policy)` produces the disk state a crash would leave behind.
 */

/** How unsynced state survives a simulated crash (J.5). */
export type CrashPolicy =
  | 'durable-only' // P-DURABLE: unsynced writes/truncates lost, un-dir-synced files vanish
  | 'all-pending' // P-ALL: everything written survives (including a torn prefix)
  | 'torn-only' // P-TORN: unsynced ops lost except the torn prefix of the crashing write
  | 'random-subset'; // P-RANDOM: each pending op lost / applied / 512-aligned prefix

type PendingOp =
  | { kind: 'write'; position: number; data: Uint8Array; torn: boolean }
  | { kind: 'truncate'; size: number };

class Bytes {
  buf: Uint8Array;
  size: number;
  constructor(init?: Uint8Array) {
    this.buf = new Uint8Array(Math.max(64, init?.length ?? 0));
    this.size = 0;
    if (init) {
      this.buf.set(init);
      this.size = init.length;
    }
  }
  clone(): Bytes {
    return new Bytes(this.view());
  }
  view(): Uint8Array {
    return this.buf.subarray(0, this.size);
  }
  write(src: Uint8Array, position: number): void {
    const end = position + src.length;
    if (end > this.buf.length) {
      const next = new Uint8Array(Math.max(end, this.buf.length * 2));
      next.set(this.view());
      this.buf = next;
    }
    if (position > this.size) this.buf.fill(0, this.size, position);
    this.buf.set(src, position);
    if (end > this.size) this.size = end;
  }
  truncate(size: number): void {
    if (size < this.size) {
      this.buf.fill(0, size, this.size);
      this.size = size;
    } else if (size > this.size) {
      this.write(new Uint8Array(size - this.size), this.size);
    }
  }
  read(dst: Uint8Array, position: number): number {
    if (position >= this.size) return 0;
    const n = Math.min(dst.length, this.size - position);
    dst.set(this.buf.subarray(position, position + n));
    return n;
  }
}

interface MemFile {
  current: Bytes;
  durable: Bytes;
  pending: PendingOp[];
  dirSynced: boolean;
}

function applyOp(target: Bytes, op: PendingOp): void {
  if (op.kind === 'write') target.write(op.data, op.position);
  else target.truncate(op.size);
}

class MemoryFile implements StorageFile {
  private closed = false;
  constructor(
    readonly path: string,
    private readonly file: MemFile,
  ) {}
  private check(): void {
    if (this.closed) throw new InternalError('INVARIANT_VIOLATION', `file used after close: ${this.path}`);
  }
  size(): number {
    this.check();
    return this.file.current.size;
  }
  read(dst: Uint8Array, position: number): number {
    this.check();
    return this.file.current.read(dst, position);
  }
  write(src: Uint8Array, position: number): void {
    this.check();
    const data = Uint8Array.from(src);
    this.file.current.write(data, position);
    this.file.pending.push({ kind: 'write', position, data, torn: false });
  }
  /** Applies only the first `n` bytes of a write and records it as torn (used by FaultVfs). */
  writeTorn(src: Uint8Array, position: number, n: number): void {
    this.check();
    const data = Uint8Array.from(src.subarray(0, n));
    this.file.current.write(data, position);
    this.file.pending.push({ kind: 'write', position, data, torn: true });
  }
  sync(): void {
    this.check();
    this.file.durable = this.file.current.clone();
    this.file.pending = [];
  }
  truncate(size: number): void {
    this.check();
    this.file.current.truncate(size);
    this.file.pending.push({ kind: 'truncate', size });
  }
  close(): void {
    this.closed = true;
  }
}

export class MemoryVfs implements Vfs {
  private readonly files = new Map<string, MemFile>();
  private readonly locks = new Set<string>();

  exists(path: string): boolean {
    return this.files.has(path);
  }

  open(path: string): MemoryFile {
    let f = this.files.get(path);
    if (!f) {
      f = { current: new Bytes(), durable: new Bytes(), pending: [], dirSynced: false };
      this.files.set(path, f);
    }
    return new MemoryFile(path, f);
  }

  syncDir(dirPath: string): boolean {
    for (const [p, f] of this.files) if (dirname(p) === dirPath) f.dirSynced = true;
    return true;
  }

  acquireLock(dbPath: string): LockHandle {
    if (this.locks.has(dbPath)) throw new StorageError('DB_LOCKED', `database is locked: ${dbPath}`);
    this.locks.add(dbPath);
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.locks.delete(dbPath);
        }
      },
    };
  }

  /** Current bytes of a file (for tests and corruption injection). */
  fileBytes(path: string): Uint8Array {
    const f = this.files.get(path);
    if (!f) throw new InternalError('INVARIANT_VIOLATION', `no such file: ${path}`);
    return Uint8Array.from(f.current.view());
  }

  /** Replaces a file's content as if durably written (test helper for corruption). */
  setFileBytes(path: string, bytes: Uint8Array): void {
    const b = new Bytes(Uint8Array.from(bytes));
    this.files.set(path, { current: b, durable: b.clone(), pending: [], dirSynced: true });
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** The disk a crash would leave behind, as a fresh VFS with no locks (the process died). */
  crashImage(policy: CrashPolicy, rng?: Rng): MemoryVfs {
    if (policy === 'random-subset' && !rng) throw new InternalError('INVARIANT_VIOLATION', 'random-subset needs an rng');
    const out = new MemoryVfs();
    for (const path of this.paths()) {
      const f = this.files.get(path) as MemFile;
      let image: Bytes;
      switch (policy) {
        case 'durable-only':
          if (!f.dirSynced) continue;
          image = f.durable.clone();
          break;
        case 'all-pending':
          image = f.current.clone();
          break;
        case 'torn-only':
          image = f.durable.clone();
          for (const op of f.pending) if (op.kind === 'write' && op.torn) applyOp(image, op);
          break;
        case 'random-subset': {
          const r = rng as Rng;
          if (!f.dirSynced && r.chance(0.5)) continue;
          image = f.durable.clone();
          for (const op of f.pending) {
            if (op.kind === 'truncate') {
              if (r.chance(0.5)) applyOp(image, op);
              continue;
            }
            const choice = r.nextInt(0, 2);
            if (choice === 1) applyOp(image, op);
            else if (choice === 2) {
              const sectors = Math.floor(op.data.length / 512);
              const keep = 512 * r.nextInt(0, sectors);
              if (keep > 0) applyOp(image, { ...op, data: op.data.subarray(0, keep) });
            }
          }
          break;
        }
      }
      out.files.set(path, { current: image, durable: image.clone(), pending: [], dirSynced: true });
    }
    return out;
  }
}

export type { MemoryFile };
