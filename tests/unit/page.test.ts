import { describe, expect, it } from 'vitest';
import { CorruptionError } from '../../src/errors/errors.js';
import { initHeaderPage, parseHeaderPage, readHeaderFields } from '../../src/storage/file-header.js';
import { FH_FORMAT_VERSION, FH_MAGIC, FH_PAGE_SIZE, PAGE_SIZE, PageType } from '../../src/storage/layout.js';
import { computePageCrc, initPage, pageIdOf, pageTypeOf, stampPageCrc, verifyPage } from '../../src/storage/page.js';
import { readU32, writeU16 } from '../../src/util/bytes.js';
import { createRng } from '../../src/util/prng.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CorruptionError) return e.code;
    throw e;
  }
  return 'no error';
}

function samplePage(): Uint8Array {
  const p = new Uint8Array(PAGE_SIZE);
  initPage(p, PageType.HEAP, 7);
  p.set(createRng(1).bytes(200), 100);
  stampPageCrc(p);
  return p;
}

describe('page', () => {
  it('T-PAGE-001 common header roundtrip and CRC stamp/verify', () => {
    const p = samplePage();
    expect(pageTypeOf(p)).toBe(PageType.HEAP);
    expect(pageIdOf(p)).toBe(7);
    expect(readU32(p, 4)).toBe(computePageCrc(p));
    expect(verifyPage(p, 7, 'test')).toBe(PageType.HEAP);
    // the CRC field itself is excluded from the checksum
    const q = Uint8Array.from(p);
    q[4] = (q[4] as number) ^ 0xff;
    expect(computePageCrc(q)).toBe(computePageCrc(p));
  });

  it('T-PAGE-002 every single-bit flip in a page is detected', () => {
    const p = samplePage();
    let undetected = 0;
    for (let byte = 0; byte < PAGE_SIZE; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        p[byte] = (p[byte] as number) ^ (1 << bit);
        try {
          verifyPage(p, 7, 'test');
          undetected++;
        } catch (e) {
          if (!(e instanceof CorruptionError)) throw e;
        }
        p[byte] = (p[byte] as number) ^ (1 << bit);
      }
    }
    expect(undetected).toBe(0);
  });

  it('T-PAGE-003 misplaced page and unknown type are reported', () => {
    const p = samplePage();
    expect(codeOf(() => verifyPage(p, 8, 'test'))).toBe('PAGE_ID_MISMATCH');
    const q = Uint8Array.from(p);
    q[0] = 9;
    stampPageCrc(q);
    expect(codeOf(() => verifyPage(q, 7, 'test'))).toBe('PAGE_TYPE_INVALID');
    expect(codeOf(() => verifyPage(new Uint8Array(PAGE_SIZE), 0, 'test'))).toBe('PAGE_CHECKSUM_MISMATCH');
  });

  it('T-FMT-001 file header roundtrip and validation codes', () => {
    const dbId = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const h = { pageCount: 2, freelistHead: 0, freelistCount: 0, catalogRoot: 1, dbId };
    const page = new Uint8Array(PAGE_SIZE);
    initHeaderPage(page, h);
    stampPageCrc(page);
    expect(parseHeaderPage(page, PAGE_SIZE)).toEqual(h);
    expect(readHeaderFields(page)).toEqual(h);

    expect(codeOf(() => parseHeaderPage(page, 100))).toBe('NOT_A_DATABASE');
    const badMagic = Uint8Array.from(page);
    badMagic[FH_MAGIC] = 0;
    expect(codeOf(() => parseHeaderPage(badMagic, PAGE_SIZE))).toBe('NOT_A_DATABASE');
    const badVersion = Uint8Array.from(page);
    writeU16(badVersion, FH_FORMAT_VERSION, 2);
    stampPageCrc(badVersion);
    expect(codeOf(() => parseHeaderPage(badVersion, PAGE_SIZE))).toBe('UNSUPPORTED_FORMAT_VERSION');
    const badSize = Uint8Array.from(page);
    writeU16(badSize, FH_PAGE_SIZE, 8192);
    stampPageCrc(badSize);
    expect(codeOf(() => parseHeaderPage(badSize, PAGE_SIZE))).toBe('UNSUPPORTED_FORMAT_VERSION');
    const badCrc = Uint8Array.from(page);
    badCrc[100] = 1;
    expect(codeOf(() => parseHeaderPage(badCrc, PAGE_SIZE))).toBe('PAGE_CHECKSUM_MISMATCH');
    expect(codeOf(() => parseHeaderPage(new Uint8Array(PAGE_SIZE), PAGE_SIZE))).toBe('NOT_A_DATABASE');
  });
});
