import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/util/prng.js';

describe('prng', () => {
  it('T-PRNG-001 same seed gives the same sequence; pinned first outputs', () => {
    const a = createRng(1);
    const b = createRng(1);
    const seqA = Array.from({ length: 100 }, () => a.nextU32());
    const seqB = Array.from({ length: 100 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);

    const c = createRng(2);
    const seqC = Array.from({ length: 100 }, () => c.nextU32());
    expect(seqC).not.toEqual(seqA);

    // pinned values: a change here means every recorded seed reproduces differently
    const pinned = createRng(42);
    expect(Array.from({ length: 5 }, () => pinned.nextU32())).toMatchInlineSnapshot(`
      [
        1028872839,
        2516511472,
        400437680,
        853279530,
        1920286840,
      ]
    `);
  });

  it('T-PRNG-001 nextInt stays in range and covers it', () => {
    const r = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.nextInt(-3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
    expect(() => r.nextInt(2, 1)).toThrow(RangeError);
  });
});
