import { expect } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { FaultVfs, SimulatedCrash, type FaultPlan, type OpRecord } from '../../src/storage/fault-vfs.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { Vfs } from '../../src/storage/vfs.js';
import { createRng, type Rng } from '../../src/util/prng.js';
import type { MExpr, MStmt, MVal } from '../model/ast.js';
import { generate, resetGenerator } from '../model/generator.js';
import { RefModel, type MState } from '../model/ref-model.js';
import { renderStmt } from '../model/render.js';
import { deterministicEntropy } from './db.js';
import { policySpecs, type PolicySpec } from './page-crash.js';

/**
 * SQL-level crash matrix (J.5, CW1–CW6). Expected states come from the reference model, never from a
 * fault-free run of the engine. A "unit" is one commit: an autocommit statement or a BEGIN…COMMIT block.
 */

export type Step = { kind: 'sql'; stmt: MStmt } | { kind: 'checkpoint' };

export interface SqlWorkload {
  name: string;
  steps: Step[];
  options: { walAutoCheckpointFrames?: number; cachePages?: number };
}

const lit = (v: MVal): MExpr => ({ k: 'lit', v });
const col = (name: string): MExpr => ({ k: 'col', name });
const sql = (stmt: MStmt): Step => ({ kind: 'sql', stmt });
const table = (name: string, cols: Array<[string, 'INTEGER' | 'TEXT' | 'BOOLEAN']>, pk = true): Step =>
  sql({ k: 'create', table: name, cols: cols.map(([n, type], i) => ({ name: n, type, notNull: pk && i === 0, pk: pk && i === 0 })) });
const insert = (t: string, ...rows: MVal[][]): Step => sql({ k: 'insert', table: t, cols: null, rows: rows.map((r) => r.map(lit)) });

export function workloads(): SqlWorkload[] {
  const cw1: SqlWorkload = { name: 'CW1', steps: [], options: {} };
  const cw2: SqlWorkload = {
    name: 'CW2',
    steps: [table('t', [['id', 'INTEGER'], ['v', 'TEXT']]), ...[1, 2, 3, 4, 5].map((i) => insert('t', [i, `v${i}`]))],
    options: {},
  };
  const big = (i: number): string => `${i}:${'x'.repeat(480)}`;
  const cw3: SqlWorkload = {
    name: 'CW3',
    steps: [
      table('t', [['id', 'INTEGER'], ['v', 'TEXT']]),
      sql({ k: 'begin' }),
      ...Array.from({ length: 40 }, (_, i) => insert('t', [i, big(i)])),
      sql({ k: 'commit' }),
      sql({ k: 'begin' }),
      insert('t', [100, 'rolled back']),
      sql({ k: 'rollback' }),
      sql({ k: 'update', table: 't', sets: [{ col: 'v', e: lit('short') }], where: { k: 'cmp', op: '<', l: col('id'), r: lit(10) } }),
      sql({ k: 'delete', table: 't', where: { k: 'cmp', op: '>=', l: col('id'), r: lit(30) } }),
    ],
    options: {},
  };
  const key = (i: number): string => `k${String(i).padStart(4, '0')}${'y'.repeat(120)}`;
  const cw4: SqlWorkload = {
    name: 'CW4',
    steps: [
      table('t', [['id', 'INTEGER'], ['k', 'TEXT'], ['pad', 'TEXT']]),
      sql({ k: 'createIndex', name: 'ik', table: 't', col: 'k', unique: false }),
      ...Array.from({ length: 8 }, (_, b) => insert('t', ...Array.from({ length: 8 }, (_, j) => [b * 8 + j, key((b * 8 + j) * 37 % 64), null] as MVal[]))),
      sql({ k: 'update', table: 't', sets: [{ col: 'pad', e: lit('p'.repeat(900)) }], where: { k: 'cmp', op: '<', l: col('id'), r: lit(12) } }),
      sql({ k: 'update', table: 't', sets: [{ col: 'id', e: { k: 'arith', op: '+', l: col('id'), r: lit(1000) } }], where: { k: 'cmp', op: '>', l: col('id'), r: lit(50) } }),
      sql({ k: 'delete', table: 't', where: { k: 'cmp', op: '<', l: col('id'), r: lit(20) } }),
    ],
    options: { cachePages: 128 },
  };
  const cw5: SqlWorkload = {
    name: 'CW5',
    steps: [
      table('a', [['id', 'INTEGER'], ['s', 'TEXT']]),
      table('b', [['id', 'INTEGER'], ['n', 'INTEGER']]),
      ...Array.from({ length: 6 }, (_, i) => insert('a', [i, `a${i}`])),
      { kind: 'checkpoint' },
      ...Array.from({ length: 6 }, (_, i) => insert('b', [i, i * i])),
      sql({ k: 'createIndex', name: 'bn', table: 'b', col: 'n', unique: true }),
      sql({ k: 'drop', table: 'a' }),
      { kind: 'checkpoint' },
      insert('b', [100, 7]),
      sql({ k: 'dropIndex', name: 'bn' }),
    ],
    options: { walAutoCheckpointFrames: 4 },
  };
  return [cw1, cw2, cw3, cw4, cw5];
}

export interface Expected {
  /** states[k] = committed model state after the k-th acknowledged unit; states[0] = empty database. */
  states: MState[];
}

/** Dump of a model state: table → canonical sorted rows, plus sorted index names. */
export function dumpModel(s: MState): string {
  const out: string[] = [];
  for (const name of [...s.tables.keys()].sort()) {
    const t = s.tables.get(name) as NonNullable<ReturnType<MState['tables']['get']>>;
    out.push(`${name} ${[...t.indexes.keys()].sort().join(',')}`);
    out.push(...t.rows.map((r) => JSON.stringify(r)).sort());
  }
  return out.join('\n');
}

export function dumpDb(db: Database): string {
  const out: string[] = [];
  for (const t of db.schema()) {
    out.push(`${t.name} ${t.indexes.map((i) => i.name).sort().join(',')}`);
    const r = db.execute(`SELECT * FROM ${t.name}`);
    if (r.kind !== 'rows') throw new Error('not rows');
    out.push(...r.rows.map((row) => JSON.stringify(row)).sort());
  }
  return out.join('\n');
}

export interface RunResult {
  acked: number;
  /** Candidate state if the crash hit while a unit was committing. */
  inFlight: MState | null;
  crashed: boolean;
  states: MState[];
}

function open(vfs: Vfs, w: SqlWorkload, seed = 1): Database {
  return Database.open('crash.db', { vfs, entropy: deterministicEntropy(seed), ...w.options });
}

/** Runs the workload against `vfs`; the model advances in lock step and records every committed state. */
export function runSqlWorkload(vfs: Vfs, w: SqlWorkload): RunResult {
  const model = new RefModel();
  const states: MState[] = [model.committed()];
  let inFlight: MState | null = null;
  let acked = 0;
  try {
    const db = open(vfs, w);
    for (const step of w.steps) {
      if (step.kind === 'checkpoint') {
        db.checkpoint();
        continue;
      }
      const before = dumpModel(model.committed());
      const candidate = model.clone();
      candidate.apply(step.stmt);
      const commits = !candidate.inTxn && dumpModel(candidate.committed()) !== before;
      inFlight = commits || step.stmt.k === 'commit' ? candidate.committed() : null;
      let failed = false;
      try {
        db.execute(renderStmt(step.stmt));
      } catch (e) {
        if (!(e instanceof MiniDbError)) throw e;
        failed = true;
      }
      inFlight = null;
      const r = model.apply(step.stmt);
      expect(failed, `${w.name}: ${renderStmt(step.stmt)}`).toBe(!r.ok);
      if (!model.inTxn && dumpModel(model.committed()) !== dumpModel(states[states.length - 1] as MState)) {
        states.push(model.committed());
        acked++;
      }
    }
    db.close();
    return { acked, inFlight: null, crashed: false, states };
  } catch (e) {
    if (e instanceof SimulatedCrash) return { acked, inFlight, crashed: true, states };
    throw e;
  }
}

export function traceOfSql(w: SqlWorkload): OpRecord[] {
  const fv = new FaultVfs(new MemoryVfs());
  runSqlWorkload(fv, w);
  return fv.opLog;
}

export interface SqlCrashCase {
  op: number;
  spec: PolicySpec;
}

export function sqlCrashCases(trace: OpRecord[], full: boolean): SqlCrashCase[] {
  const out: SqlCrashCase[] = [];
  for (const rec of trace) {
    for (const spec of policySpecs(full)) {
      if (spec.policy === 'torn-only') {
        if (rec.kind !== 'write') continue;
        const len = rec.length ?? 0;
        const t = spec.tornBytes === -1 ? len - 1 : (spec.tornBytes as number);
        if (t <= 0 || t >= len) continue;
        out.push({ op: rec.seq, spec: { ...spec, tornBytes: t } });
      } else out.push({ op: rec.seq, spec });
    }
  }
  return out;
}

export function sqlCrashImage(w: SqlWorkload, c: SqlCrashCase): { image: MemoryVfs; result: RunResult } {
  const base = new MemoryVfs();
  const plan: FaultPlan = { crashAtOp: c.op };
  if (c.spec.tornBytes !== undefined) plan.tornBytes = c.spec.tornBytes;
  const result = runSqlWorkload(new FaultVfs(base, plan), w);
  const rng: Rng | undefined = c.spec.seed === undefined ? undefined : createRng(c.spec.seed * 7919 + c.op);
  return { image: base.crashImage(c.spec.policy, rng), result };
}

/** J.5 oracle: reopen succeeds, integrity ok, dump ∈ {S_a, in-flight}, a second reopen sees the same. */
export function checkSqlCrashCase(w: SqlWorkload, c: SqlCrashCase): string {
  const ctx = `${w.name} op=${c.op} policy=${c.spec.label} (CRASH_CASE=${w.name}:${c.spec.label}:${c.op})`;
  const { image, result } = sqlCrashImage(w, c);
  expect(result.crashed, ctx).toBe(true);
  const allowed = [dumpModel(result.states[result.acked] as MState)];
  if (result.inFlight) allowed.push(dumpModel(result.inFlight));
  let first = '';
  for (let round = 0; round < 2; round++) {
    const db = open(image, w);
    const report = db.integrityCheck();
    expect(report.issues, `${ctx} integrity`).toEqual([]);
    const got = dumpDb(db);
    expect(allowed, `${ctx} round ${round}: unexpected state\n${got}`).toContain(got);
    if (round === 0) first = got;
    else expect(got, `${ctx}: second reopen differs`).toBe(first);
    db.close();
  }
  return first;
}

/** T-CRASH-005: random statements (generator) with explicit transactions and indexes, crash at a random op. */
export function randomWorkload(seed: number, steps: number): SqlWorkload {
  const r = createRng(seed);
  resetGenerator();
  const model = new RefModel();
  const out: Step[] = [];
  for (let i = 0; i < steps; i++) {
    const stmt = generate(r, model.state, model.inTxn, { withIndexes: true });
    model.apply(stmt);
    out.push({ kind: 'sql', stmt });
    if (r.chance(0.03) && !model.inTxn) out.push({ kind: 'checkpoint' });
  }
  if (model.inTxn) out.push({ kind: 'sql', stmt: { k: 'commit' } });
  return { name: `RW${seed}`, steps: out, options: { walAutoCheckpointFrames: 16, cachePages: 128 } };
}
