import { Database, type ExecResult } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { createRng } from '../../src/util/prng.js';
import type { MStmt, MVal } from '../model/ast.js';
import { generate, resetGenerator, type GenOptions } from '../model/generator.js';
import { RefModel, type MResult } from '../model/ref-model.js';
import { renderStmt } from '../model/render.js';
import { deterministicEntropy } from './db.js';

/**
 * Model-based random testing driver (J.3, J.4): every generated statement runs on the database and on the
 * reference model; results, failures and error codes must agree. Periodic integrity checks and reopens.
 */
export interface ModelRunOptions extends GenOptions {
  steps: number;
  reopenEvery?: number;
  /** Override cache size (small caches exercise eviction). */
  cachePages?: number;
}

const canon = (rows: MVal[][]): string[] => rows.map((r) => JSON.stringify(r)).sort();

function compare(sql: string, got: ExecResult | MiniDbError, want: MResult): string | null {
  if (got instanceof MiniDbError) {
    if (want.ok) return `database failed with ${got.code} but the model succeeded`;
    if (!want.codes.has(got.code)) return `database failed with ${got.code}, model expected one of ${[...want.codes].join('/')}`;
    return null;
  }
  if (!want.ok) return `database succeeded but the model failed with ${[...want.codes].join('/')}`;
  if (want.kind === 'rows') {
    if (got.kind !== 'rows') return `expected rows, got ${got.kind}`;
    if (JSON.stringify(got.columns) !== JSON.stringify(want.columns)) return `columns ${JSON.stringify(got.columns)} != ${JSON.stringify(want.columns)}`;
    const a = want.totalOrder ? got.rows.map((r) => JSON.stringify(r)) : canon(got.rows as MVal[][]);
    const b = want.totalOrder ? want.rows.map((r) => JSON.stringify(r)) : canon(want.rows);
    if (JSON.stringify(a) !== JSON.stringify(b)) return `rows differ\n  db:    ${a.join(' ')}\n  model: ${b.join(' ')}`;
    return null;
  }
  if (want.kind === 'changes') {
    if (got.kind !== 'changes' || got.changes !== want.changes) return `changes ${JSON.stringify(got)} != ${want.changes}`;
    return null;
  }
  return got.kind === 'ok' ? null : `expected ok, got ${got.kind}`;
}

export interface ModelTrace {
  lines: string[];
}

/** Runs one seed; throws with a reproduction command on the first divergence. Returns the trace. */
export function runModelSeed(seed: number, opts: ModelRunOptions): ModelTrace {
  const r = createRng(seed);
  resetGenerator();
  const vfs = new MemoryVfs();
  const openDb = (): Database =>
    Database.open('model.db', { vfs, entropy: deterministicEntropy(seed), ...(opts.cachePages ? { cachePages: opts.cachePages } : {}) });
  let db = openDb();
  const model = new RefModel();
  const recent: string[] = [];
  const trace: string[] = [];
  const reopenEvery = opts.reopenEvery ?? 50;
  const fail = (step: number, msg: string): never => {
    throw new Error(
      [
        `model divergence at seed=${seed} step=${step}: ${msg}`,
        'recent statements:',
        ...recent.map((s) => `  ${s}`),
        `REPRO (bash): SEED=${seed} STEPS=${opts.steps} npx vitest run --config vitest.long.config.ts tests/long/random.long.test.ts`,
        `REPRO (PowerShell): $env:SEED=${seed}; $env:STEPS=${opts.steps}; npx vitest run --config vitest.long.config.ts tests/long/random.long.test.ts`,
      ].join('\n'),
    );
  };
  try {
    for (let step = 0; step < opts.steps; step++) {
      if (step > 0 && step % reopenEvery === 0) {
        if (r.chance(0.5) && !db.inTransaction) {
          const report = db.integrityCheck();
          if (!report.ok) fail(step, `integrity: ${JSON.stringify(report.issues.slice(0, 3))}`);
        }
        db.close();
        model.reopen();
        db = openDb();
        recent.push('-- reopen');
        trace.push('-- reopen');
      }
      const stmt: MStmt = generate(r, model.state, model.inTxn, opts);
      const sql = renderStmt(stmt);
      recent.push(sql);
      if (recent.length > 20) recent.shift();
      let got: ExecResult | MiniDbError;
      try {
        got = db.execute(sql);
      } catch (e) {
        if (!(e instanceof MiniDbError)) throw e;
        got = e;
      }
      const want = model.apply(stmt);
      const diff = compare(sql, got, want);
      if (diff) fail(step, `${sql}\n  ${diff}`);
      trace.push(`${sql} => ${got instanceof MiniDbError ? `ERROR ${got.code}` : JSON.stringify(got)}`);
      if (db.state !== 'open') fail(step, `database entered state ${db.state}`);
    }
    if (db.inTransaction) {
      db.execute('ROLLBACK');
      model.apply({ k: 'rollback' });
    }
    // final full comparison after reopen
    db.close();
    model.reopen();
    db = openDb();
    for (const name of [...model.state.tables.keys()].sort()) {
      const got = db.execute(`SELECT * FROM ${name}`);
      const want = model.apply({ k: 'select', table: name, cols: null, where: null, order: [], limit: null, offset: null });
      const diff = compare(`SELECT * FROM ${name}`, got, want);
      if (diff) fail(opts.steps, `final state of ${name}: ${diff}`);
    }
    const report = db.integrityCheck();
    if (!report.ok) fail(opts.steps, `final integrity: ${JSON.stringify(report.issues.slice(0, 3))}`);
  } finally {
    if (db.state !== 'closed') db.close();
  }
  return { lines: trace };
}

export function seedsFromEnv(defaultCount: number): number[] {
  if (process.env.SEED) return [Number(process.env.SEED)];
  const start = Number(process.env.SEED_START ?? 1);
  const count = Number(process.env.SEEDS ?? defaultCount);
  return Array.from({ length: count }, (_, i) => start + i);
}
