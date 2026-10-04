import { LimitError } from '../errors/errors.js';
import type { ColumnType, Value } from '../record/value.js';
import { compareRid, type Rid } from '../record/value.js';
import { compareBytes } from '../util/bytes.js';
import { MAX_KEY_BYTES } from '../util/limits.js';
import { encodeUtf8 } from '../util/utf8.js';

/**
 * memcmp-ordered key encoding (D.6): INTEGER = 8-byte big-endian with the sign bit flipped,
 * BOOLEAN = 0x00/0x01, TEXT = raw UTF-8 (≤ 512 bytes). NULL is never encoded (DC-28).
 */
export function encodeKey(type: ColumnType, v: Exclude<Value, null>): Uint8Array {
  switch (type) {
    case 'INTEGER': {
      const out = new Uint8Array(8);
      const u = BigInt.asUintN(64, BigInt(v as number)) ^ (1n << 63n);
      new DataView(out.buffer).setBigUint64(0, u, false);
      return out;
    }
    case 'BOOLEAN':
      return Uint8Array.of(v ? 1 : 0);
    case 'TEXT': {
      const b = encodeUtf8(v as string);
      if (b.length > MAX_KEY_BYTES) throw new LimitError('KEY_TOO_LARGE', `index key is ${b.length} bytes (max ${MAX_KEY_BYTES})`);
      return b;
    }
  }
}

export interface Entry {
  key: Uint8Array;
  rid: Rid;
}

/** The single entry comparator (DC-28): key bytes first; the RID breaks ties only in non-unique indexes. */
export function compareEntry(a: Entry, b: Entry, unique: boolean): -1 | 0 | 1 {
  const c = compareBytes(a.key, b.key);
  if (c !== 0 || unique) return c;
  return compareRid(a.rid, b.rid);
}
