import { describe, expect, it } from 'vitest';
import { CorruptionError, LimitError, MiniDbError } from '../../src/errors/errors.js';
import { decodeRow, encodedRowSize, encodeRow } from '../../src/record/row-codec.js';
import type { ColumnType, Value } from '../../src/record/value.js';
import { MAX_ROW_BYTES } from '../../src/storage/layout.js';
import { createRng, type Rng } from '../../src/util/prng.js';

const TEXTS = ['', 'a', 'hello', 'é', '한', '😀', 'ｱ', 'a\u0000b', "it''s", '한글😀mix'];
const INTS = [0, 1, -1, 42, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 31, -(2 ** 31) - 1, 2 ** 40];

function randomValue(r: Rng, t: ColumnType): Value {
  if (r.chance(0.2)) return null;
  switch (t) {
    case 'INTEGER':
      return r.chance(0.5) ? r.pick(INTS) : r.nextInt(-1000, 1000);
    case 'BOOLEAN':
      return r.chance(0.5);
    case 'TEXT':
      return r.chance(0.7) ? r.pick(TEXTS) : 'x'.repeat(r.nextInt(0, 300));
  }
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof MiniDbError) return e.code;
    throw e;
  }
  return 'no error';
}

describe('row codec', () => {
  it('T-ROW-001 random rows round-trip (NULLs, integer extremes, empty and multi-byte text)', () => {
    const r = createRng(17);
    for (let i = 0; i < 2000; i++) {
      const n = r.nextInt(1, 64);
      const types = Array.from({ length: n }, () => r.pick<ColumnType>(['INTEGER', 'TEXT', 'BOOLEAN']));
      const values = types.map((t) => randomValue(r, t));
      let bytes: Uint8Array;
      try {
        bytes = encodeRow(types, values);
      } catch (e) {
        expect(e).toBeInstanceOf(LimitError);
        continue;
      }
      expect(decodeRow(types, bytes)).toEqual(values);
    }
  });

  it('T-ROW-002 size formula is exact; 4060 bytes encodes, 4061 is ROW_TOO_LARGE', () => {
    const types: ColumnType[] = ['INTEGER', 'TEXT', 'BOOLEAN'];
    const row: Value[] = [7, '한', null];
    const bytes = encodeRow(types, row);
    expect(Array.from(bytes)).toEqual([3, 4, 7, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0xed, 0x95, 0x9c]);
    expect(encodedRowSize(types, row)).toBe(15);
    // one TEXT column: 1 + 1 + 2 + L → split across two columns to stay under MAX_TEXT_BYTES
    const two: ColumnType[] = ['TEXT', 'TEXT'];
    const overhead = 1 + 1 + 2 + 2;
    const fits = [ 'a'.repeat(3000), 'b'.repeat(MAX_ROW_BYTES - overhead - 3000) ];
    expect(encodeRow(two, fits).length).toBe(MAX_ROW_BYTES);
    const tooBig = [ 'a'.repeat(3000), 'b'.repeat(MAX_ROW_BYTES - overhead - 3000 + 1) ];
    expect(encodedRowSize(two, tooBig)).toBe(MAX_ROW_BYTES + 1);
    expect(codeOf(() => encodeRow(two, tooBig))).toBe('ROW_TOO_LARGE');
    expect(codeOf(() => encodeRow(['TEXT'], ['x'.repeat(4001)]))).toBe('TEXT_TOO_LARGE');
  });

  it('T-ROW-003 malformed bytes are RECORD_MALFORMED', () => {
    const types: ColumnType[] = ['INTEGER', 'BOOLEAN', 'TEXT'];
    const good = encodeRow(types, [1, true, 'ab']);
    const cases: Array<[string, Uint8Array]> = [];
    const mut = (f: (b: Uint8Array) => Uint8Array): Uint8Array => f(Uint8Array.from(good));
    cases.push(['column count', mut((b) => ((b[0] = 2), b))]);
    cases.push(['boolean 2', mut((b) => ((b[10] = 2), b))]);
    cases.push(['bad utf-8', mut((b) => ((b[13] = 0xff), b))]);
    cases.push(['text length overflow', mut((b) => ((b[11] = 9), b))]);
    cases.push(['trailing byte', Uint8Array.from([...good, 0])]);
    cases.push(['truncated', good.subarray(0, 5)]);
    cases.push(['unused bitmap bit', mut((b) => ((b[1] = 0x80), b))]);
    const big = new Uint8Array(good);
    new DataView(big.buffer).setBigInt64(2, 2n ** 60n, true);
    cases.push(['unsafe integer', big]);
    cases.push(['empty', new Uint8Array(0)]);
    for (const [name, bytes] of cases) {
      let err: unknown;
      try {
        decodeRow(types, bytes);
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(CorruptionError);
      expect((err as CorruptionError).code, name).toBe('RECORD_MALFORMED');
    }
  });
});
