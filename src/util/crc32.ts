/**
 * CRC-32/IEEE (DC-08): reflected polynomial 0xEDB88320, init 0xFFFFFFFF, final xor 0xFFFFFFFF.
 * `crc32(b, crc32(a))` equals `crc32(a ‖ b)`, which the WAL checksum chain and page CRCs rely on.
 */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, previous = 0, start = 0, end = data.length): number {
  let c = ~previous >>> 0;
  for (let i = start; i < end; i++) c = (TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}
