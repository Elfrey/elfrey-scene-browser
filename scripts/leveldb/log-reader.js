/**
 * LevelDB log format (used by NNNNNN.log write-ahead logs and by MANIFEST-NNNNNN files):
 * 32 KiB blocks of records, each with a 7-byte header: masked CRC32C (4), length (2), type (1).
 * Records longer than the remaining block space are split into FIRST / MIDDLE / LAST fragments.
 */
import { readFixed32 } from "./varint.js";
import { crc32c, unmaskCrc } from "./crc32c.js";

export const BLOCK_SIZE = 32768;
const HEADER_SIZE = 7;
const TYPE_ZERO = 0;
const TYPE_FULL = 1;
const TYPE_FIRST = 2;
const TYPE_MIDDLE = 3;
const TYPE_LAST = 4;

function concat(parts) {
  let total = 0;
  for ( const p of parts ) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for ( const p of parts ) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Iterate over the logical records of a log file.
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {boolean} [options.verify=true]        Verify record checksums
 * @param {(message: string) => void} [options.onWarning]
 * @yields {Uint8Array}
 */
export function* readLogRecords(bytes, { verify = true, onWarning } = {}) {
  let pos = 0;
  const parts = [];
  while ( pos + HEADER_SIZE <= bytes.length ) {
    const remaining = BLOCK_SIZE - (pos % BLOCK_SIZE);
    if ( remaining < HEADER_SIZE ) {
      pos += remaining; // trailer padding
      continue;
    }
    const storedCrc = readFixed32(bytes, pos);
    const length = bytes[pos + 4] | (bytes[pos + 5] << 8);
    const type = bytes[pos + 6];
    const start = pos + HEADER_SIZE;
    const end = start + length;
    if ( end > bytes.length ) {
      onWarning?.(`log: truncated record at offset ${pos}`);
      break;
    }
    if ( (type === TYPE_ZERO) && (length === 0) ) {
      pos = end; // pre-allocated zeroed space
      continue;
    }
    pos = end;
    if ( verify ) {
      const actual = crc32c(bytes, start, end, crc32c(bytes, start - 1, start));
      if ( unmaskCrc(storedCrc) !== actual ) {
        onWarning?.(`log: checksum mismatch at offset ${start - HEADER_SIZE}`);
        parts.length = 0;
        continue;
      }
    }
    const data = bytes.subarray(start, end);
    switch ( type ) {
      case TYPE_FULL:
        parts.length = 0;
        yield data;
        break;
      case TYPE_FIRST:
        parts.length = 0;
        parts.push(data);
        break;
      case TYPE_MIDDLE:
        if ( parts.length ) parts.push(data);
        else onWarning?.(`log: orphan MIDDLE fragment at offset ${start - HEADER_SIZE}`);
        break;
      case TYPE_LAST:
        if ( parts.length ) {
          parts.push(data);
          yield concat(parts);
          parts.length = 0;
        }
        else onWarning?.(`log: orphan LAST fragment at offset ${start - HEADER_SIZE}`);
        break;
      default:
        onWarning?.(`log: unknown record type ${type} at offset ${start - HEADER_SIZE}`);
        parts.length = 0;
    }
  }
}
