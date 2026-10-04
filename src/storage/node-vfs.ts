import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { StorageError } from '../errors/errors.js';
import { lockPathOf, type LockHandle, type StorageFile, type Vfs } from './vfs.js';

/**
 * Node fs implementation with synchronous fd APIs (DC-03). This is the only module that imports node:fs
 * (besides the CLI), enforced by T-ARCH-001.
 */

function ioError(op: string, path: string, e: unknown): StorageError {
  const code = (e as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';
  return new StorageError('IO_ERROR', `${op} failed for ${path}: ${code}`, { cause: e });
}

class NodeFile implements StorageFile {
  private fd: number | null;
  constructor(
    readonly path: string,
    fd: number,
  ) {
    this.fd = fd;
  }
  private handle(): number {
    if (this.fd === null) throw new StorageError('IO_ERROR', `file is closed: ${this.path}`);
    return this.fd;
  }
  size(): number {
    try {
      return fs.fstatSync(this.handle()).size;
    } catch (e) {
      throw ioError('fstat', this.path, e);
    }
  }
  read(dst: Uint8Array, position: number): number {
    let done = 0;
    try {
      while (done < dst.length) {
        const n = fs.readSync(this.handle(), dst, done, dst.length - done, position + done);
        if (n === 0) break;
        done += n;
      }
    } catch (e) {
      throw ioError('read', this.path, e);
    }
    return done;
  }
  write(src: Uint8Array, position: number): void {
    let done = 0;
    try {
      while (done < src.length) {
        done += fs.writeSync(this.handle(), src, done, src.length - done, position + done);
      }
    } catch (e) {
      throw ioError('write', this.path, e);
    }
  }
  sync(): void {
    try {
      fs.fsyncSync(this.handle());
    } catch (e) {
      throw ioError('fsync', this.path, e);
    }
  }
  truncate(size: number): void {
    try {
      fs.ftruncateSync(this.handle(), size);
    } catch (e) {
      throw ioError('truncate', this.path, e);
    }
  }
  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      fs.closeSync(fd);
    } catch (e) {
      throw ioError('close', this.path, e);
    }
  }
}

/** Paths locked by this process (G.15 step 1). */
const registry = new Set<string>();

function registryKey(dbPath: string): string {
  const abs = resolve(dbPath);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** true when a process with this pid exists (or we cannot tell: EPERM). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class NodeVfs implements Vfs {
  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  open(path: string): StorageFile {
    try {
      let fd: number;
      try {
        fd = fs.openSync(path, 'r+');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        fd = fs.openSync(path, 'w+');
      }
      return new NodeFile(path, fd);
    } catch (e) {
      throw ioError('open', path, e);
    }
  }

  syncDir(dirPath: string): boolean {
    // DC-53: Node cannot fsync a directory handle on Windows.
    if (process.platform === 'win32') return false;
    let fd: number | undefined;
    try {
      fd = fs.openSync(dirPath, 'r');
      fs.fsyncSync(fd);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR' || code === 'EPERM') return false;
      throw ioError('fsync(dir)', dirPath, e);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  acquireLock(dbPath: string): LockHandle {
    const key = registryKey(dbPath);
    if (registry.has(key)) throw new StorageError('DB_LOCKED', `database is already open in this process: ${dbPath}`);
    const lockPath = lockPathOf(dbPath);
    const tryCreate = (): boolean => {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, `${process.pid}\n`);
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw ioError('create lock', lockPath, e);
      }
    };
    const locked = (why: string): StorageError =>
      new StorageError('DB_LOCKED', `database is locked (${why}); if no process uses it, delete ${lockPath}`);

    if (!tryCreate()) {
      let text: string;
      try {
        text = fs.readFileSync(lockPath, 'utf8');
      } catch {
        throw locked('lock file unreadable');
      }
      const m = /^(\d+)\n?$/.exec(text);
      if (!m) throw locked('lock file unparsable');
      const pid = Number(m[1]);
      if (pid === process.pid) throw locked(`held by this process, pid ${pid}`);
      if (processAlive(pid)) throw locked(`held by pid ${pid}`);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        throw locked('stale lock could not be removed');
      }
      if (!tryCreate()) throw locked('lock re-created concurrently');
    }
    registry.add(key);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        registry.delete(key);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // DC-52: failure to delete is ignored; a later open treats our dead pid as stale
        }
      },
    };
  }
}
