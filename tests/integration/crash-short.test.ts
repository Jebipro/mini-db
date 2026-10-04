import { describe, expect, it } from 'vitest';
import { FaultVfs, SimulatedCrash } from '../../src/storage/fault-vfs.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { createRng } from '../../src/util/prng.js';
import { openPager } from '../support/pager-harness.js';
import {
  buildPW1,
  checkCrashCase,
  crashCases,
  initializeHook,
  policySpecs,
  stateMatches,
  traceOf,
  type Workload,
} from '../support/page-crash.js';

function opString(w: Workload): string {
  return traceOf(w)
    .map((o) => {
      const wal = o.file.endsWith('-wal');
      switch (o.kind) {
        case 'write':
          return wal ? 'W' : 'w';
        case 'sync':
          return wal ? 'S' : 's';
        case 'truncate':
          return wal ? 'T' : 't';
        case 'syncDir':
          return 'D';
      }
      return '?';
    })
    .join('');
}

describe('page-level crash (short)', () => {
  const w = buildPW1();
  const trace = traceOf(w);

  it('T-CRASH-P01 every op of PW1 under P-DURABLE and P-TORN(512) recovers to an allowed state', () => {
    const cases = crashCases(trace, false);
    expect(cases.length).toBeGreaterThan(100);
    for (const c of cases) checkCrashCase(w, c);
  });

  it('T-CRASH-P03 a crash at any point of database creation reopens as a fresh database', () => {
    const creation: Workload = { ...w, steps: [] };
    const ops = traceOf(creation);
    expect(ops.length).toBeGreaterThanOrEqual(10);
    for (const rec of ops) {
      for (const spec of policySpecs(true)) {
        if (spec.policy === 'torn-only' && rec.kind !== 'write') continue;
        const base = new MemoryVfs();
        const plan = spec.tornBytes !== undefined && spec.tornBytes > 0 ? { crashAtOp: rec.seq, tornBytes: Math.min(spec.tornBytes, (rec.length ?? 2) - 1) } : { crashAtOp: rec.seq };
        expect(() => openPager(new FaultVfs(base, plan), 'db', { initialize: initializeHook })).toThrow(SimulatedCrash);
        const img = base.crashImage(spec.policy, createRng(rec.seq));
        const p = openPager(img, 'db', { initialize: initializeHook });
        expect(stateMatches(p, w.states[0] as NonNullable<(typeof w.states)[0]>), `op ${rec.seq} ${spec.label}`).toBe(true);
        p.close();
      }
    }
  });

  it('T-CRASH-004 op trace follows the protocol: commits = W+S, checkpoints = w+ s T S W S', () => {
    const s = opString(w);
    // creation: [D] reset(TSWS) bootstrap-commit(W+S) checkpoint(w+sTSWS); then commits / checkpoints; close checkpoint
    expect(s).toMatch(/^D?TSWS(W+S|w+sTSWS)*$/);
    expect(s.match(/w+sTSWS/g)?.length ?? 0).toBeGreaterThanOrEqual(4); // bootstrap, 2 explicit, auto, close
    // no data-file write outside a checkpoint/recovery (I16)
    expect(s.replace(/w+sTSWS/g, '')).not.toMatch(/[ws]/);
  });
});
