import { describe, expect, it } from 'vitest';
import { markdownTable } from '../../bench/report.js';
import { runScenarios } from '../../bench/scenarios.js';
import { useTmpDir } from '../support/tmp.js';

const tmp = useTmpDir();

describe('benchmark harness', () => {
  it('T-BENCH-001 every scenario runs at a tiny scale and reports the required fields', { timeout: 60_000 }, () => {
    const results = runScenarios({ dir: tmp(), seed: 1, scale: 0.002, warmup: 0, reps: 1 });
    const ids = new Set(results.map((r) => r.id));
    expect([...ids].sort()).toEqual(['B1', 'B10', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']);
    for (const r of results) {
      expect(r.timeMs).toEqual({ median: expect.any(Number), min: expect.any(Number), max: expect.any(Number), iqr: expect.any(Number) });
      expect(Object.keys(r.io).sort()).toEqual(['cacheHitRate', 'dataPageReads', 'dataPageWrites', 'dataSyncs', 'walFrameReads', 'walFrameWrites', 'walSyncs']);
    }
    // S2 sanity even at tiny scale: autocommit = one WAL fsync per row, single transaction = one
    const b1 = results.find((r) => r.id === 'B1');
    const b2 = results.find((r) => r.id === 'B2');
    expect(b1?.io.walSyncs).toBeGreaterThanOrEqual(10);
    expect(b2?.io.walSyncs).toBeLessThanOrEqual(3);
    expect(markdownTable(results).split('\n').length).toBe(results.length + 2);
  });
});
