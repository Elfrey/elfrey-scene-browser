/**
 * LevelDB sorted table (NNNNNN.ldb) reader.
 * Footer (48 bytes) → index block → data blocks; blocks carry a 5-byte trailer (compression type + masked CRC32C);
 * entries inside a block use prefix-compressed keys with restart points. Table keys are internal keys:
 * user key followed by 8 bytes of (sequence << 8 | type).
 */
import { readFixed32, readVarint32, readVarint64 } from "./varint.js";
import { crc32c, unmaskCrc } from "./crc32c.js";
import { snappyUncompress } from "./snappy.js";

const FOOTER_SIZE = 48;
const MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];
const COMPRESSION_NONE = 0;
const COMPRESSION_SNAPPY = 1;

/**
 * Decode one block (data or index) at [offset, offset + size), checking and stripping its trailer.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} size
 * @param {boolean} verify
 * @param {(message: string) => void} [onWarning]
 * @returns {Uint8Array}
 */
function readBlock(bytes, offset, size, verify, onWarning) {
  if ( offset + size + 5 > bytes.length ) throw new Error("table: block handle points past the end of the file");
  const type = bytes[offset + size];
  if ( verify ) {
    const stored = readFixed32(bytes, offset + size + 1);
    const actual = crc32c(bytes, offset, offset + size + 1);
    if ( unmaskCrc(stored) !== actual ) onWarning?.(`table: block checksum mismatch at offset ${offset}`);
  }
  const raw = bytes.subarray(offset, offset + size);
  if ( type === COMPRESSION_NONE ) return raw;
  if ( type === COMPRESSION_SNAPPY ) return snappyUncompress(raw);
  throw new Error(`table: unsupported block compression type ${type}`);
}

/**
 * Iterate the key/value entries of a decoded block in order.
 * @param {Uint8Array} block
 * @yields {{key: Uint8Array, value: Uint8Array}}
 */
function* iterateBlock(block) {
  if ( block.length < 4 ) return;
  const numRestarts = readFixed32(block, block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  if ( end < 0 ) throw new Error("table: corrupt restart array");
  let pos = 0;
  let prevKey = new Uint8Array(0);
  while ( pos < end ) {
    let shared;
    let nonShared;
    let valueLength;
    [shared, pos] = readVarint32(block, pos);
    [nonShared, pos] = readVarint32(block, pos);
    [valueLength, pos] = readVarint32(block, pos);
    if ( shared > prevKey.length ) throw new Error("table: corrupt shared key prefix");
    const key = new Uint8Array(shared + nonShared);
    key.set(prevKey.subarray(0, shared), 0);
    key.set(block.subarray(pos, pos + nonShared), shared);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLength);
    pos += valueLength;
    yield { key, value };
    prevKey = key;
  }
}

/**
 * Iterate every entry of a table file.
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {boolean} [options.verify=true]
 * @param {(message: string) => void} [options.onWarning]
 * @yields {{key: Uint8Array, value: Uint8Array, type: number, seq: number}}  key is the user key
 */
export function* readTableEntries(bytes, { verify = true, onWarning } = {}) {
  if ( bytes.length < FOOTER_SIZE ) throw new Error("table: file shorter than its footer");
  for ( let i = 0; i < 8; i++ ) {
    if ( bytes[bytes.length - 8 + i] !== MAGIC[i] ) throw new Error("table: bad magic number");
  }
  let pos = bytes.length - FOOTER_SIZE;
  let indexOffset;
  let indexSize;
  [, pos] = readVarint64(bytes, pos); // metaindex offset
  [, pos] = readVarint64(bytes, pos); // metaindex size
  [indexOffset, pos] = readVarint64(bytes, pos);
  [indexSize] = readVarint64(bytes, pos);

  const index = readBlock(bytes, indexOffset, indexSize, verify, onWarning);
  for ( const { value: handle } of iterateBlock(index) ) {
    let offset;
    let size;
    let p = 0;
    [offset, p] = readVarint64(handle, p);
    [size] = readVarint64(handle, p);
    const block = readBlock(bytes, offset, size, verify, onWarning);
    for ( const { key: internalKey, value } of iterateBlock(block) ) {
      const n = internalKey.length - 8;
      if ( n < 0 ) throw new Error("table: internal key shorter than 8 bytes");
      const type = internalKey[n];
      const seq = internalKey[n + 1] + internalKey[n + 2] * 0x100 + internalKey[n + 3] * 0x10000
        + internalKey[n + 4] * 0x1000000 + internalKey[n + 5] * 0x100000000 + internalKey[n + 6] * 0x10000000000
        + internalKey[n + 7] * 0x1000000000000;
      yield { key: internalKey.subarray(0, n), value, type, seq };
    }
  }
}
