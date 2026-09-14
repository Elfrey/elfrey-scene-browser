/**
 * Little-endian integer helpers for the LevelDB on-disk formats.
 * All readers return [value, nextOffset] so they can be chained without a cursor object.
 */

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {[number, number]}
 */
export function readVarint32(bytes, offset) {
  let result = 0;
  let shift = 0;
  while ( shift <= 28 ) {
    const b = bytes[offset++];
    if ( b === undefined ) throw new RangeError("varint32 runs past the end of the buffer");
    result |= (b & 0x7f) << shift;
    if ( !(b & 0x80) ) return [result >>> 0, offset];
    shift += 7;
  }
  throw new Error("malformed varint32");
}

/**
 * Values are returned as Numbers; LevelDB sequence numbers, file numbers and sizes fit in 2^53.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {[number, number]}
 */
export function readVarint64(bytes, offset) {
  let result = 0;
  let multiplier = 1;
  for ( let i = 0; i < 10; i++ ) {
    const b = bytes[offset++];
    if ( b === undefined ) throw new RangeError("varint64 runs past the end of the buffer");
    result += (b & 0x7f) * multiplier;
    if ( !(b & 0x80) ) return [result, offset];
    multiplier *= 128;
  }
  throw new Error("malformed varint64");
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
export function readFixed32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
export function readFixed64(bytes, offset) {
  return readFixed32(bytes, offset + 4) * 4294967296 + readFixed32(bytes, offset);
}

/**
 * Read a varint32 length followed by that many bytes (a "Slice" in LevelDB terms).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {[Uint8Array, number]}
 */
export function readLengthPrefixed(bytes, offset) {
  const [length, start] = readVarint32(bytes, offset);
  const end = start + length;
  if ( end > bytes.length ) throw new RangeError("length-prefixed slice runs past the end of the buffer");
  return [bytes.subarray(start, end), end];
}
