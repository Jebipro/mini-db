/**
 * The single source of on-disk offsets and engine-wide limits (FORMAT.md D.0–D.9, C.2 limits).
 * Every other module refers to these names; no magic numbers elsewhere.
 */

export const PAGE_SIZE = 4096;

// D.1 common page header (all pages)
export const PH_TYPE = 0;
export const PH_FLAGS = 1;
export const PH_CRC = 4;
export const PH_PAGE_ID = 8;
export const PAGE_HEADER_SIZE = 16;

export const PageType = {
  HEADER: 1,
  HEAP: 2,
  BTREE_INTERNAL: 3,
  BTREE_LEAF: 4,
  FREE: 5,
} as const;
export type PageType = (typeof PageType)[keyof typeof PageType];

export function isPageType(v: number): v is PageType {
  return v >= 1 && v <= 5;
}

// D.2 file header (page 0)
export const FH_MAGIC = 16;
export const FH_FORMAT_VERSION = 24;
export const FH_PAGE_SIZE = 26;
export const FH_PAGE_COUNT = 28;
export const FH_FREELIST_HEAD = 32;
export const FH_FREELIST_COUNT = 36;
export const FH_CATALOG_ROOT = 40;
export const FH_DB_ID = 48;
export const DB_ID_SIZE = 8;
export const MAGIC = Uint8Array.of(0x4d, 0x49, 0x4e, 0x49, 0x44, 0x42, 0x00, 0x00); // "MINIDB\0\0"
export const FORMAT_VERSION = 1;

// D.3 heap page
export const HP_SLOT_COUNT = 16;
export const HP_RECORD_START = 18;
export const HP_NEXT_PAGE = 20;
export const HP_TAIL_PAGE = 24;
export const HP_FRAGMENTED = 28;
export const HP_SLOT_DIR = 32;
export const HP_SLOT_SIZE = 4;

// D.5 free page
export const FP_NEXT_FREE = 16;

// D.6 B+tree node
export const BT_CELL_COUNT = 16;
export const BT_CELL_START = 18;
export const BT_RIGHT_PTR = 20;
export const BT_FRAGMENTED = 24;
export const BT_CELL_PTRS = 32;
export const BT_PTR_SIZE = 2;

// D.8 WAL
export const WAL_MAGIC = Uint8Array.of(0x4d, 0x44, 0x42, 0x57); // "MDBW"
export const WAL_VERSION = 1;
export const WH_MAGIC = 0;
export const WH_VERSION = 4;
export const WH_PAGE_SIZE = 8;
export const WH_CHECKPOINT_SEQ = 12;
export const WH_DB_ID = 16;
export const WH_SALT1 = 24;
export const WH_SALT2 = 28;
export const WH_CRC = 44;
export const WAL_HEADER_SIZE = 48;
export const WF_PAGE_ID = 0;
export const WF_FLAGS = 4;
export const WF_SALT1 = 8;
export const WF_SALT2 = 12;
export const WF_CHECKSUM = 16;
export const WF_RESERVED = 20;
export const WAL_FRAME_HEADER_SIZE = 24;
export const WAL_FRAME_SIZE = WAL_FRAME_HEADER_SIZE + PAGE_SIZE; // 4120
export const WAL_FLAG_COMMIT = 1;

export function walFrameOffset(frameNo: number): number {
  return WAL_HEADER_SIZE + WAL_FRAME_SIZE * frameNo;
}

// C.2 limits
export const MAX_ROW_BYTES = PAGE_SIZE - HP_SLOT_DIR - HP_SLOT_SIZE; // 4060
export { MAX_KEY_BYTES, MAX_TEXT_BYTES, MAX_COLUMNS, MAX_IDENTIFIER_BYTES, MAX_SAFE } from '../util/limits.js';

// C.2 cache / WAL defaults
export const DEFAULT_CACHE_PAGES = 2048;
export const MIN_CACHE_PAGES = 64;
export const MAX_CACHE_PAGES = 1_048_576;
export const DIRTY_RESERVE_PAGES = 32;
export const DEFAULT_WAL_AUTOCHECKPOINT_FRAMES = 1000;

/** Catalog heap head page (D.7). */
export const CATALOG_ROOT_PAGE = 1;
