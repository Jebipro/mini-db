import { CorruptionError } from '../errors/errors.js';
import { readU16, readU32, writeU16, writeU32 } from '../util/bytes.js';
import {
  DB_ID_SIZE,
  FH_CATALOG_ROOT,
  FH_DB_ID,
  FH_FORMAT_VERSION,
  FH_FREELIST_COUNT,
  FH_FREELIST_HEAD,
  FH_MAGIC,
  FH_PAGE_COUNT,
  FH_PAGE_SIZE,
  FORMAT_VERSION,
  MAGIC,
  PAGE_SIZE,
  PageType,
} from './layout.js';
import { initPage, pageTypeOf, verifyPage } from './page.js';

/** D.2 file header fields. */
export interface FileHeader {
  pageCount: number;
  freelistHead: number;
  freelistCount: number;
  catalogRoot: number;
  dbId: Uint8Array;
}

/** Formats page 0 from scratch (magic, version, page size, fields). */
export function initHeaderPage(page: Uint8Array, h: FileHeader): void {
  initPage(page, PageType.HEADER, 0);
  page.set(MAGIC, FH_MAGIC);
  writeU16(page, FH_FORMAT_VERSION, FORMAT_VERSION);
  writeU16(page, FH_PAGE_SIZE, PAGE_SIZE);
  writeHeaderFields(page, h);
}

export function writeHeaderFields(page: Uint8Array, h: FileHeader): void {
  writeU32(page, FH_PAGE_COUNT, h.pageCount);
  writeU32(page, FH_FREELIST_HEAD, h.freelistHead);
  writeU32(page, FH_FREELIST_COUNT, h.freelistCount);
  writeU32(page, FH_CATALOG_ROOT, h.catalogRoot);
  page.set(h.dbId.subarray(0, DB_ID_SIZE), FH_DB_ID);
}

export function readHeaderFields(page: Uint8Array): FileHeader {
  return {
    pageCount: readU32(page, FH_PAGE_COUNT),
    freelistHead: readU32(page, FH_FREELIST_HEAD),
    freelistCount: readU32(page, FH_FREELIST_COUNT),
    catalogRoot: readU32(page, FH_CATALOG_ROOT),
    dbId: Uint8Array.from(page.subarray(FH_DB_ID, FH_DB_ID + DB_ID_SIZE)),
  };
}

/**
 * Validates a raw page-0 image read from the data file (D.2 order):
 * magic → formatVersion → pageSize → CRC/pageId/type → pageCount ≥ 1.
 * `bytesRead` < 4096 means the file is too short to be a database.
 */
export function parseHeaderPage(page: Uint8Array, bytesRead: number): FileHeader {
  if (bytesRead < PAGE_SIZE) throw new CorruptionError('NOT_A_DATABASE', `file is ${bytesRead} bytes, smaller than one page`);
  for (let i = 0; i < MAGIC.length; i++) {
    if (page[FH_MAGIC + i] !== MAGIC[i]) throw new CorruptionError('NOT_A_DATABASE', 'magic mismatch: not a Mini DB file');
  }
  const version = readU16(page, FH_FORMAT_VERSION);
  if (version !== FORMAT_VERSION) throw new CorruptionError('UNSUPPORTED_FORMAT_VERSION', `format version ${version} is not supported`);
  const pageSize = readU16(page, FH_PAGE_SIZE);
  if (pageSize !== PAGE_SIZE) throw new CorruptionError('UNSUPPORTED_FORMAT_VERSION', `page size ${pageSize} is not supported`);
  verifyPage(page, 0, 'data file');
  if (pageTypeOf(page) !== PageType.HEADER) throw new CorruptionError('PAGE_TYPE_MISMATCH', 'page 0 is not a header page');
  const h = readHeaderFields(page);
  if (h.pageCount < 1) throw new CorruptionError('NOT_A_DATABASE', `invalid page count ${h.pageCount}`);
  return h;
}
