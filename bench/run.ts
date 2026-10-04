import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environment, markdownTable } from './report.js';
import { runScenarios } from './scenarios.js';

/**
 * npm run bench — K.1–K.4. Env: BENCH_SEED (42), BENCH_SCALE (1), BENCH_REPS (5), BENCH_WARMUP (1),
 * BENCH_ONLY (comma-separated scenario ids), BENCH_DISK (free-text disk description).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cfg = {
  dir: join(root, 'bench', 'results', 'tmp'),
  seed: Number(process.env.BENCH_SEED ?? 42),
  scale: Number(process.env.BENCH_SCALE ?? 1),
  warmup: Number(process.env.BENCH_WARMUP ?? 1),
  reps: Number(process.env.BENCH_REPS ?? 5),
};
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch {
  // not a git checkout
}
const only = process.env.BENCH_ONLY?.split(',').map((s) => s.trim());
const started = new Date();
const results = runScenarios(cfg, only);
const report = { env: environment(commit), seed: cfg.seed, scale: cfg.scale, reps: cfg.reps, warmup: cfg.warmup, scenarios: results };
const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
mkdirSync(join(root, 'bench', 'results'), { recursive: true });
const file = join(root, 'bench', 'results', `${stamp}-${commit}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.env));
console.log(markdownTable(results));
console.log(`\nwrote ${file}`);
