/**
 * Reduce raw Scene / Folder documents to the compact records kept in the cache (PLAN.md §2.6).
 * Understands the legacy (v9–v10) field names found in older packs.
 */

export const COUNTED_COLLECTIONS = ["tokens", "walls", "lights", "notes", "tiles", "sounds", "drawings", "regions", "templates"];

/**
 * @param {object} doc      Raw Scene document
 * @param {Record<string, number>|null} [embeddedCounts]   Counts from LevelDB keys (see pack-reader). Pass an object
 *   (possibly empty) when the pack stores embedded documents under their own keys — those counts are then
 *   authoritative even if the scene JSON still carries stale inline arrays. Pass null for packs without keyed
 *   embedded documents; inline arrays are counted instead.
 */
export function summarizeScene(doc, embeddedCounts = null) {
  const grid = (doc.grid && typeof doc.grid === "object")
    ? { type: doc.grid.type ?? null, size: doc.grid.size ?? null, distance: doc.grid.distance ?? null, units: doc.grid.units ?? null }
    : { type: doc.gridType ?? null, size: typeof doc.grid === "number" ? doc.grid : null, distance: doc.gridDistance ?? null, units: doc.gridUnits ?? null };
  const counts = {};
  const keyed = embeddedCounts && !doc.__adv;
  for ( const c of COUNTED_COLLECTIONS ) {
    if ( keyed ) counts[c] = embeddedCounts[c] ?? 0;
    else counts[c] = Array.isArray(doc[c]) ? doc[c].length : 0;
  }
  const thumb = typeof doc.thumb === "string" && doc.thumb && !doc.thumb.startsWith("data:") ? doc.thumb : null;
  const bg = doc.background?.src ?? (typeof doc.img === "string" && doc.img ? doc.img : null) ?? null;
  return {
    _id: doc._id,
    name: doc.name ?? "",
    navName: doc.navName ?? "",
    thumb,
    bg: typeof bg === "string" && !bg.startsWith("data:") ? bg : null,
    w: doc.width ?? null,
    h: doc.height ?? null,
    grid,
    folder: doc.folder ?? null,
    sort: doc.sort ?? 0,
    counts,
    flags: Object.keys(doc.flags ?? {}),
    system: doc._stats?.systemId ?? null,
    core: doc._stats?.coreVersion ?? null,
    modified: doc._stats?.modifiedTime ?? null,
    advId: doc.__adv?.id ?? null,
    advName: doc.__adv?.name ?? null
  };
}

/** @param {object} doc  Raw Folder document */
export function summarizeFolder(doc) {
  return {
    _id: doc._id,
    name: doc.name ?? "",
    folder: doc.folder ?? null,
    sort: doc.sort ?? 0,
    color: typeof doc.color === "string" ? doc.color : (doc.color?.css ?? null),
    advId: doc.__adv?.id ?? null
  };
}

/**
 * Counts argument for summarizeScene given the pack-level counts map from readScenePack.
 * @param {Map<string, Record<string, number>>} counts
 * @param {string} sceneId
 */
export function countsFor(counts, sceneId) {
  if ( !counts.size ) return null;
  return counts.get(sceneId) ?? {};
}

/**
 * Compact record from a live compendium index entry (packs read through the Foundry API).
 * Embedded counts and flags are not available that way and are recorded as unknown (null).
 * @param {object} entry
 */
export function summarizeIndexEntry(entry) {
  const summary = summarizeScene(entry, null);
  summary.counts = null;
  summary.flags = null;
  return summary;
}
