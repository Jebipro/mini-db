import { invariant } from '../errors/assert.js';
import { CorruptionError, LimitError } from '../errors/errors.js';
import { readU16, writeU16 } from '../util/bytes.js';
import { decodeUtf8Strict, encodeUtf8 } from '../util/utf8.js';
import { MAX_COLUMNS, MAX_ROW_BYTES, MAX_TEXT_BYTES } from '../storage/layout.js';
import type { ColumnType, Value } from './value.js';

/**
 * Row encoding (D.4): u8 columnCount, null bitmap ⌈n/8⌉ bytes (bit i = NULL, LSB first),
 * then non-null fields in column order: INTEGER i64 LE, BOOLEAN u8 0/1, TEXT u16 LE length + UTF-8.
 */

function bitmapBytes(n: number): number {
  return (n + 7) >> 3;
}

/** Encoded size, or throws for oversized TEXT. */
function encodeFields(types: readonly ColumnType[], values: readonly Value[]): { size: number; texts: Array<Uint8Array | null> } {
  invariant(types.length === values.length && types.length >= 1 && types.length <= MAX_COLUMNS, 'row arity mismatch');
  let size = 1 + bitmapBytes(types.length);
  const texts: Array<Uint8Array | null> = [];
  types.forEach((t, i) => {
    const v = values[i] as Value;
    texts.push(null);
    if (v === null) return;
    switch (t) {
      case 'INTEGER':
        invariant(typeof v === 'number' && Number.isSafeInteger(v), `column ${i}: expected a safe integer`);
        size += 8;
        break;
      case 'BOOLEAN':
        invariant(typeof v === 'boolean', `column ${i}: expected a boolean`);
        size += 1;
        break;
      case 'TEXT': {
        invariant(typeof v === 'string', `column ${i}: expected text`);
        const b = encodeUtf8(v);
        if (b.length > MAX_TEXT_BYTES) throw new LimitError('TEXT_TOO_LARGE', `text value is ${b.length} bytes (max ${MAX_TEXT_BYTES})`);
        texts[i] = b;
        size += 2 + b.length;
        break;
      }
    }
  });
  return { size, texts };
}

export function encodedRowSize(types: readonly ColumnType[], values: readonly Value[]): number {
  return encodeFields(types, values).size;
}

export function encodeRow(types: readonly ColumnType[], values: readonly Value[]): Uint8Array {
  const { size, texts } = encodeFields(types, values);
  if (size > MAX_ROW_BYTES) throw new LimitError('ROW_TOO_LARGE', `row is ${size} bytes encoded (max ${MAX_ROW_BYTES})`);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = types.length;
  let pos = 1 + bitmapBytes(types.length);
  types.forEach((t, i) => {
    const v = values[i] as Value;
    if (v === null) {
      out[1 + (i >> 3)] = (out[1 + (i >> 3)] as number) | (1 << (i & 7));
      return;
    }
    switch (t) {
      case 'INTEGER':
        view.setBigInt64(pos, BigInt(v as number), true);
        pos += 8;
        break;
      case 'BOOLEAN':
        out[pos++] = v ? 1 : 0;
        break;
      case 'TEXT': {
        const b = texts[i] as Uint8Array;
        writeU16(out, pos, b.length);
        out.set(b, pos + 2);
        pos += 2 + b.length;
        break;
      }
    }
  });
  return out;
}

function malformed(why: string): CorruptionError {
  return new CorruptionError('RECORD_MALFORMED', `malformed record: ${why}`);
}

export function decodeRow(types: readonly ColumnType[], bytes: Uint8Array): Value[] {
  const n = types.length;
  if (bytes.length < 1 || bytes[0] !== n) throw malformed(`column count ${bytes[0]} != ${n}`);
  const bm = bitmapBytes(n);
  if (bytes.length < 1 + bm) throw malformed('truncated null bitmap');
  const lastBits = n & 7;
  if (lastBits !== 0 && ((bytes[bm] as number) >> lastBits) !== 0) throw malformed('unused null-bitmap bits set');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 1 + bm;
  const out: Value[] = [];
  for (let i = 0; i < n; i++) {
    if (((bytes[1 + (i >> 3)] as number) >> (i & 7)) & 1) {
      out.push(null);
      continue;
    }
    switch (types[i] as ColumnType) {
      case 'INTEGER': {
        if (pos + 8 > bytes.length) throw malformed('truncated integer');
        const big = view.getBigInt64(pos, true);
        if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) throw malformed('integer outside the safe range');
        out.push(Number(big));
        pos += 8;
        break;
      }
      case 'BOOLEAN': {
        if (pos + 1 > bytes.length) throw malformed('truncated boolean');
        const b = bytes[pos] as number;
        if (b > 1) throw malformed(`boolean byte ${b}`);
        out.push(b === 1);
        pos += 1;
        break;
      }
      case 'TEXT': {
        if (pos + 2 > bytes.length) throw malformed('truncated text length');
        const len = readU16(bytes, pos);
        if (len > MAX_TEXT_BYTES || pos + 2 + len > bytes.length) throw malformed('text length out of range');
        const s = decodeUtf8Strict(bytes.subarray(pos + 2, pos + 2 + len));
        if (s === null) throw malformed('invalid UTF-8');
        out.push(s);
        pos += 2 + len;
        break;
      }
    }
  }
  if (pos !== bytes.length) throw malformed(`${bytes.length - pos} trailing bytes`);
  return out;
}
