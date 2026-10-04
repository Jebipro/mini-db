import { describe, expect, it } from 'vitest';
import { crc32 } from '../../src/util/crc32.js';
import { createRng } from '../../src/util/prng.js';

/** Independent bit-at-a-time reference implementation (no table). */
function crcBitwise(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('crc32', () => {
  it('T-CRC-001 known vectors and a zero page against a bitwise implementation', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
    expect(crc32(ascii('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    const zeros = new Uint8Array(4096);
    expect(crc32(zeros)).toBe(crcBitwise(zeros));
    const r = createRng(3);
    for (let i = 0; i < 20; i++) {
      const b = r.bytes(r.nextInt(0, 300));
      expect(crc32(b)).toBe(crcBitwise(b));
    }
  });

  it('T-CRC-002 incremental computation equals one-shot', () => {
    const r = createRng(9);
    for (let i = 0; i < 50; i++) {
      const a = r.bytes(r.nextInt(0, 100));
      const b = r.bytes(r.nextInt(0, 100));
      const ab = new Uint8Array(a.length + b.length);
      ab.set(a);
      ab.set(b, a.length);
      expect(crc32(b, crc32(a))).toBe(crc32(ab));
      const cut = r.nextInt(0, ab.length);
      expect(crc32(ab, crc32(ab, 0, 0, cut), cut)).toBe(crc32(ab));
    }
  });
});
