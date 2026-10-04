import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { CorruptionError, MiniDbError } from '../../src/errors/errors.js';
import { PAGE_SIZE, PageType } from '../../src/storage/layout.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { createRng } from '../../src/util/prng.js';
import { deterministicEntropy } from '../support/db.js';
import { dumpDb, runSqlWorkload, workloads } from '../support/sql-crash.js';

function open(vfs: MemoryVfs, opts: { walAutoCheckpointFrames?: number } = {}): Database {
  return Database.open('crash.db', { vfs, entropy: deterministicEntropy(1), ...opts });
}

/** Opens and reads everything; returns 'detected' when a CorruptionError (or PAGE_CORRUPT issue) appeared. */
function readEverything(vfs: MemoryVfs): { outcome: 'detected' | 'clean'; dump?: string; code?: string } {
  let db: Database | undefined;
  try {
    db = open(vfs);
    const dump = dumpDb(db);
    const report = db.integrityCheck();
    if (!report.ok) return { outcome: 'detected', code: report.issues[0]?.code };
    return { outcome: 'clean', dump };
  } catch (e) {
    if (!(e instanceof MiniDbError)) throw new Error(`non-MiniDb exception: ${String(e)}`, { cause: e });
    if (e instanceof CorruptionError || e.code === 'DB_FAILED') return { outcome: 'detected', code: e.code };
    throw e;
  } finally {
    db?.close();
  }
}

describe('corruption', () => {
  const cw4 = workloads().find((w) => w.name === 'CW4');
  if (!cw4) throw new Error('CW4 missing');

  it('T-CORR-001 a bit flip in any page type is detected (never a crash, never different data)', () => {
    const vfs = new MemoryVfs();
    runSqlWorkload(vfs, cw4);
    // add a FREE page so that type is covered too
    const db = open(vfs);
    db.execute('CREATE TABLE gone (a INTEGER)');
    db.execute('DROP TABLE gone');
    const original = dumpDb(db);
    db.close();
    const bytes = vfs.fileBytes('crash.db');
    const pages = bytes.length / PAGE_SIZE;
    const byType = new Map<number, number[]>();
    for (let p = 0; p < pages; p++) {
      const t = bytes[p * PAGE_SIZE] as number;
      byType.set(t, [...(byType.get(t) ?? []), p]);
    }
    for (const t of [PageType.HEADER, PageType.HEAP, PageType.BTREE_INTERNAL, PageType.BTREE_LEAF, PageType.FREE]) {
      expect(byType.get(t)?.length ?? 0, `page type ${t} present`).toBeGreaterThan(0);
    }
    const r = createRng(42);
    let trials = 0;
    for (const [type, ids] of byType) {
      for (let k = 0; k < 3; k++) {
        const page = r.pick(ids);
        for (let b = 0; b < 5; b++) {
          const off = page * PAGE_SIZE + r.nextInt(0, PAGE_SIZE - 1);
          const bit = 1 << r.nextInt(0, 7);
          const img = vfs.crashImage('all-pending');
          const copy = img.fileBytes('crash.db');
          copy[off] = (copy[off] as number) ^ bit;
          img.setFileBytes('crash.db', copy);
          const res = readEverything(img);
          expect(res.outcome, `type ${type} page ${page} offset ${off % PAGE_SIZE} bit ${bit}`).toBe('detected');
          expect(res.dump ?? original).toBe(original);
          trials++;
        }
      }
    }
    expect(trials).toBeGreaterThanOrEqual(75);
  });

  it('T-CORR-002 WAL: header bit flip → WAL_HEADER_INVALID; frame bit flip → a committed prefix, integrity ok', () => {
    const vfs = new MemoryVfs();
    const db = open(vfs, { walAutoCheckpointFrames: 0 });
    const states = [dumpDb(db)];
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    states.push(dumpDb(db));
    for (let i = 0; i < 3; i++) {
      db.execute(`INSERT INTO t VALUES (${i}, '${'v'.repeat(100)}')`);
      states.push(dumpDb(db));
    }
    const lost = vfs.crashImage('all-pending'); // handle dropped without close: WAL keeps 4 commits
    const wal = lost.fileBytes('crash.db-wal');
    expect(wal.length).toBeGreaterThan(48);
    const r = createRng(7);
    for (let k = 0; k < 10; k++) {
      const img = lost.crashImage('all-pending');
      const w = img.fileBytes('crash.db-wal');
      const off = r.nextInt(0, 47);
      w[off] = (w[off] as number) ^ (1 << r.nextInt(0, 7));
      img.setFileBytes('crash.db-wal', w);
      let err: unknown;
      try {
        open(img).close();
      } catch (e) {
        err = e;
      }
      expect((err as MiniDbError).code, `header offset ${off}`).toBe('WAL_HEADER_INVALID');
    }
    for (let k = 0; k < 40; k++) {
      const img = lost.crashImage('all-pending');
      const w = img.fileBytes('crash.db-wal');
      const off = r.nextInt(48, w.length - 1);
      w[off] = (w[off] as number) ^ (1 << r.nextInt(0, 7));
      img.setFileBytes('crash.db-wal', w);
      const d = open(img);
      expect(d.integrityCheck().issues).toEqual([]);
      expect(states, `frame offset ${off}`).toContain(dumpDb(d));
      d.close();
    }
  });

  it('T-CORR-003 garbage, tiny and truncated files are rejected with NOT_A_DATABASE / FILE_TRUNCATED', () => {
    const r = createRng(3);
    const codeOf = (bytes: Uint8Array): string => {
      const vfs = new MemoryVfs();
      vfs.setFileBytes('crash.db', bytes);
      try {
        open(vfs).close();
      } catch (e) {
        if (e instanceof MiniDbError) return e.code;
        throw e;
      }
      return 'opened';
    };
    expect(codeOf(r.bytes(10_000))).toBe('NOT_A_DATABASE');
    expect(codeOf(r.bytes(1000))).toBe('NOT_A_DATABASE');
    const vfs = new MemoryVfs();
    runSqlWorkload(vfs, cw4);
    const good = vfs.fileBytes('crash.db');
    expect(codeOf(good.subarray(0, good.length - PAGE_SIZE))).toBe('FILE_TRUNCATED');
    expect(codeOf(good.subarray(0, 100))).toBe('NOT_A_DATABASE');
    expect(codeOf(good)).toBe('opened');
  });

  it('T-CORR-004 a WAL with commits from another database is WAL_MISMATCH', () => {
    const a = new MemoryVfs();
    const dbA = Database.open('crash.db', { vfs: a, entropy: deterministicEntropy(5), walAutoCheckpointFrames: 0 });
    dbA.execute('CREATE TABLE t (a INTEGER)');
    const walA = a.crashImage('all-pending').fileBytes('crash.db-wal');
    dbA.close();
    const b = new MemoryVfs();
    open(b).close();
    const img = b.crashImage('all-pending');
    img.setFileBytes('crash.db-wal', walA);
    let err: unknown;
    try {
      open(img).close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CorruptionError);
    expect((err as CorruptionError).code).toBe('WAL_MISMATCH');
  });
});
