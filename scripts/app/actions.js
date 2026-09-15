/**
 * Actions on a scene record: open, import (from live packs or by re-reading a dormant pack), show in
 * compendium, open the image, copy identifiers. Each returns a promise and shows its own notifications.
 */
import { MODULE_ID, SETTINGS, getSetting, warn } from "../settings.js";
import { PackWorker } from "../indexer.js";
import { assetUrl } from "../model.js";
import { SceneCache, safeName, dataRoute } from "../cache.js";

const notify = {
  info: (k, d) => ui.notifications.info(game.i18n.format(k, d ?? {})),
  warn: (k, d) => ui.notifications.warn(game.i18n.format(k, d ?? {})),
  error: (k, d) => ui.notifications.error(game.i18n.format(k, d ?? {}))
};

/**
 * Ensure a chain of nested Scene folders exists, creating what is missing, and return the leaf folder id.
 * The chain is capped at CONST.FOLDER_MAX_DEPTH; deeper names are dropped.
 * @param {string[]} names   Folder names from the root down (empty/falsy entries are skipped)
 * @returns {Promise<string|null>}
 */
export async function ensureFolderPath(names) {
  const chain = (names ?? []).map(n => String(n ?? "").trim()).filter(Boolean).slice(0, CONST.FOLDER_MAX_DEPTH);
  let parentId = null;
  for ( const name of chain ) {
    let folder = game.folders.find(f => f.type === "Scene" && f.name === name && (f.folder?.id ?? null) === parentId);
    if ( !folder ) folder = await Folder.create({ name, type: "Scene", folder: parentId });
    parentId = folder?.id ?? parentId;
  }
  return parentId;
}

/** The configured root import folder name, or "" when none. */
export function importRootName() {
  return (getSetting(SETTINGS.importFolder) || "").trim();
}

/** Full scene JSON for a dormant (uncached-source) scene by re-reading just its pack. */
async function readDormantScene(rec) {
  // Preferred source: a complete scene document pre-built by tools/build-cache.mjs --full-scenes.
  // This is a plain JSON file, so it loads even on Foundry v14 where the server blocks pack database files.
  const prebuilt = await fetchPrebuiltScene(rec);
  if ( prebuilt ) return prebuilt;

  // On Foundry v14 the server blocks pack files, so without a prebuilt document there is nothing to read.
  if ( Number(game.version?.split(".")[0]) >= 14 ) throw new Error(game.i18n.localize("ESB.Errors.NeedFullScenes"));

  // Fallback (Foundry v13): read the pack files directly over HTTP.
  const worker = new PackWorker();
  try {
    const result = await worker.read(
      { path: packPathFromCollection(rec), files: null, bust: Date.now(), verify: true, embed: [rec.sceneId], includeActors: true },
      {}
    );
    const scene = (result.fullScenes ?? []).find(s => s._id === rec.sceneId);
    if ( !scene ) throw new Error(game.i18n.localize("ESB.Errors.SceneNotFound"));
    return { scene, actors: result.actors ?? [] };
  } finally {
    worker.terminate();
  }
}

/** Fetch a scene document (and its actor sidecar) pre-built into the cache folder, or null if not there. */
async function fetchPrebuiltScene(rec) {
  const dir = SceneCache.configuredDir;
  const sceneDir = rec.scenesPath ? `${dir}/${rec.scenesPath}` : `${dir}/scenes/${safeName(rec.packCollection)}`;
  const base = `${sceneDir}/${safeName(rec.sceneId)}`;
  let scene;
  try {
    const response = await fetch(dataRoute(`${base}.json`), { cache: "no-store", credentials: "same-origin" });
    if ( !response.ok ) return null;
    scene = await response.json();
  } catch ( err ) {
    warn(`prebuilt scene fetch failed for ${rec.packCollection}/${rec.sceneId}: ${err.message}`);
    return null;
  }
  let actors = [];
  try {
    const response = await fetch(dataRoute(`${base}.actors.json`), { cache: "no-store", credentials: "same-origin" });
    if ( response.ok ) actors = await response.json();
  } catch ( err ) { /* no actor sidecar: import the scene without linked actors */ }
  return { scene, actors };
}

/**
 * Create the actor documents a scene's tokens need, preserving their ids so tokens resolve.
 * Existing actors (same id) are left as-is. Returns the number of actors created.
 * @param {object[]} actors  Full actor documents
 */
async function importSceneActors(actors) {
  if ( !actors?.length ) return 0;
  const toCreate = [];
  for ( const raw of actors ) {
    if ( !raw?._id || game.actors.has(raw._id) ) continue;
    const doc = foundry.utils.deepClone(raw);
    delete doc.__adv;
    if ( "ownership" in doc ) doc.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
    toCreate.push(doc);
  }
  if ( !toCreate.length ) return 0;
  const folder = await ensureActorFolder();
  if ( folder ) for ( const d of toCreate ) d.folder = folder;
  try {
    const created = await Actor.createDocuments(toCreate, { keepId: true });
    return created?.length ?? 0;
  } catch ( err ) {
    console.error(`${MODULE_ID} |`, err);
    return 0;
  }
}

/** Ensure an Actor folder (named like the import root) exists; returns its id or null. */
async function ensureActorFolder() {
  const name = importRootName();
  if ( !name ) return null;
  const existing = game.folders.find(f => f.type === "Actor" && f.name === name);
  if ( existing ) return existing.id;
  const folder = await Folder.create({ name, type: "Actor" });
  return folder?.id ?? null;
}

/** Data-relative pack path for a record (dormant packs are addressed by their known layout). */
function packPathFromCollection(rec) {
  const source = game.modules.get("elfrey-scene-browser").api.listScenePackSources().find(s => s.collection === rec.packCollection);
  if ( !source ) throw new Error(`Unknown pack ${rec.packCollection}`);
  return source.path;
}

/** Strip fields the way WorldCollection#fromCompendium does, and tag the source. */
function prepareImportData(raw, rec) {
  const data = foundry.utils.deepClone(raw);
  delete data._id;
  delete data.sort;
  delete data.active;
  delete data.__adv;   // internal tag added by the pack reader for adventure scenes
  if ( "ownership" in data ) data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
  if ( rec.uuid ) foundry.utils.setProperty(data, "_stats.compendiumSource", rec.uuid);
  return data;
}

/**
 * Import a scene into the world.
 * @param {object} rec
 * @param {object} [options] { activate: boolean }
 * @returns {Promise<Scene|null>}
 */
export async function importScene(rec, { activate = false, folderPath = null } = {}) {
  const folder = await ensureFolderPath(folderPath ?? [importRootName()]);
  let created = null;
  try {
    if ( rec.uuid && rec.uuid.startsWith("Compendium.") ) {
      const pack = game.packs.get(rec.packCollection);
      if ( pack ) created = await game.scenes.importFromCompendium(pack, rec.sceneId, folder ? { folder } : {});
    }
    if ( !created ) {
      // Dormant module (or world-less source): read the full document (and the actors its tokens need), then create.
      notify.info("ESB.Notices.ReadingPack", { label: rec.packLabel });
      const { scene: raw, actors } = await readDormantScene(rec);
      const importedActors = await importSceneActors(actors);
      const data = prepareImportData(raw, rec);
      if ( folder ) data.folder = folder;
      created = await Scene.create(data);
      if ( importedActors ) notify.info("ESB.Notices.ImportedActors", { count: importedActors });
    }
  } catch ( err ) {
    console.error(`${MODULE_ID} |`, err);
    if ( err?.message === game.i18n.localize("ESB.Errors.NeedFullScenes") ) notify.warn("ESB.Errors.NeedFullScenes");
    else notify.error("ESB.Errors.ImportFailed", { error: err.message });
    return null;
  }
  if ( !created ) return null;
  notify.info("ESB.Notices.Imported", { name: created.name });
  if ( activate ) await created.view();
  return created;
}

/** View a world scene (draw it on the canvas). */
export async function viewScene(rec) {
  const scene = game.scenes.get(rec.sceneId);
  if ( scene ) return scene.view();
  return importScene(rec, { activate: true });
}

/** Activate a world scene for all players. */
export async function activateScene(rec) {
  const scene = game.scenes.get(rec.sceneId);
  if ( scene ) return scene.activate();
}

/** Open the compendium containing a live pack scene and reveal the entry. */
export async function showInCompendium(rec) {
  const pack = game.packs.get(rec.packCollection);
  if ( !pack ) { notify.warn("ESB.Errors.PackNotConnected"); return; }
  await pack.render(true);
}

/** Show the scene's background (or thumbnail) in an image popout. */
export function openImage(rec) {
  const src = rec.bg || rec.thumb;
  if ( !src ) { notify.warn("ESB.Errors.NoImage"); return; }
  new foundry.applications.apps.ImagePopout({ src, window: { title: rec.name }, uuid: rec.uuid ?? null }).render(true);
}

export async function copyText(text, messageKey = "ESB.Notices.Copied") {
  try {
    await game.clipboard.copyPlainText(text);
    notify.info(messageKey);
  } catch ( err ) {
    warn("clipboard failed", err);
  }
}

/** Drag payload for dropping a scene onto the sidebar (only when addressable by UUID). */
export function dragData(rec) {
  if ( !rec.uuid ) return null;
  return { type: "Scene", uuid: rec.uuid };
}
