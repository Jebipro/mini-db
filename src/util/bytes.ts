/** Lexicographic byte comparison; a strict prefix sorts first (DC-28, D.6). */
export function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}

export function readU16(buf: Uint8Array, off: number): number {
  return ((buf[off] as number) | ((buf[off + 1] as number) << 8)) >>> 0;
}

export function writeU16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
}

export function readU32(buf: Uint8Array, off: number): number {
  return (
    ((buf[off] as number) |
      ((buf[off + 1] as number) << 8) |
      ((buf[off + 2] as number) << 16) |
      ((buf[off + 3] as number) << 24)) >>>
    0
  );
}

export function writeU32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

export function toHex(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}
