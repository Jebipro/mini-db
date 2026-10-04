import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database, type DbStats, type OpenOptions } from '../src/index.js';
import { createRng, type Rng } from '../src/util/prng.js';
import { timeStats, type IoDelta, type ScenarioResult } from './report.js';

/**
 * Benchmark scenarios B1–B10 (K.2). Each returns results; data is generated from BENCH_SEED.
 * Write scenarios use a fresh database per repetition; read scenarios share one prepared database.
 */
export interface BenchConfig {
  dir: string;
  seed: number;
  /** Multiplies row counts (1 = K.2 sizes; tiny values for the smoke test). */
  scale: number;
  warmup: number;
  reps: number;
}

const now = (): number => Number(process.hrtime.bigint()) / 1e6;

function ioDelta(a: DbStats, b: DbStats): IoDelta {
  const hits = b.cache.hits - a.cache.hits;
  const misses = b.cache.misses - a.cache.misses;
  return {
    dataPageReads: b.io.dataPageReads - a.io.dataPageReads,
    walFrameReads: b.io.walFrameReads - a.io.walFrameReads,
    dataPageWrites: b.io.dataPageWrites - a.io.dataPageWrites,
    walFrameWrites: b.io.walFrameWrites - a.io.walFrameWrites,
    dataSyncs: b.io.dataSyncs - a.io.dataSyncs,
    walSyncs: b.io.walSyncs - a.io.walSyncs,
    cacheHitRate: hits + misses === 0 ? 1 : Math.round((hits / (hits + misses)) * 1000) / 1000,
  };
}

let fileSeq = 0;
function freshPath(cfg: BenchConfig): string {
  mkdirSync(cfg.dir, { recursive: true });
  const p = join(cfg.dir, `b${process.pid}-${fileSeq++}.db`);
  for (const f of [p, `${p}-wal`, `${p}-lock`]) if (existsSync(f)) rmSync(f);
  return p;
}

function removeDb(p: string): void {
  for (const f of [p, `${p}-wal`, `${p}-lock`]) if (existsSync(f)) rmSync(f, { force: true });
}

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyz';
function name(r: Rng): string {
  let s = '';
  const n = r.nextInt(8, 24);
  for (let i = 0; i < n; i++) s += NAME_CHARS[r.nextInt(0, 25)];
  return s;
}

const SCHEMA = 'CREATE TABLE items (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, name TEXT NOT NULL, flag BOOLEAN)';

/** Loads `rows` rows in one transaction using multi-row INSERTs. */
function load(db: Database, rows: number, r: Rng, startId = 0): void {
  db.execute('BEGIN');
  for (let i = 0; i < rows; i += 500) {
    const vals: string[] = [];
    for (let j = i; j < Math.min(rows, i + 500); j++) vals.push(`(${startId + j}, ${r.nextInt(0, 999)}, '${name(r)}', ${r.chance(0.5) ? 'TRUE' : 'FALSE'})`);
    db.execute(`INSERT INTO items VALUES ${vals.join(', ')}`);
  }
  db.execute('COMMIT');
}

/** Times `fn` warmup + reps times; `setup` runs before each (untimed). I/O is the delta of the last repetition. */
function measure(
  cfg: BenchConfig,
  dbOf: () => Database,
  fn: (db: Database, rep: number) => void,
): { samples: number[]; io: IoDelta } {
  const samples: number[] = [];
  let io: IoDelta | null = null;
  for (let rep = 0; rep < cfg.warmup + cfg.reps; rep++) {
    const db = dbOf();
    db.resetStats();
    const before = db.stats();
    const t0 = now();
    fn(db, rep);
    const t1 = now();
    io = ioDelta(before, db.stats());
    if (rep >= cfg.warmup) samples.push(t1 - t0);
  }
  return { samples, io: io as IoDelta };
}

function result(id: string, variant: string, params: ScenarioResult['params'], m: { samples: number[]; io: IoDelta }, extra?: Record<string, number>): ScenarioResult {
  const { stats, unstable } = timeStats(m.samples);
  return { id, variant, params, timeMs: stats, unstable, io: m.io, ...(extra ? { extra } : {}) };
}

const N = (cfg: BenchConfig, n: number): number => Math.max(10, Math.round(n * cfg.scale));

export function runScenarios(cfg: BenchConfig, only?: string[]): ScenarioResult[] {
  const out: ScenarioResult[] = [];
  const want = (id: string): boolean => !only || only.includes(id);
  const opts = (extra: OpenOptions = {}): OpenOptions => ({ ...extra });

  // ---- B1 / B2: bulk insert
  if (want('B1')) {
    const n = N(cfg, 2000);
    const paths: string[] = [];
    const m = measure(
      cfg,
      () => {
        const p = freshPath(cfg);
        paths.push(p);
        const db = Database.open(p, opts());
        db.execute(SCHEMA);
        return db;
      },
      (db) => {
        const r = createRng(cfg.seed);
        for (let i = 0; i < n; i++) db.execute(`INSERT INTO items VALUES (${i}, ${r.nextInt(0, 999)}, '${name(r)}', TRUE)`);
        db.close();
      },
    );
    paths.forEach(removeDb);
    out.push(result('B1', 'autocommit', { rows: n }, m, { usPerRow: Math.round((timeStats(m.samples).stats.median * 1000) / n) }));
  }
  if (want('B2')) {
    for (const n of [N(cfg, 2000), N(cfg, 100_000)]) {
      const paths: string[] = [];
      const m = measure(
        cfg,
        () => {
          const p = freshPath(cfg);
          paths.push(p);
          const db = Database.open(p, opts({ cachePages: 16384 }));
          db.execute(SCHEMA);
          return db;
        },
        (db) => {
          load(db, n, createRng(cfg.seed));
          db.close();
        },
      );
      paths.forEach(removeDb);
      out.push(result('B2', 'single-txn', { rows: n }, m, { usPerRow: Math.round((timeStats(m.samples).stats.median * 1000) / n) }));
    }
  }

  // ---- shared 100k-row database for read scenarios
  const big = N(cfg, 100_000);
  const readPath = freshPath(cfg);
  {
    const db = Database.open(readPath, opts({ cachePages: 16384 }));
    db.execute(SCHEMA);
    load(db, big, createRng(cfg.seed));
    db.execute('CREATE INDEX items_grp ON items (grp)');
    db.close();
  }
  const readers: Database[] = [];
  const shared = (cachePages = 2048): (() => Database) => {
    const db = Database.open(readPath, opts({ cachePages }));
    readers.push(db);
    return () => db;
  };
  const closeReaders = (): void => {
    for (const d of readers.splice(0)) d.close();
  };

  if (want('B3')) {
    const lookups = N(cfg, 1000);
    const r = createRng(cfg.seed + 3);
    const ids = Array.from({ length: lookups }, () => r.nextInt(0, big - 1));
    const reader = shared();
    const m1 = measure(cfg, reader, (db) => {
      for (const id of ids) db.execute(`SELECT name FROM items WHERE id = ${id}`);
    });
    out.push(result('B3', 'pk-lookup', { rows: big, ops: lookups }, m1, { usPerOp: Math.round((timeStats(m1.samples).stats.median * 1000) / lookups), readsPerOp: Math.round(((m1.io.dataPageReads + m1.io.walFrameReads) / lookups) * 100) / 100 }));
    const scans = Math.max(2, Math.round(lookups / 20));
    const m2 = measure(cfg, reader, (db) => {
      for (let i = 0; i < scans; i++) db.execute(`SELECT id FROM items WHERE name = 'zz${i}'`);
    });
    out.push(result('B3', 'no-index-lookup', { rows: big, ops: scans }, m2, { usPerOp: Math.round((timeStats(m2.samples).stats.median * 1000) / scans), readsPerOp: Math.round((m2.io.dataPageReads + m2.io.walFrameReads) / scans) }));
    // S6: cold single lookup physical reads vs tree height
    closeReaders();
    const cold = Database.open(readPath, opts());
    cold.resetStats();
    const zero = cold.stats();
    const t0 = now();
    cold.execute(`SELECT name FROM items WHERE id = ${ids[0] ?? 0}`);
    const t1 = now();
    out.push({ id: 'B3', variant: 'cold-pk-lookup', params: { rows: big }, timeMs: { median: Math.round((t1 - t0) * 1000) / 1000, min: 0, max: 0, iqr: 0 }, unstable: false, io: ioDelta(zero, cold.stats()) });
    cold.close();
  }

  closeReaders();
  if (want('B4')) {
    const reader = shared();
    for (const [label, where] of [['0.1%', 'grp = 5'], ['1%', 'grp < 10'], ['10%', 'grp < 100']] as const) {
      for (const force of [false, true]) {
        const m = measure(cfg, reader, (db) => {
          db.execute(`SELECT id FROM items WHERE ${where}`, { forceSeqScan: force });
        });
        out.push(result('B4', `${force ? 'seq' : 'index'} ${label}`, { rows: big, where }, m));
      }
    }
  }

  closeReaders();
  if (want('B5')) {
    const m = measure(cfg, shared(), (db) => {
      db.execute('SELECT * FROM items');
    });
    out.push(result('B5', 'full-scan', { rows: big }, m, { rowsPerSec: Math.round(big / (timeStats(m.samples).stats.median / 1000)) }));
  }

  closeReaders();
  if (want('B7')) {
    const reader = shared();
    for (const lim of ['', ' LIMIT 10']) {
      const m = measure(cfg, reader, (db) => {
        db.execute(`SELECT id FROM items ORDER BY name${lim}`);
      });
      out.push(result('B7', lim ? 'order-by-limit-10' : 'order-by-full', { rows: big }, m));
    }
  }

  closeReaders();
  if (want('B8')) {
    const r = createRng(cfg.seed + 8);
    const ops = N(cfg, 5000);
    const ids = Array.from({ length: ops }, () => r.nextInt(0, big - 1));
    for (const cachePages of [64, 256, 1024, 4096, 16384]) {
      const m = measure(cfg, shared(cachePages), (db) => {
        for (const id of ids) db.execute(`SELECT flag FROM items WHERE id = ${id}`);
      });
      closeReaders();
      out.push(result('B8', `cache=${cachePages}`, { rows: big, ops, cachePages }, m));
    }
  }
  closeReaders();

  if (want('B6')) {
    const variants = [
      ['update-same-size', "UPDATE items SET flag = NOT flag WHERE id < $N"],
      ['update-grow', `UPDATE items SET name = '${'g'.repeat(300)}' WHERE id < $N`],
      ['delete', 'DELETE FROM items WHERE id < $N'],
    ] as const;
    for (const [variant, tpl] of variants) {
      const paths: string[] = [];
      const m = measure(
        cfg,
        () => {
          const p = freshPath(cfg);
          paths.push(p);
          copyFileSync(readPath, p);
          if (existsSync(`${readPath}-wal`)) copyFileSync(`${readPath}-wal`, `${p}-wal`);
          return Database.open(p, opts({ cachePages: 16384 }));
        },
        (db) => {
          db.execute(tpl.replace('$N', String(Math.round(big / 10))));
          db.close();
        },
      );
      paths.forEach(removeDb);
      out.push(result('B6', variant, { rows: big, affected: Math.round(big / 10) }, m));
    }
  }
  removeDb(readPath);

  if (want('B9')) {
    for (const frames of [0, 100, 1000, N(cfg, 10_000)]) {
      const src = freshPath(cfg);
      const db = Database.open(src, opts({ walAutoCheckpointFrames: 0, cachePages: 16384 }));
      db.execute(SCHEMA);
      db.checkpoint();
      const r = createRng(cfg.seed + 9);
      let id = 0;
      while (db.stats().wal.frames < frames) {
        db.execute('BEGIN');
        for (let k = 0; k < 20; k++) db.execute(`INSERT INTO items VALUES (${id++}, ${r.nextInt(0, 999)}, '${name(r)}', TRUE)`);
        db.execute('COMMIT');
      }
      const walFrames = db.stats().wal.frames;
      // snapshot the files while the handle is open (every commit is fsynced): the copy needs recovery
      const paths: string[] = [];
      const samples: number[] = [];
      let applied = 0;
      for (let rep = 0; rep < cfg.warmup + cfg.reps; rep++) {
        const p = freshPath(cfg);
        paths.push(p);
        copyFileSync(src, p);
        copyFileSync(`${src}-wal`, `${p}-wal`);
        const t0 = now();
        const opened = Database.open(p, opts());
        const t1 = now();
        applied = opened.stats().recovery.framesApplied;
        opened.close();
        if (rep >= cfg.warmup) samples.push(t1 - t0);
      }
      db.close();
      removeDb(src);
      paths.forEach(removeDb);
      const { stats, unstable } = timeStats(samples);
      out.push({ id: 'B9', variant: `wal-frames=${walFrames}`, params: { walFrames }, timeMs: stats, unstable, io: { dataPageReads: 0, walFrameReads: 0, dataPageWrites: 0, walFrameWrites: 0, dataSyncs: 0, walSyncs: 0, cacheHitRate: 1 }, extra: { framesApplied: applied } });
    }
  }

  if (want('B10')) {
    const n = N(cfg, 10_000);
    const p = freshPath(cfg);
    const db = Database.open(p, opts({ cachePages: 16384 }));
    db.execute(SCHEMA);
    load(db, n, createRng(cfg.seed));
    const r = createRng(cfg.seed + 10);
    let next = n;
    const t0 = now();
    for (let round = 0; round < 10; round++) {
      db.execute(`DELETE FROM items WHERE grp < 500`);
      const left = db.execute('SELECT id FROM items');
      const missing = n - (left.kind === 'rows' ? left.rows.length : 0);
      load(db, missing, r, next);
      next += missing;
      const s = db.integrityCheck().summary;
      out.push({ id: 'B10', variant: `round=${round + 1}`, params: { rows: n }, timeMs: { median: Math.round((now() - t0) * 1000) / 1000, min: 0, max: 0, iqr: 0 }, unstable: false, io: ioDelta(db.stats(), db.stats()), extra: { pageCount: s.pageCount, freePages: s.freePages, heapPages: s.heapPages, btreePages: s.btreePages } });
    }
    db.close();
    removeDb(p);
  }
  return out;
}
