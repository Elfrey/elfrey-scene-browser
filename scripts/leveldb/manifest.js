/**
 * MANIFEST-NNNNNN: a log of VersionEdit records describing which table files are live.
 */
import { readLogRecords } from "./log-reader.js";
import { readLengthPrefixed, readVarint32, readVarint64 } from "./varint.js";

const TAG_COMPARATOR = 1;
const TAG_LOG_NUMBER = 2;
const TAG_NEXT_FILE_NUMBER = 3;
const TAG_LAST_SEQUENCE = 4;
const TAG_COMPACT_POINTER = 5;
const TAG_DELETED_FILE = 6;
const TAG_NEW_FILE = 7;
const TAG_PREV_LOG_NUMBER = 9;

const decoder = new TextDecoder();

/**
 * @typedef {object} ManifestState
 * @property {string|null} comparator
 * @property {number} logNumber
 * @property {number} prevLogNumber
 * @property {number} nextFileNumber
 * @property {number} lastSequence
 * @property {Map<number, {level: number, number: number, size: number}>} files  Live table files by number
 */

/**
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {boolean} [options.verify]
 * @param {(message: string) => void} [options.onWarning]
 * @returns {ManifestState}
 */
export function parseManifest(bytes, options = {}) {
  const state = { comparator: null, logNumber: 0, prevLogNumber: 0, nextFileNumber: 0, lastSequence: 0, files: new Map() };
  for ( const record of readLogRecords(bytes, options) ) {
    let pos = 0;
    while ( pos < record.length ) {
      let tag;
      [tag, pos] = readVarint32(record, pos);
      switch ( tag ) {
        case TAG_COMPARATOR: {
          let name;
          [name, pos] = readLengthPrefixed(record, pos);
          state.comparator = decoder.decode(name);
          break;
        }
        case TAG_LOG_NUMBER:
          [state.logNumber, pos] = readVarint64(record, pos);
          break;
        case TAG_NEXT_FILE_NUMBER:
          [state.nextFileNumber, pos] = readVarint64(record, pos);
          break;
        case TAG_LAST_SEQUENCE:
          [state.lastSequence, pos] = readVarint64(record, pos);
          break;
        case TAG_COMPACT_POINTER: {
          [, pos] = readVarint32(record, pos);
          [, pos] = readLengthPrefixed(record, pos);
          break;
        }
        case TAG_DELETED_FILE: {
          let number;
          [, pos] = readVarint32(record, pos);
          [number, pos] = readVarint64(record, pos);
          state.files.delete(number);
          break;
        }
        case TAG_NEW_FILE: {
          let level;
          let number;
          let size;
          [level, pos] = readVarint32(record, pos);
          [number, pos] = readVarint64(record, pos);
          [size, pos] = readVarint64(record, pos);
          [, pos] = readLengthPrefixed(record, pos); // smallest key
          [, pos] = readLengthPrefixed(record, pos); // largest key
          state.files.set(number, { level, number, size });
          break;
        }
        case TAG_PREV_LOG_NUMBER:
          [state.prevLogNumber, pos] = readVarint64(record, pos);
          break;
        default:
          throw new Error(`manifest: unknown VersionEdit tag ${tag}`);
      }
    }
  }
  return state;
}

/**
 * LevelDB file name for a file number.
 * @param {number} number
 * @param {"ldb"|"log"|"sst"} ext
 */
export function fileName(number, ext) {
  return `${String(number).padStart(6, "0")}.${ext}`;
}
