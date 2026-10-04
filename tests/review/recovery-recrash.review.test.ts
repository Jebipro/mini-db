import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { FaultVfs, SimulatedCrash } from '../../src/storage/fault-vfs.js';
import type { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { createRng } from '../../src/util/prng.js';
import { deterministicEntropy } from '../support/db.js';
import { checkSqlCrashCase, dumpDb, randomWorkload, sqlCrashImage, traceOfSql, workloads, type SqlWorkload } from '../support/sql-crash.js';

/**
 * REVIEW-CR-001: CW6 (T-CRASH-002) re-crashes recovery only under P-DURABLE and P-ALL. Here every recovery op
 * is crashed again under torn writes (several prefixes) and random subsets of unsynced ops, and a third
 * recovery must converge to the single-recovery reference state with a clean integrity check. Also crashes
 * twice in a row (recovery of a recovery that itself crashed).
 */

function open(vfs: MemoryVfs | FaultVfs, w: SqlWorkload): Database {
  return Database.open('crash.db', { vfs, entropy: deterministicEntropy(1), ...w.options });
}

function walFramesOf(image: MemoryVfs): number {
  return image.exists('crash.db-wal') ? image.fileBytes('crash.db-wal').length : 0;
}

describe('REVIEW-CR-001 crash during recovery under torn / random policies', () => {
  it('CW3, CW4, CW5 and two random workloads', () => {
    const ws = [...workloads().filter((x) => ['CW3', 'CW4', 'CW5'].includes(x.name)), randomWorkload(7, 80), randomWorkload(11, 80)];
    let recoveries = 0;
    let doubles = 0;
    for (const w of ws) {
      const trace = traceOfSql(w);
      for (const rec of trace.filter((_, i) => i % 4 === 1)) {
        const c = { op: rec.seq, spec: { policy: 'all-pending' as const, label: 'P-ALL' } };
        const { image } = sqlCrashImage(w, c);
        if (walFramesOf(image) <= 48) continue;
        const reference = checkSqlCrashCase(w, c);
        const probe = new FaultVfs(image.crashImage('all-pending'));
        open(probe, w).close();
        const log = probe.opLog;
        for (const op of log) {
          const variants: Array<{ torn?: number; policy: 'torn-only' | 'random-subset'; seed?: number }> = [
            ...(op.kind === 'write' ? [1, 100, 2048].filter((t) => t < (op.length ?? 0)).map((t) => ({ torn: t, policy: 'torn-only' as const })) : []),
            { policy: 'random-subset', seed: 1 },
            { policy: 'random-subset', seed: 2 },
          ];
          for (const v of variants) {
            const base = image.crashImage('all-pending');
            const plan = v.torn === undefined ? { crashAtOp: op.seq } : { crashAtOp: op.seq, tornBytes: v.torn };
            expect(() => open(new FaultVfs(base, plan), w).close()).toThrow(SimulatedCrash);
            const after = base.crashImage(v.policy, v.seed === undefined ? undefined : createRng(v.seed * 31 + op.seq));
            const ctx = `${w.name} op ${c.op} recovery-op ${op.seq} (${op.kind} ${op.file}) ${v.policy}${v.torn ?? ''}${v.seed ?? ''}`;
            // second-level crash: crash the next recovery at a random op too, then recover cleanly
            const probe2 = new FaultVfs(after.crashImage('all-pending'));
            open(probe2, w).close();
            if (op.seq % 5 === 0 && probe2.opCount > 0) {
              const j = 1 + (op.seq % Math.max(1, probe2.opCount));
              const base2 = after.crashImage('all-pending');
              expect(() => open(new FaultVfs(base2, { crashAtOp: j }), w).close()).toThrow(SimulatedCrash);
              const after2 = base2.crashImage('durable-only');
              const db2 = open(after2, w);
              expect(db2.integrityCheck().issues, ctx + ' (double)').toEqual([]);
              expect(dumpDb(db2), ctx + ' (double)').toBe(reference);
              db2.close();
              doubles++;
            }
            const db = open(after, w);
            expect(db.integrityCheck().issues, ctx).toEqual([]);
            expect(dumpDb(db), ctx).toBe(reference);
            db.close();
            recoveries++;
          }
        }
      }
    }
    console.log(`REVIEW-CR-001: ${recoveries} torn/random recovery crashes, ${doubles} double crashes`);
    expect(recoveries).toBeGreaterThan(100);
  });
});
