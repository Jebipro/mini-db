import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { FaultVfs, SimulatedCrash } from '../../src/storage/fault-vfs.js';
import type { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { createRng } from '../../src/util/prng.js';
import { deterministicEntropy } from '../support/db.js';
import { checkSqlCrashCase, dumpDb, randomWorkload, sqlCrashCases, sqlCrashImage, traceOfSql, workloads, type SqlCrashCase } from '../support/sql-crash.js';
import { policySpecs } from '../support/page-crash.js';
import { openPager } from '../support/pager-harness.js';
import {
  buildPW1,
  checkCrashCase,
  crashCases,
  crashImageFor,
  initializeHook,
  stateMatches,
  traceOf,
  type PageState,
} from '../support/page-crash.js';

const policyFilter = process.env.CRASH_POLICY;
const workloadFilter = process.env.CRASH_WORKLOAD;

describe('crash matrix (long)', () => {
  const w = buildPW1();
  const trace = traceOf(w);

  it('T-CRASH-P01 full page-level crash matrix: PW1 × every op × every policy', () => {
    const cases = crashCases(trace, true).filter((c) => !policyFilter || c.spec.label.startsWith(policyFilter));
    for (const c of cases) checkCrashCase(w, c);
    console.log(`T-CRASH-P01: ${cases.length} crash cases over ${trace.length} ops`);
  });

  it('T-CRASH-P02 crashing again during recovery converges to the single-recovery state', () => {
    // crash images whose WAL still holds frames: crash right after each commit fsync (P-DURABLE)
    const cases = crashCases(trace, true).filter((c) => c.spec.policy === 'durable-only' || c.spec.policy === 'all-pending');
    let recoveries = 0;
    for (const c of cases) {
      const { image, result } = crashImageFor(w, c);
      const walBytes = image.exists('db-wal') ? image.fileBytes('db-wal').length : 0;
      if (walBytes <= 48) continue;
      // reference: single clean recovery
      const ref = image.crashImage('all-pending');
      const p0 = openPager(ref, 'db', { ...w.options, initialize: initializeHook });
      const allowed = [result.acked, ...(result.inFlight ? [result.acked + 1] : [])];
      const k = allowed.find((i) => stateMatches(p0, w.states[i] as PageState));
      expect(k, `op ${c.op} ${c.spec.label}`).toBeDefined();
      p0.close();
      // count recovery ops, then crash at each of them
      const probe = new FaultVfs(image.crashImage('all-pending'));
      openPager(probe, 'db', { ...w.options, initialize: initializeHook }).close();
      for (let j = 1; j <= probe.opCount; j++) {
        for (const policy of ['durable-only', 'all-pending'] as const) {
          const base = image.crashImage('all-pending');
          expect(() => openPager(new FaultVfs(base, { crashAtOp: j }), 'db', { ...w.options, initialize: initializeHook }).close()).toThrow(
            SimulatedCrash,
          );
          const again = base.crashImage(policy);
          const p = openPager(again, 'db', { ...w.options, initialize: initializeHook });
          expect(stateMatches(p, w.states[k as number] as PageState), `op ${c.op} ${c.spec.label} recovery-op ${j} ${policy}`).toBe(true);
          p.close();
          recoveries++;
        }
      }
    }
    expect(recoveries).toBeGreaterThan(0);
    console.log(`T-CRASH-P02: ${recoveries} recovery crashes`);
  });

  it('T-CRASH-001 SQL crash matrix: CW1–CW5 × every op × every policy', () => {
    let total = 0;
    for (const w of workloads()) {
      if (workloadFilter && w.name !== workloadFilter) continue;
      const cases = sqlCrashCases(traceOfSql(w), true).filter((c) => !policyFilter || c.spec.label.startsWith(policyFilter));
      for (const c of cases) checkSqlCrashCase(w, c);
      total += cases.length;
      console.log(`T-CRASH-001 ${w.name}: ${cases.length} cases`);
    }
    expect(total).toBeGreaterThan(1000);
  });

  it('T-CRASH-002 CW6: crashing again during SQL-level recovery converges to the single-recovery state', () => {
    let recoveries = 0;
    for (const w of workloads().filter((x) => x.name === 'CW4' || x.name === 'CW5')) {
      const trace = traceOfSql(w);
      const cases: SqlCrashCase[] = trace
        .filter((_, i) => i % 3 === 0)
        .map((rec) => ({ op: rec.seq, spec: { policy: 'all-pending' as const, label: 'P-ALL' } }));
      for (const c of cases) {
        const { image } = sqlCrashImage(w, c);
        if (!image.exists('crash.db-wal') || image.fileBytes('crash.db-wal').length <= 48) continue;
        const reference = checkSqlCrashCase(w, c);
        const probe = new FaultVfs(image.crashImage('all-pending'));
        Database.open('crash.db', { vfs: probe, entropy: deterministicEntropy(1), ...w.options }).close();
        for (let j = 1; j <= probe.opCount; j++) {
          for (const policy of ['durable-only', 'all-pending'] as const) {
            const base = image.crashImage('all-pending');
            expect(() => Database.open('crash.db', { vfs: new FaultVfs(base, { crashAtOp: j }), entropy: deterministicEntropy(1), ...w.options }).close()).toThrow(SimulatedCrash);
            const db = Database.open('crash.db', { vfs: base.crashImage(policy), entropy: deterministicEntropy(1), ...w.options });
            expect(db.integrityCheck().issues).toEqual([]);
            expect(dumpDb(db), `${w.name} op ${c.op} recovery-op ${j} ${policy}`).toBe(reference);
            db.close();
            recoveries++;
          }
        }
      }
    }
    expect(recoveries).toBeGreaterThan(0);
    console.log(`T-CRASH-002 (SQL): ${recoveries} recovery crashes`);
  });

  it('T-CRASH-006 recovery re-crash under torn writes, random subsets and double crashes (CW4, CW5)', () => {
    // Deterministic subset of the independent review's REVIEW-CR-001. Scale with CRASH_RECOVERY_STRIDE (default 4,
    // smaller = more crash images) and CRASH_RECOVERY_SEEDS (P-RANDOM seeds per recovery op, default 1).
    const stride = Number(process.env.CRASH_RECOVERY_STRIDE ?? 4);
    const seeds = Array.from({ length: Number(process.env.CRASH_RECOVERY_SEEDS ?? 1) }, (_, i) => i + 1);
    let recoveries = 0;
    let doubles = 0;
    for (const w of workloads().filter((x) => x.name === 'CW4' || x.name === 'CW5')) {
      const open = (vfs: MemoryVfs | FaultVfs): Database => Database.open('crash.db', { vfs, entropy: deterministicEntropy(1), ...w.options });
      for (const rec of traceOfSql(w).filter((_, i) => i % stride === 1)) {
        const c: SqlCrashCase = { op: rec.seq, spec: { policy: 'all-pending', label: 'P-ALL' } };
        const { image } = sqlCrashImage(w, c);
        if (!image.exists('crash.db-wal') || image.fileBytes('crash.db-wal').length <= 48) continue;
        const reference = checkSqlCrashCase(w, c);
        const probe = new FaultVfs(image.crashImage('all-pending'));
        open(probe).close();
        for (const op of probe.opLog) {
          const variants: Array<{ policy: 'torn-only' | 'random-subset'; torn?: number; seed?: number }> = [
            ...(op.kind === 'write' ? [1, 2048].filter((t) => t < (op.length ?? 0)).map((torn) => ({ policy: 'torn-only' as const, torn })) : []),
            ...seeds.map((seed) => ({ policy: 'random-subset' as const, seed })),
          ];
          for (const v of variants) {
            const ctx = `${w.name} op ${c.op} recovery-op ${op.seq} (${op.kind} ${op.file}) ${v.policy}${v.torn ?? ''}${v.seed ?? ''}`;
            const base = image.crashImage('all-pending');
            const plan = v.torn === undefined ? { crashAtOp: op.seq } : { crashAtOp: op.seq, tornBytes: v.torn };
            expect(() => open(new FaultVfs(base, plan)).close(), ctx).toThrow(SimulatedCrash);
            const after = base.crashImage(v.policy, v.seed === undefined ? undefined : createRng(v.seed * 31 + op.seq));
            if (op.seq % 5 === 0) {
              // double crash: the recovery of the crashed recovery crashes too, then a clean recovery must converge
              const probe2 = new FaultVfs(after.crashImage('all-pending'));
              open(probe2).close();
              if (probe2.opCount > 0) {
                const base2 = after.crashImage('all-pending');
                expect(() => open(new FaultVfs(base2, { crashAtOp: 1 + (op.seq % probe2.opCount) })).close(), ctx).toThrow(SimulatedCrash);
                const db2 = open(base2.crashImage('durable-only'));
                expect(db2.integrityCheck().issues, `${ctx} (double)`).toEqual([]);
                expect(dumpDb(db2), `${ctx} (double)`).toBe(reference);
                db2.close();
                doubles++;
              }
            }
            const db = open(after);
            expect(db.integrityCheck().issues, ctx).toEqual([]);
            expect(dumpDb(db), ctx).toBe(reference);
            db.close();
            recoveries++;
          }
        }
      }
    }
    expect(recoveries).toBeGreaterThan(100);
    expect(doubles).toBeGreaterThan(10);
    console.log(`T-CRASH-006: ${recoveries} torn/random recovery crashes, ${doubles} double crashes`);
  });

  it('T-CRASH-005 random workloads with random crash points and policies', () => {
    const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.SEEDS ?? 40) }, (_, i) => i + 1);
    const specs = policySpecs(true);
    for (const seed of seeds) {
      const w = randomWorkload(seed, 120);
      const trace = traceOfSql(w);
      const r = createRng(seed);
      for (let k = 0; k < 5; k++) {
        const rec = r.pick(trace);
        let spec = r.pick(specs);
        if (spec.policy === 'torn-only') {
          if (rec.kind !== 'write' || (rec.length ?? 0) < 2) spec = specs[0] as typeof spec;
          else spec = { ...spec, tornBytes: r.nextInt(1, (rec.length as number) - 1) };
        }
        checkSqlCrashCase(w, { op: rec.seq, spec });
      }
    }
  });
});
