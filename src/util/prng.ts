/**
 * Deterministic PRNG (DC-66): sfc32 seeded through splitmix32.
 * Used by tests, the reference model generator and benchmarks. Never use the platform random source.
 */
export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextU32(): number;
  /** Uniform integer in [lo, hiInclusive]. */
  nextInt(lo: number, hiInclusive: number): number;
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** true with probability p. */
  chance(p: number): boolean;
  /** Uniformly chosen element; throws on empty input. */
  pick<T>(items: readonly T[]): T;
  /** `n` random bytes. */
  bytes(n: number): Uint8Array;
}

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed)) throw new RangeError(`seed must be an integer, got ${seed}`);
  const init = splitmix32(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();

  const nextU32 = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  // discard the first outputs to mix the state
  for (let i = 0; i < 12; i++) nextU32();

  const nextFloat = (): number => nextU32() / 4294967296;
  const nextInt = (lo: number, hiInclusive: number): number => {
    if (!Number.isInteger(lo) || !Number.isInteger(hiInclusive) || hiInclusive < lo) {
      throw new RangeError(`invalid range [${lo}, ${hiInclusive}]`);
    }
    return lo + Math.floor(nextFloat() * (hiInclusive - lo + 1));
  };
  return {
    nextU32,
    nextFloat,
    nextInt,
    chance: (p) => nextFloat() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('pick from empty list');
      return items[nextInt(0, items.length - 1)] as T;
    },
    bytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = nextU32() & 0xff;
      return out;
    },
  };
}
