/**
 * Snappy block decompression (the only compression LevelDB/classic-level applies to table blocks).
 * Format: varint uncompressed length, then a sequence of literal and copy elements.
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function snappyUncompress(input) {
  let pos = 0;
  let length = 0;
  let shift = 0;
  let b;
  do {
    b = input[pos++];
    if ( b === undefined ) throw new Error("snappy: truncated preamble");
    length |= (b & 0x7f) << shift;
    shift += 7;
  } while ( b & 0x80 );
  length >>>= 0;

  const out = new Uint8Array(length);
  let op = 0;
  while ( pos < input.length ) {
    const tag = input[pos++];
    const type = tag & 3;
    if ( type === 0 ) {
      let n = tag >>> 2;
      if ( n >= 60 ) {
        const extra = n - 59;
        n = 0;
        for ( let i = 0; i < extra; i++ ) n |= input[pos++] << (8 * i);
        n >>>= 0;
      }
      n += 1;
      if ( pos + n > input.length || op + n > length ) throw new Error("snappy: literal overruns buffer");
      out.set(input.subarray(pos, pos + n), op);
      pos += n;
      op += n;
      continue;
    }
    let n;
    let offset;
    if ( type === 1 ) {
      n = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | input[pos++];
    }
    else if ( type === 2 ) {
      n = (tag >>> 2) + 1;
      offset = input[pos] | (input[pos + 1] << 8);
      pos += 2;
    }
    else {
      n = (tag >>> 2) + 1;
      offset = (input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16) | (input[pos + 3] << 24)) >>> 0;
      pos += 4;
    }
    if ( offset === 0 || offset > op ) throw new Error("snappy: invalid copy offset");
    if ( op + n > length ) throw new Error("snappy: copy overruns buffer");
    let src = op - offset;
    if ( offset >= n ) {
      out.copyWithin(op, src, src + n);
      op += n;
    }
    else {
      // Overlapping copy replicates the pattern byte by byte.
      for ( let i = 0; i < n; i++ ) out[op++] = out[src++];
    }
  }
  if ( op !== length ) throw new Error(`snappy: produced ${op} bytes, expected ${length}`);
  return out;
}
