import { expect } from 'vitest';
import { FaultVfs, SimulatedCrash, type FaultPlan, type OpRecord } from '../../src/storage/fault-vfs.js';
import { PageType } from '../../src/storage/layout.js';
import { MemoryVfs, type CrashPolicy } from '../../src/storage/memory-vfs.js';
import type { Pager } from '../../src/storage/pager.js';
import type { Vfs } from '../../src/storage/vfs.js';
import { createRng, type Rng } from '../../src/util/prng.js';
import { allocWithPayload, openPager, payloadOf, readPayload, writePayload } from './pager-harness.js';

/**
 * Page-level crash workload PW1 (J.5) and its oracle. The expected states come from a Map model,
 * never from a fault-free run of the pager.
 */

export interface PageState {
  pages: Map<number, number>;
  free: number[];
  pageCount: number;
}

type PageOp = { kind: 'write'; id: number; fill: number } | { kind: 'alloc'; fill: number } | { kind: 'free'; id: number };
type Step =
  | { kind: 'txn'; ops: PageOp[]; outcome: 'commit' | 'rollback' }
  | { kind: 'checkpoint' };

export interface Workload {
  steps: Step[];
  /** states[k] = model after the k-th committed transaction (states[0] = fresh database). */
  states: PageState[];
  options: { walAutoCheckpointFrames: number; cachePages: number };
}

const cloneState = (s: PageState): PageState => ({ pages: new Map(s.pages), free: [...s.free], pageCount: s.pageCount });

/** The database created by PW1 has one extra page allocated by `initialize` (like the catalog head). */
const INITIAL: PageState = { pages: new Map([[1, 0]]), free: [], pageCount: 2 };

export function initializeHook(p: Pager): void {
  const ref = p.allocate(PageType.HEAP);
  p.unpin(ref);
  p.setRootPointer(ref.id);
}

/** PW1: 12 transactions (allocations, frees, rewrites, some rolled back), auto-checkpoint every 5 frames, 2 explicit checkpoints. */
export function buildPW1(seed = 1): Workload {
  const r = createRng(seed);
  const steps: Step[] = [];
  let s = cloneState(INITIAL);
  const states = [cloneState(s)];
  for (let t = 0; t < 12; t++) {
    if (t === 4 || t === 9) steps.push({ kind: 'checkpoint' });
    const work = cloneState(s);
    const ops: PageOp[] = [];
    const n = r.nextInt(1, 4);
    for (let i = 0; i < n; i++) {
      const live = [...work.pages.keys()].filter((id) => id !== 1).sort((a, b) => a - b);
      const x = r.nextFloat();
      if (x < 0.4 && live.length > 0) {
        const id = r.pick(live);
        const fill = r.nextInt(1, 255);
        ops.push({ kind: 'write', id, fill });
        work.pages.set(id, fill);
      } else if (x < 0.8 || live.length === 0) {
        const fill = r.nextInt(1, 255);
        ops.push({ kind: 'alloc', fill });
        const id = work.free.length > 0 ? (work.free.pop() as number) : work.pageCount++;
        work.pages.set(id, fill);
      } else {
        const id = r.pick(live);
        ops.push({ kind: 'free', id });
        work.pages.delete(id);
        work.free.push(id);
      }
    }
    const outcome = t === 3 || t === 7 ? 'rollback' : 'commit';
    steps.push({ kind: 'txn', ops, outcome });
    if (outcome === 'commit') {
      s = work;
      states.push(cloneState(s));
    }
  }
  return { steps, states, options: { walAutoCheckpointFrames: 5, cachePages: 64 } };
}

export interface RunResult {
  acked: number;
  inFlight: boolean;
  crashed: boolean;
}

/** Runs the workload; returns how many commits were acknowledged before a SimulatedCrash (if any). */
export function runWorkload(vfs: Vfs, w: Workload, closeAtEnd = true): RunResult {
  let acked = 0;
  let inFlight = false;
  try {
    const p = openPager(vfs, 'db', { ...w.options, initialize: initializeHook });
    for (const step of w.steps) {
      p.maybeCheckpoint();
      if (step.kind === 'checkpoint') {
        p.checkpoint();
        continue;
      }
      p.beginTxn();
      p.beginStatement();
      for (const op of step.ops) {
        if (op.kind === 'write') writePayload(p, op.id, payloadOf(op.fill));
        else if (op.kind === 'alloc') allocWithPayload(p, payloadOf(op.fill));
        else p.free(op.id);
      }
      p.releaseStatement();
      if (step.outcome === 'rollback') {
        p.rollbackTxn();
        continue;
      }
      inFlight = true;
      p.commitTxn();
      inFlight = false;
      acked++;
    }
    if (closeAtEnd) p.close();
    return { acked, inFlight: false, crashed: false };
  } catch (e) {
    if (e instanceof SimulatedCrash) return { acked, inFlight, crashed: true };
    throw e;
  }
}

/** Reads the page-level state visible through a pager, compared against a candidate model state. */
export function stateMatches(p: Pager, s: PageState): boolean {
  if (p.pageCount !== s.pageCount) return false;
  const free = p.freelistPages();
  if (free.length !== s.free.length || free.some((id, i) => id !== s.free[s.free.length - 1 - i])) return false;
  for (const [id, fill] of s.pages) {
    const got = readPayload(p, id);
    if (got[0] !== (fill & 0xff) || got[got.length - 1] !== (fill & 0xff)) return false;
  }
  return true;
}

export type PolicySpec = { policy: CrashPolicy; tornBytes?: number; seed?: number; label: string };

export function policySpecs(full: boolean): PolicySpec[] {
  if (!full) {
    return [
      { policy: 'durable-only', label: 'P-DURABLE' },
      { policy: 'torn-only', tornBytes: 512, label: 'P-TORN(512)' },
    ];
  }
  return [
    { policy: 'durable-only', label: 'P-DURABLE' },
    { policy: 'all-pending', label: 'P-ALL' },
    ...[1, 511, 512, 4096, -1].map((t) => ({ policy: 'torn-only' as const, tornBytes: t, label: `P-TORN(${t === -1 ? 'len-1' : t})` })),
    ...[1, 2, 3].map((seed) => ({ policy: 'random-subset' as const, seed, label: `P-RANDOM(${seed})` })),
  ];
}

/** Fault-free op trace of a workload. */
export function traceOf(w: Workload): OpRecord[] {
  const fv = new FaultVfs(new MemoryVfs());
  runWorkload(fv, w);
  return fv.opLog;
}

export interface CrashCase {
  op: number;
  spec: PolicySpec;
}

/** All crash cases: every op × every policy; torn policies only on write ops shorter than the torn size. */
export function crashCases(trace: OpRecord[], full: boolean): CrashCase[] {
  const out: CrashCase[] = [];
  for (const rec of trace) {
    for (const spec of policySpecs(full)) {
      if (spec.policy === 'torn-only') {
        if (rec.kind !== 'write') continue;
        const len = rec.length ?? 0;
        const t = spec.tornBytes === -1 ? len - 1 : (spec.tornBytes as number);
        if (t <= 0 || t >= len) continue;
        out.push({ op: rec.seq, spec: { ...spec, tornBytes: t } });
      } else {
        out.push({ op: rec.seq, spec });
      }
    }
  }
  return out;
}

export function crashImageFor(w: Workload, c: CrashCase): { image: MemoryVfs; result: RunResult } {
  const base = new MemoryVfs();
  const plan: FaultPlan = { crashAtOp: c.op };
  if (c.spec.tornBytes !== undefined) plan.tornBytes = c.spec.tornBytes;
  const result = runWorkload(new FaultVfs(base, plan), w);
  const rng: Rng | undefined = c.spec.seed === undefined ? undefined : createRng(c.spec.seed * 7919 + c.op);
  return { image: base.crashImage(c.spec.policy, rng), result };
}

/** J.5 steps 3–4: reopen, the state is one of the allowed model states, and a second reopen sees the same. */
export function checkCrashCase(w: Workload, c: CrashCase): void {
  const ctx = `PW1 op=${c.op} policy=${c.spec.label} (CRASH_CASE=PW1:${c.spec.label}:${c.op})`;
  const { image, result } = crashImageFor(w, c);
  expect(result.crashed, ctx).toBe(true);
  const allowed = [result.acked];
  if (result.inFlight) allowed.push(result.acked + 1);
  for (let round = 0; round < 2; round++) {
    const p = openPager(image, 'db', { ...w.options, initialize: initializeHook });
    const matched = allowed.filter((k) => stateMatches(p, w.states[k] as PageState));
    expect(matched.length, `${ctx} round ${round}: state not in S_${allowed.join('/S_')}`).toBeGreaterThan(0);
    p.close();
  }
}
