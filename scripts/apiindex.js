/**
 * In-app indexing of *connected* compendium packs via the Foundry API (pack.getDocuments()).
 *
 * On Foundry v14 the server does not serve pack database files to the browser, so the file reader can't see
 * disabled modules. But a connected (enabled) pack is fully readable over the socket: getDocuments() returns
 * complete Scene documents (with tokens/walls), and complete Adventure documents (with embedded scenes and
 * actors). This module reads them, resolves the actors a scene's tokens need, and writes the same cache the
 * external tools/build-cache.mjs produces — including full-scene documents so the scenes stay importable after
 * the module is disabled again.
 *
 * Full-scene documents are written into a per-run versioned subfolder (scenes/<collection>/<ts>/…), because the
 * server won't let the client overwrite existing files; the summary entry records that path in `scenesPath`.
 */
import { summarizeScene, summarizeFolder } from "./leveldb/summary.js";
import { safeName } from "./cache.js";
import { CF_TEMP_NAME } from "./leveldb/pack-reader.js";

/** Package version for a pack, from the installed package list. */
function packageInfo(pack) {
  const type = pack.metadata.packageType;
  const id = pack.metadata.packageName;
  let pkg = null;
  if ( type === "module" ) pkg = game.modules.get(id);
  else if ( type === "system" ) pkg = game.system;
  else if ( type === "world" ) pkg = game.world;
  return { type, id, title: pkg?.title ?? id, version: String(pkg?.version ?? "") };
}

/** Distinct non-null token actorIds referenced by a scene document. */
function tokenActorIds(scene) {
  const ids = new Set();
  for ( const tok of scene.tokens ?? [] ) {
    const id = tok?.actorId ?? tok?.delta?._id;
    if ( id ) ids.add(id);
  }
  return ids;
}

/**
 * Index a set of connected packs and write them to the cache.
 * @param {string[]} collections
 * @param {import("./cache.js").SceneCache} cache
 * @param {object} [options]
 * @param {(p: object) => void} [options.onProgress]
 * @returns {Promise<object[]>}  Per-pack result summaries
 */
export async function apiIndexPacks(collections, cache, { onProgress } = {}) {
  const results = [];
  const actorPackCache = new Map();   // packageId → Map(actorId → rawActor)
  let done = 0;

  for ( const collection of collections ) {
    const pack = game.packs.get(collection);
    onProgress?.({ phase: "reading", collection, label: pack?.metadata?.label ?? collection, done, total: collections.length });
    try {
      if ( !pack ) throw new Error(game.i18n.localize("ESB.Errors.PackNotConnected"));
      const entry = await indexOnePack(pack, cache, actorPackCache);
      results.push({ collection, status: "ok", scenes: entry.scenes.length, label: entry.label, packageTitle: entry.package.title });
    } catch ( err ) {
      console.error("elfrey-scene-browser |", err);
      results.push({ collection, status: "error", error: err?.message ?? String(err), label: pack?.metadata?.label ?? collection, packageTitle: pack?.metadata?.packageName ?? "" });
    }
    done++;
    onProgress?.({ phase: "written", collection, done, total: collections.length });
  }
  return results;
}

async function indexOnePack(pack, cache, actorPackCache) {
  const pkg = packageInfo(pack);
  const isAdventure = pack.metadata.type === "Adventure";
  const docs = await pack.getDocuments();

  const rawScenes = [];
  const folders = [];
  const actorsById = new Map();

  if ( isAdventure ) {
    for ( const advDoc of docs ) {
      const adv = advDoc.toObject();
      const tag = { id: adv._id, name: adv.name ?? "" };
      for ( const sc of adv.scenes ?? [] ) {
        if ( !sc || sc.name === CF_TEMP_NAME ) continue;
        sc.__adv = tag;
        rawScenes.push(sc);
      }
      for ( const f of adv.folders ?? [] ) { if ( f?.type === "Scene" ) { f.__adv = tag; folders.push(f); } }
      for ( const a of adv.actors ?? [] ) if ( a?._id ) actorsById.set(a._id, a);
    }
  } else {
    for ( const doc of docs ) {
      const raw = doc.toObject();
      if ( raw.name === CF_TEMP_NAME ) continue;
      rawScenes.push(raw);
    }
    for ( const folder of pack.folders ?? [] ) folders.push(folder.toObject());
  }

  // Resolve token actors not bundled in an adventure from Actor compendium(s): the package's own first,
  // then any other enabled Actor pack (for adventures that reference a companion bestiary).
  const needed = new Set();
  for ( const sc of rawScenes ) for ( const id of tokenActorIds(sc) ) if ( !actorsById.has(id) ) needed.add(id);
  if ( needed.size ) {
    await resolveActors(needed, actorsById, pkg.id, actorPackCache);
  }

  // Write full-scene documents (and their actors) into a per-run versioned folder.
  const ts = Date.now();
  const scenesRel = `scenes/${safeName(pack.collection)}/${ts}`;
  const scenesDir = `${cache.dir}/${scenesRel}`;
  for ( const sc of rawScenes ) {
    if ( !sc._id ) continue;
    const doc = { ...sc };
    delete doc.__adv;
    await cache.uploadInto(scenesDir, `${safeName(sc._id)}.json`, JSON.stringify(doc));
    const ids = tokenActorIds(sc);
    const actors = [...ids].map(id => actorsById.get(id)).filter(Boolean).map(a => { const c = { ...a }; delete c.__adv; return c; });
    if ( actors.length ) await cache.uploadInto(scenesDir, `${safeName(sc._id)}.actors.json`, JSON.stringify(actors));
  }

  const entry = {
    collection: pack.collection,
    package: pkg,
    label: pack.metadata.label ?? pack.metadata.name,
    path: `${{ module: "modules", system: "systems", world: "worlds" }[pkg.type]}/${pkg.id}/packs/${pack.metadata.name}`,
    strategy: "files",   // full data available; treated like a file read (counts/flags present)
    status: "ok",
    error: null,
    scannedAt: new Date().toISOString(),
    coreVersion: game.version,
    signature: { api: true, version: pkg.version },
    scenesPath: scenesRel,
    folders: folders.map(summarizeFolder),
    scenes: rawScenes.map(s => summarizeScene(s)),
    warnings: []
  };
  await cache.write(entry);
  return entry;
}

/** Fill `actorsById` for the needed ids from the package's own Actor compendium packs. */
async function resolveActors(needed, actorsById, packageId, actorPackCache) {
  for ( const pack of game.packs ) {
    if ( pack.metadata.type !== "Actor" || pack.metadata.packageName !== packageId ) continue;
    if ( ![...needed].some(id => !actorsById.has(id)) ) break;
    let map = actorPackCache.get(pack.collection);
    if ( !map ) {
      map = new Map();
      try { for ( const doc of await pack.getDocuments() ) map.set(doc.id, doc.toObject()); }
      catch ( err ) { console.warn("elfrey-scene-browser | actor pack read failed:", pack.collection, err); }
      actorPackCache.set(pack.collection, map);
    }
    for ( const id of needed ) { const a = map.get(id); if ( a ) actorsById.set(id, a); }
  }
}
