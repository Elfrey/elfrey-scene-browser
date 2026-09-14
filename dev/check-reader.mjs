#!/usr/bin/env node
/**
 * Developer self-check for scripts/leveldb: read every Scene pack of a Foundry data folder with our reader
 * and with classic-level (taken from the Foundry install), then compare scenes, folders and embedded counts.
 * Not part of the module at runtime.
 *
 *   node dev/check-reader.mjs --data /path/to/data-v13 [--foundry /path/to/fvtt13] [--only <packageId>]
 *                             [--copy-locked] [--no-verify] [--limit N] [--embed]
 *
 * Packs held open by a running world cannot be opened by classic-level; with --copy-locked they are
 * copied to a temporary folder for the reference read (our reader always reads the originals in place).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readScenePack, parseEmbeddedKey, SCENE_PREFIX, FOLDER_PREFIX } from "../scripts/leveldb/pack-reader.js";
import { summarizeScene, summarizeFolder, countsFor } from "../scripts/leveldb/summary.js";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const flag = name => args.includes(name);

const dataPath = opt("--data");
if ( !dataPath ) {
  console.error("usage: node dev/check-reader.mjs --data /path/to/data-vNN [--foundry /path/to/fvttNN] [--only id] [--copy-locked] [--no-verify] [--limit N] [--embed]");
  process.exit(2);
}
const only = opt("--only");
const limit = Number(opt("--limit", 0)) || 0;
const copyLocked = flag("--copy-locked");
const verify = !flag("--no-verify");
const embed = flag("--embed");

/* ---------------------------------- locate classic-level ---------------------------------- */

function findFoundry() {
  const explicit = opt("--foundry") ?? process.env.FOUNDRY_APP;
  const candidates = explicit ? [explicit] : [];
  const parent = path.dirname(path.resolve(dataPath));
  for ( const name of fs.readdirSync(parent) ) if ( /^fvtt\d+$/.test(name) ) candidates.push(path.join(parent, name));
  for ( const c of candidates ) {
    if ( fs.existsSync(path.join(c, "node_modules", "classic-level", "package.json")) ) return c;
  }
  return null;
}
const foundry = findFoundry();
if ( !foundry ) {
  console.error("classic-level not found; pass --foundry /path/to/foundry-app (the folder containing node_modules)");
  process.exit(2);
}
const { ClassicLevel } = createRequire(pathToFileURL(path.join(foundry, "package.json")))("classic-level");

/* ---------------------------------- enumerate packs ---------------------------------- */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function listPacks() {
  const out = [];
  const roots = [["modules", "module.json"], ["systems", "system.json"], ["worlds", "world.json"]];
  for ( const [dir, manifestName] of roots ) {
    const base = path.join(dataPath, "Data", dir);
    if ( !fs.existsSync(base) ) continue;
    for ( const id of fs.readdirSync(base).sort() ) {
      const manifest = readJson(path.join(base, id, manifestName));
      if ( !manifest ) continue;
      if ( only && manifest.id !== only && id !== only ) continue;
      for ( const p of manifest.packs ?? [] ) {
        const type = p.type ?? p.entity;
        if ( type !== "Scene" && type !== "Adventure" ) continue;
        const rel = (p.path || `packs/${p.name}`).replace(/\.db$/, "");
        out.push({ id: `${manifest.id ?? id}.${p.name}`, dir: path.join(base, id, rel), adventure: type === "Adventure" });
      }
    }
  }
  return limit ? out.slice(0, limit) : out;
}

/* ---------------------------------- reference read ---------------------------------- */

async function referenceRead(dir) {
  const db = new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "buffer", createIfMissing: false });
  try {
    await db.open();
  } catch ( err ) {
    const code = err.cause?.code ?? err.code;
    if ( code === "LEVEL_LOCKED" ) return { locked: true };
    throw err;
  }
  const scenes = new Map();
  const folders = new Map();
  const counts = new Map();
  try {
    for await ( const [key, value] of db.iterator() ) {
      if ( key.startsWith(SCENE_PREFIX) ) {
        const doc = JSON.parse(value.toString("utf8"));
        if ( doc.name === "#[CF_tempEntity]" ) continue;
        doc._id ??= key.slice(SCENE_PREFIX.length);
        scenes.set(doc._id, doc);
      }
      else if ( key.startsWith(FOLDER_PREFIX) ) {
        const doc = JSON.parse(value.toString("utf8"));
        doc._id ??= key.slice(FOLDER_PREFIX.length);
        folders.set(doc._id, doc);
      }
      else if ( key.startsWith("!scenes.") ) {
        const parsed = parseEmbeddedKey(key);
        if ( !parsed ) continue;
        let c = counts.get(parsed.sceneId);
        if ( !c ) counts.set(parsed.sceneId, c = {});
        c[parsed.collection] = (c[parsed.collection] ?? 0) + 1;
      }
      else if ( key.startsWith("!adventures!") ) {
        const adv = JSON.parse(value.toString("utf8"));
        const tag = { id: adv._id ?? key.slice("!adventures!".length), name: adv.name ?? "" };
        for ( const sc of adv.scenes ?? [] ) {
          if ( !sc?._id || sc.name === "#[CF_tempEntity]" ) continue;
          sc.__adv = tag;
          scenes.set(sc._id, sc);
          // Adventure scenes carry inline embedded arrays; the reader counts those in summarizeScene, not in the
          // counts map. Leave them out of the reference counts map to match (the summary comparison covers counts).
        }
        for ( const f of adv.folders ?? [] ) if ( f?.type === "Scene" && f._id ) { f.__adv = tag; folders.set(f._id, f); }
      }
    }
  } finally {
    await db.close();
  }
  for ( const id of counts.keys() ) if ( !scenes.has(id) ) counts.delete(id);
  return { scenes, folders, counts };
}

async function copyDir(src) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "esb-pack-"));
  await fsp.cp(src, tmp, { recursive: true });
  return tmp;
}

/* ---------------------------------- compare ---------------------------------- */

function stableStringify(value) {
  return JSON.stringify(value, (k, v) => (v && typeof v === "object" && !Array.isArray(v)) ? Object.fromEntries(Object.entries(v).sort()) : v);
}

function compare(ours, ref) {
  const problems = [];
  const ourScenes = new Map(ours.scenes.map(s => [s._id, s]));
  for ( const id of ref.scenes.keys() ) if ( !ourScenes.has(id) ) problems.push(`missing scene ${id}`);
  for ( const id of ourScenes.keys() ) if ( !ref.scenes.has(id) ) problems.push(`extra scene ${id}`);
  for ( const [id, refDoc] of ref.scenes ) {
    const ourDoc = ourScenes.get(id);
    if ( !ourDoc ) continue;
    const a = stableStringify(summarizeScene(ourDoc, countsFor(ours.counts, id)));
    const b = stableStringify(summarizeScene(refDoc, countsFor(ref.counts, id)));
    if ( a !== b ) problems.push(`scene ${id} differs:\n      ours ${a.slice(0, 300)}\n      ref  ${b.slice(0, 300)}`);
    if ( !embed ) {
      const strip = d => { const c = { ...d }; delete c.__adv; return c; };
      const rawA = stableStringify(strip(ourDoc));
      const rawB = stableStringify(strip(refDoc));
      if ( rawA !== rawB ) problems.push(`scene ${id} raw JSON differs (${rawA.length} vs ${rawB.length} chars)`);
    }
    else {
      // Attached embedded documents must match the keyed counts exactly and carry unique ids.
      for ( const [collection, n] of Object.entries(ref.counts.get(id) ?? {}) ) {
        if ( collection.includes(".") ) continue;
        const list = Array.isArray(ourDoc[collection]) ? ourDoc[collection] : [];
        const ids = new Set(list.map(d => d?._id));
        if ( (list.length !== n) || (ids.size !== n) ) problems.push(`scene ${id}: attached ${collection} ${list.length} (${ids.size} unique ids), keyed ${n}`);
      }
    }
  }
  const ourFolders = new Map(ours.folders.map(f => [f._id, f]));
  for ( const id of ref.folders.keys() ) if ( !ourFolders.has(id) ) problems.push(`missing folder ${id}`);
  for ( const id of ourFolders.keys() ) if ( !ref.folders.has(id) ) problems.push(`extra folder ${id}`);
  for ( const [id, refDoc] of ref.folders ) {
    const ourDoc = ourFolders.get(id);
    if ( ourDoc && stableStringify(summarizeFolder(ourDoc)) !== stableStringify(summarizeFolder(refDoc)) ) problems.push(`folder ${id} differs`);
  }
  for ( const [id, refCounts] of ref.counts ) {
    if ( stableStringify(refCounts) !== stableStringify(ours.counts.get(id) ?? {}) ) {
      problems.push(`counts differ for ${id}: ours ${JSON.stringify(ours.counts.get(id) ?? {})} ref ${JSON.stringify(refCounts)}`);
    }
  }
  return problems;
}

/* ---------------------------------- main ---------------------------------- */

const packs = listPacks();
console.log(`data: ${dataPath}\nclassic-level: ${foundry}\npacks: ${packs.length}\n`);
const totals = { ok: 0, mismatch: 0, readerError: 0, missing: 0, skippedLocked: 0, bytes: 0, scenes: 0, ms: 0, warnings: 0 };
const failures = [];

for ( const pack of packs ) {
  if ( !fs.existsSync(pack.dir) ) {
    totals.missing++;
    console.log(`  --      ${pack.id}: directory missing`);
    continue;
  }
  const source = {
    list: async () => fsp.readdir(pack.dir),
    read: async name => new Uint8Array(await fsp.readFile(path.join(pack.dir, name)))
  };
  const warnings = [];
  const t0 = performance.now();
  let ours;
  try {
    ours = await readScenePack(source, { verify, embed, onWarning: w => warnings.push(w) });
  } catch ( err ) {
    totals.readerError++;
    failures.push(`${pack.id}: reader error: ${err.message}`);
    console.log(`  ERROR   ${pack.id}: ${err.message}`);
    continue;
  }
  const ms = performance.now() - t0;
  const bytes = Object.values(ours.files).reduce((a, b) => a + b, 0);
  totals.bytes += bytes;
  totals.ms += ms;
  totals.scenes += ours.scenes.length;
  totals.warnings += warnings.length;

  let ref = await referenceRead(pack.dir);
  let note = "";
  if ( ref.locked ) {
    if ( !copyLocked ) {
      totals.skippedLocked++;
      console.log(`  read    ${pack.id}: ${ours.scenes.length} scenes, ${ours.folders.length} folders, ${(bytes / 1e6).toFixed(1)} MB, ${ms.toFixed(0)} ms — locked, reference skipped${warnings.length ? `, ${warnings.length} warnings` : ""}`);
      continue;
    }
    const tmp = await copyDir(pack.dir);
    try {
      ref = await referenceRead(tmp);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
    note = " (reference from copy)";
  }
  const problems = compare(ours, ref);
  if ( problems.length ) {
    totals.mismatch++;
    failures.push(`${pack.id}:\n    ${problems.slice(0, 8).join("\n    ")}${problems.length > 8 ? `\n    … ${problems.length - 8} more` : ""}`);
    console.log(`  FAIL    ${pack.id}: ${problems.length} problems${note}`);
  } else {
    totals.ok++;
    console.log(`  ok      ${pack.id}: ${ours.scenes.length} scenes, ${ours.folders.length} folders, ${(bytes / 1e6).toFixed(1)} MB, ${ms.toFixed(0)} ms${note}${warnings.length ? `, ${warnings.length} warnings` : ""}`);
  }
  for ( const w of warnings.slice(0, 3) ) console.log(`          warning: ${w}`);
}

console.log(`\nSummary: ok=${totals.ok} mismatch=${totals.mismatch} readerError=${totals.readerError} lockedSkipped=${totals.skippedLocked} missingDir=${totals.missing}`);
console.log(`Read ${totals.scenes} scenes, ${(totals.bytes / 1e6).toFixed(1)} MB in ${(totals.ms / 1000).toFixed(1)} s (${(totals.bytes / 1e6 / (totals.ms / 1000)).toFixed(1)} MB/s), warnings: ${totals.warnings}`);
if ( failures.length ) {
  console.log("\nFailures:");
  for ( const f of failures ) console.log("  " + f);
  process.exit(1);
}
