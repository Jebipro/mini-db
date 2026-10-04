import { StorageError } from '../errors/errors.js';
import type { MemoryFile, MemoryVfs } from './memory-vfs.js';
import type { LockHandle, StorageFile, Vfs } from './vfs.js';

/**
 * Fault-injecting VFS for crash testing (J.5). Every mutating operation (write, sync, truncate, syncDir)
 * gets a global sequence number starting at 1.
 * - crashAtOp = k: operation k throws SimulatedCrash (a write first applies `tornBytes` bytes);
 *   from then on every call throws SimulatedCrash except close().
 * - failAtOp = k: operation k throws StorageError IO_ERROR without effect; later operations proceed.
 * After a crash, `base.crashImage(policy)` yields the post-crash disk.
 */
export class SimulatedCrash extends Error {
  constructor(readonly op: number) {
    super(`simulated crash at op ${op}`);
    this.name = 'SimulatedCrash';
  }
}

export interface FaultPlan {
  crashAtOp?: number;
  tornBytes?: number;
  failAtOp?: number;
  /** Also fail reads: the n-th read call (1-based, counted separately) throws IO_ERROR. */
  failReadAt?: number;
}

export type OpKind = 'write' | 'sync' | 'truncate' | 'syncDir';
export interface OpRecord {
  seq: number;
  kind: OpKind;
  file: string;
  position?: number;
  length?: number;
}

export class FaultVfs implements Vfs {
  private seq = 0;
  private reads = 0;
  private _crashed = false;
  readonly opLog: OpRecord[] = [];

  constructor(
    readonly base: MemoryVfs,
    readonly plan: FaultPlan = {},
  ) {}

  get crashed(): boolean {
    return this._crashed;
  }

  get opCount(): number {
    return this.seq;
  }

  /** Number of read/size calls so far (for failReadAt). */
  get readCount(): number {
    return this.reads;
  }

  private guard(): void {
    if (this._crashed) throw new SimulatedCrash(this.seq);
  }

  /** Accounts one mutating op; returns 'crash' | 'fail' | 'ok'. */
  private next(rec: Omit<OpRecord, 'seq'>): 'crash' | 'fail' | 'ok' {
    this.guard();
    this.seq++;
    this.opLog.push({ seq: this.seq, ...rec });
    if (this.plan.crashAtOp === this.seq) return 'crash';
    if (this.plan.failAtOp === this.seq) return 'fail';
    return 'ok';
  }

  crash(): never {
    this._crashed = true;
    throw new SimulatedCrash(this.seq);
  }

  noteRead(): void {
    this.guard();
    this.reads++;
    if (this.plan.failReadAt === this.reads) throw new StorageError('IO_ERROR', `injected read failure (read ${this.reads})`);
  }

  step(rec: Omit<OpRecord, 'seq'>, onCrash?: () => void): void {
    const r = this.next(rec);
    if (r === 'crash') {
      onCrash?.();
      this.crash();
    }
    if (r === 'fail') throw new StorageError('IO_ERROR', `injected I/O failure at op ${this.seq} (${rec.kind} ${rec.file})`);
  }

  exists(path: string): boolean {
    this.guard();
    return this.base.exists(path);
  }

  open(path: string): StorageFile {
    this.guard();
    return new FaultFile(this, this.base.open(path));
  }

  syncDir(dirPath: string): boolean {
    this.step({ kind: 'syncDir', file: dirPath });
    return this.base.syncDir(dirPath);
  }

  acquireLock(dbPath: string): LockHandle {
    this.guard();
    const h = this.base.acquireLock(dbPath);
    return { release: () => h.release() };
  }
}

class FaultFile implements StorageFile {
  constructor(
    private readonly vfs: FaultVfs,
    private readonly inner: MemoryFile,
  ) {}
  get path(): string {
    return this.inner.path;
  }
  size(): number {
    this.vfs.noteRead();
    return this.inner.size();
  }
  read(dst: Uint8Array, position: number): number {
    this.vfs.noteRead();
    return this.inner.read(dst, position);
  }
  write(src: Uint8Array, position: number): void {
    const torn = this.vfs.plan.tornBytes ?? 0;
    this.vfs.step({ kind: 'write', file: this.path, position, length: src.length }, () => {
      if (torn > 0) this.inner.writeTorn(src, position, Math.min(torn, src.length));
    });
    this.inner.write(src, position);
  }
  sync(): void {
    this.vfs.step({ kind: 'sync', file: this.path });
    this.inner.sync();
  }
  truncate(size: number): void {
    this.vfs.step({ kind: 'truncate', file: this.path, length: size });
    this.inner.truncate(size);
  }
  close(): void {
    this.inner.close();
  }
}
