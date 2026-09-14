#!/usr/bin/env node
/**
 * Elfrey Scene Browser — cache builder.
 *
 * Reads the Scene and Adventure compendium packs of a Foundry data directory straight from their LevelDB
 * files and writes the module's cache, so the browser can list scenes from modules that are disabled — the
 * main use on Foundry v14, where the server does not serve pack files to the client. Works on v13 too.
 *
 * Uses only the module's own pure-JS reader (scripts/leveldb): no native modules, no `classic-level`, no
 * `npm install`, and it does not lock the databases — so it runs while the world is up (active or inactive
 * modules alike). Run it with any Node.js:
 *
 *   node tools/build-cache.mjs --data /path/to/your/foundry-data-dir
 *
 * Options:
 *   --data <dir>   Foundry data directory (the one that contains "Data/"). Required. May be repeated.
 *   --out <name>   Cache folder name inside Data/ (default: elfrey-scene-browser). Match the module's
 *                  "Cache folder" setting if you changed it.
 *   --full         Re-read every pack, ignoring the "unchanged since last run" check.
 *   --full-scenes  Also write the complete document of every scene to <out>/scenes/<pack>/<id>.json, so the
 *                  browser can import scenes from disabled modules on Foundry v14 (where it cannot read pack
 *                  files itself). Costs disk space (roughly the size of the packs) and more RAM while running.
 *   --quiet        Only print the final summary.
 *
 * After it finishes, open the Scene Browser and press "Refresh" (the round arrow) to reload the cache.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readScenePack } from "../scripts/leveldb/pack-reader.js";
import { summarizeScene, summarizeFolder, countsFor } from "../scripts/leveldb/summary.js";

const CACHE_SCHEMA = 1;                                   // mirrors scripts/cache.js
const safeName = c => c.replace(/[^A-Za-z0-9._-]/g, "_"); // mirrors scripts/cache.js
const PACKAGE_DIRS = { module: "modules", system: "systems", world: "worlds" };
const decoder = new TextDecoder();

/* ------------------------------- args ------------------------------- */

const argv = process.argv.slice(2);
const dataDirs = [];
let outName = "elfrey-scene-browser";
let full = false, quiet = false, fullScenes = false;
for ( let i = 0; i < argv.length; i++ ) {
  const a = argv[i];
  if ( a === "--data" ) dataDirs.push(argv[++i]);
  else if ( a === "--out" ) outName = argv[++i];
  else if ( a === "--full" ) full = true;
  else if ( a === "--full-scenes" ) fullScenes = true;
  else if ( a === "--quiet" ) quiet = true;
  else if ( a === "-h" || a === "--help" ) { usage(); process.exit(0); }
  else { console.error(`Unknown argument: ${a}`); usage(); process.exit(2); }
}
function usage() {
  console.log("Usage: node tools/build-cache.mjs --data /path/to/foundry-data [--out <cacheFolder>] [--full] [--full-scenes] [--quiet]");
}
if ( !dataDirs.length ) { usage(); process.exit(2); }

const log = (...a) => { if ( !quiet ) console.log(...a); };

/* --------------------------- enumerate packs --------------------------- */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Foundry version of the install sitting next to the data dir, or null. */
function detectCoreVersion(dataDir) {
  const parent = path.dirname(path.resolve(dataDir));
  for ( const name of (fs.existsSync(parent) ? fs.readdirSync(parent) : []) ) {
    if ( !/^fvtt/.test(name) ) continue;
    const pkg = readJson(path.join(parent, name, "package.json"));
    if ( pkg?.version ) return pkg.version;
  }
  return null;
}

function packFullPath(packageType, pkgId, pack) {
  const raw = (pack.path || "").replace(/\.db$/, "").replace(/^\/+|\/+$/g, "");
  if ( /^(modules|systems|worlds)\//.test(raw) ) return raw;
  return `${PACKAGE_DIRS[packageType]}/${pkgId}/${raw || `packs/${pack.name}`}`;
}

function listPacks(dataDir) {
  const out = [];
  const roots = [["modules", "module.json", "module"], ["systems", "system.json", "system"], ["worlds", "world.json", "world"]];
  for ( const [dir, manifestName, packageType] of roots ) {
    const base = path.join(dataDir, "Data", dir);
    if ( !fs.existsSync(base) ) continue;
    for ( const id of fs.readdirSync(base).sort() ) {
      const manifest = readJson(path.join(base, id, manifestName));
      if ( !manifest ) continue;
      const pkgId = manifest.id ?? id;
      for ( const pack of manifest.packs ?? [] ) {
        const type = pack.type ?? pack.entity;
        if ( type !== "Scene" && type !== "Adventure" ) continue;
        const full = packFullPath(packageType, pkgId, pack);
        out.push({
          collection: pack.id ?? `${packageType === "world" ? "world" : pkgId}.${pack.name}`,
          packageType, packageId: pkgId,
          packageTitle: manifest.title ?? pkgId,
          packageVersion: String(manifest.version ?? ""),
          label: pack.label ?? pack.name,
          path: full,
          dir: path.join(dataDir, "Data", full)
        });
      }
    }
  }
  return out;
}

/* ------------------------------ signatures ------------------------------ */

/** Cheap signature from disk: CURRENT contents + every file name→size. */
function signatureOf(dir) {
  const files = {};
  let manifest = null;
  for ( const name of fs.readdirSync(dir) ) {
    if ( name === "LOCK" ) continue;
    const st = fs.statSync(path.join(dir, name));
    if ( !st.isFile() ) continue;
    files[name] = st.size;
    if ( name === "CURRENT" ) {
      try { manifest = fs.readFileSync(path.join(dir, name), "utf8").trim(); } catch {}
    }
  }
  return { manifest, files };
}

function signaturesEqual(a, b) {
  if ( !a || !b || a.manifest !== b.manifest ) return false;
  const ka = Object.keys(a.files ?? {}), kb = Object.keys(b.files ?? {});
  return ka.length === kb.length && ka.every(k => a.files[k] === b.files[k]);
}

/* ------------------------------ cache dir ------------------------------ */

async function loadExisting(packsDir) {
  const map = new Map();   // collection → { file, ts, signature, packageVersion, status }
  const stale = [];
  if ( !fs.existsSync(packsDir) ) return { map, stale };
  const re = /^(.+)\.(\d{13})\.json$/;
  const newest = new Map();
  for ( const name of fs.readdirSync(packsDir) ) {
    const m = re.exec(name);
    if ( !m ) continue;
    const ts = Number(m[2]);
    const prev = newest.get(m[1]);
    if ( !prev || ts > prev.ts ) { if ( prev ) stale.push(prev.name); newest.set(m[1], { name, ts }); }
    else stale.push(name);
  }
  for ( const [, { name, ts }] of newest ) {
    const entry = readJson(path.join(packsDir, name));
    if ( entry?.collection ) map.set(entry.collection, { file: name, ts, signature: entry.signature, packageVersion: entry.package?.version, status: entry.status });
  }
  return { map, stale };
}

/* -------------------------------- main -------------------------------- */

/** Write the complete document of each scene to scenes/<collection>/<sceneId>.json (for v14 import). */
async function writeFullScenes(scenesDir, collection, rawScenes) {
  const dir = path.join(scenesDir, safeName(collection));
  await fsp.rm(dir, { recursive: true, force: true });   // rebuild fresh (scenes may have been removed)
  await fsp.mkdir(dir, { recursive: true });
  for ( const raw of rawScenes ) {
    if ( !raw?._id ) continue;
    const doc = { ...raw };
    delete doc.__adv;   // internal tag added by the reader
    await fsp.writeFile(path.join(dir, `${safeName(raw._id)}.json`), JSON.stringify(doc));
  }
}

let grand = { packs: 0, read: 0, unchanged: 0, missing: 0, errors: 0, scenes: 0, removed: 0 };

for ( const dataDir of dataDirs ) {
  const resolved = path.resolve(dataDir);
  if ( !fs.existsSync(path.join(resolved, "Data")) ) {
    console.error(`Skipping "${dataDir}": no Data/ subdirectory found.`);
    continue;
  }
  const coreVersion = detectCoreVersion(resolved);
  const packsDir = path.join(resolved, "Data", outName, "packs");
  const scenesDir = path.join(resolved, "Data", outName, "scenes");
  const { map: existing, stale } = await loadExisting(packsDir);
  const packs = listPacks(resolved);
  log(`\n== ${resolved}  (core ${coreVersion ?? "?"}) — ${packs.length} Scene/Adventure packs`);

  await fsp.mkdir(packsDir, { recursive: true });

  // Remove superseded duplicate files left by earlier runs.
  for ( const name of stale ) {
    try { await fsp.unlink(path.join(packsDir, name)); grand.removed++; } catch {}
  }

  for ( const pack of packs ) {
    grand.packs++;
    if ( !fs.existsSync(pack.dir) ) { grand.missing++; log(`  --      ${pack.collection}: no directory on disk`); continue; }

    let signature;
    try { signature = signatureOf(pack.dir); } catch ( err ) { signature = null; }
    const prev = existing.get(pack.collection);
    const scenesOk = !fullScenes || fs.existsSync(path.join(scenesDir, safeName(pack.collection)));
    if ( !full && prev && prev.status === "ok" && prev.packageVersion === pack.packageVersion && signaturesEqual(prev.signature, signature) && scenesOk ) {
      grand.unchanged++;
      log(`  ok      ${pack.collection}: unchanged`);
      continue;
    }

    const source = {
      list: async () => fsp.readdir(pack.dir),
      read: async name => new Uint8Array(await fsp.readFile(path.join(pack.dir, name)))
    };
    let entry;
    try {
      const result = await readScenePack(source, { verify: true, embed: fullScenes });
      const scenes = result.scenes.map(s => summarizeScene(s, countsFor(result.counts, s._id)));
      if ( fullScenes ) await writeFullScenes(scenesDir, pack.collection, result.scenes);
      entry = {
        schema: CACHE_SCHEMA,
        collection: pack.collection,
        package: { type: pack.packageType, id: pack.packageId, title: pack.packageTitle, version: pack.packageVersion },
        label: pack.label,
        path: pack.path,
        strategy: "files",
        status: "ok",
        error: null,
        scannedAt: new Date().toISOString(),
        coreVersion,
        signature,
        folders: result.folders.map(summarizeFolder),
        scenes,
        warnings: result.warnings.slice(0, 20)
      };
      grand.read++;
      grand.scenes += scenes.length;
      log(`  read    ${pack.collection}: ${scenes.length} scenes, ${entry.folders.length} folders${entry.warnings.length ? `, ${entry.warnings.length} warnings` : ""}`);
    } catch ( err ) {
      entry = {
        schema: CACHE_SCHEMA, collection: pack.collection,
        package: { type: pack.packageType, id: pack.packageId, title: pack.packageTitle, version: pack.packageVersion },
        label: pack.label, path: pack.path, strategy: "files", status: "error",
        error: err?.message ?? String(err), scannedAt: new Date().toISOString(), coreVersion,
        signature, folders: [], scenes: [], warnings: []
      };
      grand.errors++;
      console.error(`  ERROR   ${pack.collection}: ${entry.error}`);
    }

    // Write the new versioned file, then drop the previous current one for this collection.
    const ts = Date.now();
    const file = `${safeName(pack.collection)}.${ts}.json`;
    await fsp.writeFile(path.join(packsDir, file), JSON.stringify(entry));
    if ( prev?.file && prev.file !== file ) {
      try { await fsp.unlink(path.join(packsDir, prev.file)); grand.removed++; } catch {}
    }
  }
}

console.log(`\nDone: read ${grand.read}, unchanged ${grand.unchanged}, missing ${grand.missing}, errors ${grand.errors}; ${grand.scenes} scenes; ${grand.removed} old cache files removed.`);
if ( !quiet ) console.log(`Open the Scene Browser and press Refresh to load the updated cache.`);
process.exit(grand.errors ? 1 : 0);
