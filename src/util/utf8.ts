import { compareBytes } from './bytes.js';

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** UTF-8 encoding. Callers must have rejected lone surrogates first (see hasLoneSurrogate). */
export function encodeUtf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8 decoding; returns null on malformed input. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Number of UTF-8 bytes of a well-formed string. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * Text ordering = UTF-8 byte order = code point order (DC-39).
 * JS `<` compares UTF-16 code units and must not be used for TEXT.
 */
export function compareText(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return compareBytes(encodeUtf8(a), encodeUtf8(b));
}
