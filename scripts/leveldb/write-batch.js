/**
 * A write-ahead log record is a WriteBatch: 8-byte sequence, 4-byte count, then `count` operations.
 */
import { readFixed32, readFixed64, readLengthPrefixed } from "./varint.js";

export const OP_DELETE = 0;
export const OP_PUT = 1;

/**
 * @param {Uint8Array} record
 * @returns {{key: Uint8Array, value: Uint8Array|null, type: number, seq: number}[]}
 */
export function parseWriteBatch(record) {
  if ( record.length < 12 ) throw new Error("write batch: header too short");
  const sequence = readFixed64(record, 0);
  const count = readFixed32(record, 8);
  let pos = 12;
  const entries = [];
  for ( let i = 0; i < count; i++ ) {
    const type = record[pos++];
    let key;
    let value = null;
    [key, pos] = readLengthPrefixed(record, pos);
    if ( type === OP_PUT ) [value, pos] = readLengthPrefixed(record, pos);
    else if ( type !== OP_DELETE ) throw new Error(`write batch: unknown operation type ${type}`);
    entries.push({ key, value, type, seq: sequence + i });
  }
  return entries;
}
