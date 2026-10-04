import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StorageError } from '../../src/errors/errors.js';
import { FaultVfs, SimulatedCrash } from '../../src/storage/fault-vfs.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { NodeVfs } from '../../src/storage/node-vfs.js';
import type { StorageFile } from '../../src/storage/vfs.js';
import { createRng } from '../../src/util/prng.js';
import { useTmpDir } from '../support/tmp.js';

const tmp = useTmpDir();

function readAll(f: StorageFile): Uint8Array {
  const out = new Uint8Array(f.size());
  f.read(out, 0);
  return out;
}

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);

describe('vfs', () => {
  it('T-VFS-001 MemoryVfs and NodeVfs agree on random operation sequences', () => {
    const dir = tmp();
    for (const seed of [1, 2, 3]) {
      const r = createRng(seed);
      const mem = new MemoryVfs().open('x');
      const node = new NodeVfs().open(join(dir, `x${seed}`));
      for (let i = 0; i < 300; i++) {
        const op = r.nextInt(0, 3);
        if (op === 0) {
          const pos = r.nextInt(0, 9000);
          const data = r.bytes(r.nextInt(0, 700));
          mem.write(data, pos);
          node.write(data, pos);
        } else if (op === 1) {
          const size = r.nextInt(0, 9000);
          mem.truncate(size);
          node.truncate(size);
        } else if (op === 2) {
          const pos = r.nextInt(0, 10000);
          const a = new Uint8Array(r.nextInt(0, 600));
          const b = new Uint8Array(a.length);
          expect(mem.read(a, pos)).toBe(node.read(b, pos));
          expect(a).toEqual(b);
        } else {
          mem.sync();
          node.sync();
        }
        expect(mem.size()).toBe(node.size());
      }
      expect(readAll(mem)).toEqual(readAll(node));
      node.close();
    }
  });

  it('T-VFS-002 short read at EOF, zero-filled gap when writing past the end', () => {
    for (const f of [new MemoryVfs().open('a'), new NodeVfs().open(join(tmp(), 'a'))]) {
      f.write(bytes(1, 2, 3), 0);
      const buf = new Uint8Array(10).fill(9);
      expect(f.read(buf, 1)).toBe(2);
      expect(buf.subarray(0, 2)).toEqual(bytes(2, 3));
      expect(f.read(buf, 50)).toBe(0);
      f.write(bytes(7), 6);
      expect(readAll(f)).toEqual(bytes(1, 2, 3, 0, 0, 0, 7));
      f.close();
    }
  });

  it('T-VFS-003 crashAtOp throws SimulatedCrash at op k and on every later call', () => {
    const fv = new FaultVfs(new MemoryVfs(), { crashAtOp: 3 });
    const f = fv.open('db');
    f.write(bytes(1), 0); // op 1
    f.sync(); // op 2
    expect(() => f.write(bytes(2), 1)).toThrow(SimulatedCrash); // op 3
    expect(fv.crashed).toBe(true);
    expect(() => f.sync()).toThrow(SimulatedCrash);
    expect(() => f.read(new Uint8Array(1), 0)).toThrow(SimulatedCrash);
    expect(() => fv.open('other')).toThrow(SimulatedCrash);
    expect(() => f.close()).not.toThrow();
    expect(fv.opLog.map((o) => o.kind)).toEqual(['write', 'sync', 'write']);
  });

  it('T-VFS-004 durable-only keeps synced state and drops unsynced writes/truncates', () => {
    const vfs = new MemoryVfs();
    const f = vfs.open('db');
    vfs.syncDir('.');
    f.write(bytes(1, 2, 3, 4), 0);
    f.sync();
    f.write(bytes(9, 9), 0);
    f.truncate(1);
    const img = vfs.crashImage('durable-only');
    expect(img.fileBytes('db')).toEqual(bytes(1, 2, 3, 4));
    const all = vfs.crashImage('all-pending');
    expect(all.fileBytes('db')).toEqual(bytes(9));
  });

  it('T-VFS-005 tornBytes applies exactly the prefix of the crashing write', () => {
    const base = new MemoryVfs();
    const fv = new FaultVfs(base, { crashAtOp: 3, tornBytes: 2 });
    const f = fv.open('db');
    fv.syncDir('.'); // op 1
    f.write(bytes(5, 5, 5, 5, 5), 0); // op 2 (unsynced)
    expect(() => f.write(bytes(1, 2, 3, 4), 10)).toThrow(SimulatedCrash); // op 3
    expect(base.crashImage('torn-only').fileBytes('db')).toEqual(new Uint8Array([...new Uint8Array(10), 1, 2]));
    expect(base.crashImage('all-pending').fileBytes('db')).toEqual(Uint8Array.from([5, 5, 5, 5, 5, 0, 0, 0, 0, 0, 1, 2]));
    expect(base.crashImage('durable-only').fileBytes('db')).toEqual(new Uint8Array(0));
  });

  it('T-VFS-006 random-subset is deterministic per seed', () => {
    const base = new MemoryVfs();
    const f = base.open('db');
    base.syncDir('.');
    const r = createRng(5);
    for (let i = 0; i < 40; i++) f.write(r.bytes(1024), i * 1024);
    const a = base.crashImage('random-subset', createRng(11)).fileBytes('db');
    const b = base.crashImage('random-subset', createRng(11)).fileBytes('db');
    const c = base.crashImage('random-subset', createRng(12)).fileBytes('db');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('T-VFS-007 a created file vanishes under durable-only until its directory is synced', () => {
    const vfs = new MemoryVfs();
    const f = vfs.open('d/db');
    f.write(bytes(1), 0);
    f.sync();
    expect(vfs.crashImage('durable-only').exists('d/db')).toBe(false);
    expect(vfs.crashImage('all-pending').exists('d/db')).toBe(true);
    vfs.syncDir('d');
    expect(vfs.crashImage('durable-only').fileBytes('d/db')).toEqual(bytes(1));
  });

  it('T-VFS-008 failAtOp throws IO_ERROR without effect and later ops proceed', () => {
    const base = new MemoryVfs();
    const fv = new FaultVfs(base, { failAtOp: 2 });
    const f = fv.open('db');
    f.write(bytes(1), 0);
    let err: unknown;
    try {
      f.write(bytes(2), 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe('IO_ERROR');
    expect(fv.crashed).toBe(false);
    f.write(bytes(3), 1);
    expect(base.fileBytes('db')).toEqual(bytes(1, 3));
  });
});
