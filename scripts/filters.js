/**
 * Pure filtering and sorting for scene records. Filters return true when a record passes.
 * Unknown data (e.g. counts from an API-only pack, or missing dimensions) fails a filter that needs it.
 */

/** Largest side of a scene in grid cells, or null when it cannot be computed. */
export function cellsMax(rec) {
  const size = rec.grid?.size;
  if ( !size || !rec.w || !rec.h ) return null;
  return Math.max(rec.w, rec.h) / size;
}

/** Grid family from the numeric grid type (Foundry: 0 gridless, 1 square, 2–5 hex). */
export function gridFamily(rec) {
  const t = rec.grid?.type;
  if ( t === 0 || t === null || t === undefined ) return "gridless";
  if ( t === 1 ) return "square";
  return "hex";
}

export const SIZE_BUCKETS = {
  s: [0, 20], m: [20, 40], l: [40, 80], xl: [80, Infinity]
};

/**
 * @param {object} rec
 * @param {object} f   { status, grid, size, content, system }
 */
export function passes(rec, f) {
  if ( f.status ) {
    if ( f.status === "world" && rec.origin !== "world" ) return false;
    if ( f.status === "active" && (rec.origin === "world" || !rec.active) ) return false;
    if ( f.status === "inactive" && rec.active ) return false;
  }
  if ( f.grid && gridFamily(rec) !== f.grid ) return false;
  if ( f.size ) {
    const c = cellsMax(rec);
    if ( c === null ) return false;
    const [lo, hi] = SIZE_BUCKETS[f.size] ?? [0, Infinity];
    if ( !(c > lo && c <= hi) ) return false;
  }
  if ( f.content ) {
    if ( !rec.counts ) return false;
    if ( !(rec.counts[f.content] > 0) ) return false;
  }
  if ( f.system ) {
    if ( f.system === "__none__" ) { if ( rec.system ) return false; }
    else if ( rec.system !== f.system ) return false;
  }
  return true;
}

export function anyActive(f) {
  return !!(f.status || f.grid || f.size || f.content || f.system);
}

const collator = () => new Intl.Collator(game.i18n.lang);

/** Comparator for a sort key. */
export function comparator(sort) {
  const col = collator();
  switch ( sort ) {
    case "package": return (a, b) => col.compare(a.packageTitle, b.packageTitle) || col.compare(a.packLabel, b.packLabel) || col.compare(a.name, b.name);
    case "size": return (a, b) => ((b.w ?? 0) * (b.h ?? 0)) - ((a.w ?? 0) * (a.h ?? 0)) || col.compare(a.name, b.name);
    case "modified": return (a, b) => (b.modified ?? 0) - (a.modified ?? 0) || col.compare(a.name, b.name);
    case "walls": return (a, b) => ((b.counts?.walls ?? -1)) - ((a.counts?.walls ?? -1)) || col.compare(a.name, b.name);
    case "name":
    default: return (a, b) => col.compare(a.name, b.name);
  }
}

/** Distinct system ids present in the model, sorted. */
export function systemsIn(scenes) {
  const set = new Set();
  let hasNone = false;
  for ( const s of scenes ) { if ( s.system ) set.add(s.system); else hasNone = true; }
  const list = [...set].sort();
  return { systems: list, hasNone };
}
