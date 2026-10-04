import { describe, expect, it } from 'vitest';
import { runModelSeed, seedsFromEnv } from '../support/model-runner.js';

describe('model-based random testing (short)', () => {
  it('T-MODEL-001 random statements without indexes match the reference model', () => {
    for (const seed of seedsFromEnv(12)) runModelSeed(seed, { steps: 300, withIndexes: false });
  });

  it('T-MODEL-003 transactions, failing statements inside them and periodic reopen', () => {
    for (const seed of [101, 102, 103, 104]) runModelSeed(seed, { steps: 300, withIndexes: false, reopenEvery: 23 });
    // small cache: eviction and WAL read-through under the same workload
    for (const seed of [201, 202]) runModelSeed(seed, { steps: 300, withIndexes: false, reopenEvery: 37, cachePages: 64 });
  });

  it('T-MODEL-002 random statements with CREATE/DROP INDEX (unique and non-unique) match the model', () => {
    for (const seed of [301, 302, 303, 304, 305, 306, 307, 308]) runModelSeed(seed, { steps: 300, withIndexes: true, reopenEvery: 41 });
    for (const seed of [401, 402]) runModelSeed(seed, { steps: 300, withIndexes: true, reopenEvery: 53, cachePages: 64 });
  });

  it('T-MODEL-005 the same seed produces an identical trace', () => {
    const a = runModelSeed(7, { steps: 150, withIndexes: false });
    const b = runModelSeed(7, { steps: 150, withIndexes: false });
    expect(a.lines).toEqual(b.lines);
    expect(a.lines.length).toBeGreaterThan(150);
    // the workload is meaningful: most statements succeed, queries return rows, some fail on purpose
    const errors = a.lines.filter((l) => l.includes('=> ERROR')).length;
    const nonEmpty = a.lines.filter((l) => l.includes('"rows":[[')).length;
    console.log(`T-MODEL-005 trace: ${a.lines.length} statements, ${errors} errors, ${nonEmpty} non-empty results`);
    expect(errors).toBeGreaterThan(0);
    expect(errors / a.lines.length).toBeLessThan(0.35);
    expect(nonEmpty).toBeGreaterThan(20);
  });
});
