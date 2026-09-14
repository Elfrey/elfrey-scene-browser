/**
 * CRC32C (Castagnoli) as used by LevelDB, including its "masked" form stored on disk.
 */

const TABLE = new Uint32Array(256);
for ( let n = 0; n < 256; n++ ) {
  let c = n;
  for ( let k = 0; k < 8; k++ ) c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
  TABLE[n] = c >>> 0;
}

/**
 * CRC32C of bytes[start, end). Pass a previous result as `crc` to extend it (LevelDB's crc32c::Extend).
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @param {number} [crc]
 * @returns {number}
 */
export function crc32c(bytes, start = 0, end = bytes.length, crc = 0) {
  let c = (crc ^ 0xFFFFFFFF) >>> 0;
  for ( let i = start; i < end; i++ ) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const MASK_DELTA = 0xa282ead8;

/** @param {number} crc */
export function maskCrc(crc) {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + MASK_DELTA) >>> 0;
}

/** @param {number} masked */
export function unmaskCrc(masked) {
  const rot = (masked - MASK_DELTA) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}
