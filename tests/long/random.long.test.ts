import { describe, it } from 'vitest';
import { runModelSeed, seedsFromEnv } from '../support/model-runner.js';

const steps = Number(process.env.STEPS ?? 1000);

describe('model-based random testing (long)', () => {
  it('T-MODEL-001 long run without indexes (SEEDS / SEED_START / SEED / STEPS)', () => {
    const seeds = seedsFromEnv(200);
    for (const seed of seeds) runModelSeed(seed, { steps, withIndexes: false, reopenEvery: 97 });
    console.log(`T-MODEL-001 long: ${seeds.length} seeds × ${steps} steps`);
  });

  it('T-MODEL-002 long run with indexes', () => {
    const seeds = seedsFromEnv(200).map((s) => s + 200_000);
    for (const seed of seeds) runModelSeed(seed, { steps, withIndexes: true, reopenEvery: 89 });
  });

  it('T-MODEL-003 long run with small cache and frequent reopen', () => {
    const seeds = seedsFromEnv(50).map((s) => s + 100_000);
    for (const seed of seeds) runModelSeed(seed, { steps, withIndexes: false, reopenEvery: 31, cachePages: 64 });
  });
});
