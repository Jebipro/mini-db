import { CorruptionError } from '../errors/errors.js';
import { readU32, writeU32 } from '../util/bytes.js';
import { crc32 } from '../util/crc32.js';
import { isPageType, PAGE_SIZE, PH_CRC, PH_PAGE_ID, PH_TYPE, type PageType } from './layout.js';

const ZERO4 = new Uint8Array(4);

/** Page CRC (DC-08): CRC32 over all 4096 bytes with the CRC field [4, 8) taken as zero. */
export function computePageCrc(page: Uint8Array): number {
  let c = crc32(page, 0, 0, PH_CRC);
  c = crc32(ZERO4, c);
  return crc32(page, c, PH_CRC + 4, PAGE_SIZE);
}

export function stampPageCrc(page: Uint8Array): void {
  writeU32(page, PH_CRC, computePageCrc(page));
}

export function pageTypeOf(page: Uint8Array): number {
  return page[PH_TYPE] as number;
}

export function pageIdOf(page: Uint8Array): number {
  return readU32(page, PH_PAGE_ID);
}

/** Zero the page and write the common header (D.1). The CRC is stamped when the page is written out. */
export function initPage(page: Uint8Array, type: PageType, pageId: number): void {
  page.fill(0);
  page[PH_TYPE] = type;
  writeU32(page, PH_PAGE_ID, pageId);
}

/** Physical-read verification (D.1): CRC → pageId → pageType. */
export function verifyPage(page: Uint8Array, expectedId: number, source: string): PageType {
  if (readU32(page, PH_CRC) !== computePageCrc(page)) {
    throw new CorruptionError('PAGE_CHECKSUM_MISMATCH', `page ${expectedId} checksum mismatch (${source})`);
  }
  const id = pageIdOf(page);
  if (id !== expectedId) {
    throw new CorruptionError('PAGE_ID_MISMATCH', `page ${expectedId} stores page id ${id} (${source})`);
  }
  const t = pageTypeOf(page);
  if (!isPageType(t)) throw new CorruptionError('PAGE_TYPE_INVALID', `page ${expectedId} has unknown type ${t} (${source})`);
  return t;
}

/** Throws PAGE_TYPE_MISMATCH when a pointer reaches a page of the wrong kind. */
export function expectPageType(page: Uint8Array, pageId: number, ...allowed: PageType[]): PageType {
  const t = pageTypeOf(page);
  if (!allowed.includes(t as PageType)) {
    throw new CorruptionError('PAGE_TYPE_MISMATCH', `page ${pageId} has type ${t}, expected ${allowed.join('/')}`);
  }
  return t as PageType;
}
