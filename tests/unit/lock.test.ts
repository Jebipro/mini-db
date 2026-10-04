import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StorageError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { NodeVfs } from '../../src/storage/node-vfs.js';
import { useTmpDir } from '../support/tmp.js';

const tmp = useTmpDir();

function expectLocked(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).code).toBe('DB_LOCKED');
}

describe('lock', () => {
  it('T-LOCK-001 double acquire of the same path in one process is refused (any spelling)', () => {
    const dir = tmp();
    const vfs = new NodeVfs();
    const path = join(dir, 'a.db');
    const h = vfs.acquireLock(path);
    expect(readFileSync(`${path}-lock`, 'utf8')).toBe(`${process.pid}\n`);
    expectLocked(() => vfs.acquireLock(path));
    expectLocked(() => vfs.acquireLock(join(dir, '.', 'a.db')));
    h.release();

    const mem = new MemoryVfs();
    const m = mem.acquireLock('x.db');
    expectLocked(() => mem.acquireLock('x.db'));
    m.release();
    mem.acquireLock('x.db').release();
  });

  it('T-LOCK-002 a lock file holding the pid of an exited process is treated as stale', () => {
    const dir = tmp();
    const path = join(dir, 'b.db');
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(child.status).toBe(0);
    expect(typeof child.pid).toBe('number');
    writeFileSync(`${path}-lock`, `${child.pid}\n`);
    const h = new NodeVfs().acquireLock(path);
    expect(readFileSync(`${path}-lock`, 'utf8')).toBe(`${process.pid}\n`);
    h.release();
    expect(existsSync(`${path}-lock`)).toBe(false);
  });

  it('T-LOCK-003 a lock held by a live process is refused (process.kill(pid, 0) works on this platform)', async () => {
    const dir = tmp();
    const path = join(dir, 'c.db');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      expect(typeof child.pid).toBe('number');
      writeFileSync(`${path}-lock`, `${child.pid}\n`);
      expectLocked(() => new NodeVfs().acquireLock(path));
      expect(readFileSync(`${path}-lock`, 'utf8')).toBe(`${child.pid}\n`);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  });

  it('T-LOCK-004 release allows re-acquire; an unparsable lock file is treated as locked', () => {
    const dir = tmp();
    const vfs = new NodeVfs();
    const path = join(dir, 'd.db');
    vfs.acquireLock(path).release();
    const h = vfs.acquireLock(path);
    h.release();
    h.release(); // idempotent
    writeFileSync(`${path}-lock`, 'garbage');
    expectLocked(() => vfs.acquireLock(path));
    writeFileSync(`${path}-lock`, '');
    expectLocked(() => vfs.acquireLock(path));
  });
});
