/**
 * Read a Foundry compendium pack (a LevelDB directory) from any byte source and extract its Scene
 * and Folder documents plus per-scene counts of embedded documents.
 *
 * Key layout written by Foundry/classic-level:
 *   !scenes!<sceneId>                         Scene document (JSON)
 *   !folders!<folderId>                       Folder document (JSON)
 *   !scenes.walls!<sceneId>.<wallId>          embedded document; nested collections look like
 *   !scenes.regions.behaviors!<sceneId>.<regionId>.<behaviorId>
 *
 * Newest sequence number wins across tables and logs; deletions are tombstones.
 */
import { parseManifest, fileName } from "./manifest.js";
import { readTableEntries } from "./table-reader.js";
import { readLogRecords } from "./log-reader.js";
import { parseWriteBatch, OP_DELETE } from "./write-batch.js";

export const SCENE_PREFIX = "!scenes!";
export const FOLDER_PREFIX = "!folders!";
export const ADVENTURE_PREFIX = "!adventures!";
const EMBEDDED_PREFIX = "!scenes.";

/** Placeholder documents the Compendium Folders module injects to encode a folder tree; not real scenes. */
export const CF_TEMP_NAME = "#[CF_tempEntity]";

const decoder = new TextDecoder();

/**
 * @typedef {object} PackSource
 * @property {(name: string) => Promise<Uint8Array>} read   Read one file of the pack directory
 * @property {() => Promise<string[]>} [list]               File names in the pack directory (optional)
 */

/**
 * @typedef {object} PackReadResult
 * @property {string} manifest                       Name of the MANIFEST file that was current
 * @property {Record<string, number>} files          Byte size of every file that was read
 * @property {number} lastSequence
 * @property {object[]} scenes                       Raw Scene documents (embedded collections attached when requested)
 * @property {object[]} folders                      Raw Folder documents
 * @property {Map<string, Record<string, number>>} counts   sceneId → { walls: n, tokens: n, ... }
 * @property {string[]} warnings
 */

/**
 * Split an embedded key into its parts.
 * @param {string} key   e.g. "!scenes.regions.behaviors!abc.def.ghi"
 * @returns {{collection: string, sceneId: string, ids: string[]}|null}
 */
export function parseEmbeddedKey(key) {
  const bang = key.indexOf("!", 1);
  if ( bang === -1 ) return null;
  const collection = key.slice(EMBEDDED_PREFIX.length, bang);
  const ids = key.slice(bang + 1).split(".");
  return { collection, sceneId: ids[0], ids: ids.slice(1) };
}

/**
 * Attach embedded documents to their scene, following the collection path (e.g. "regions.behaviors").
 * @param {object} scene
 * @param {Map<string, {collection: string, ids: string[], doc: object}[]>} embedded
 */
function attachEmbedded(scene, entries) {
  // Shallow collections first so nested ones find their parents.
  entries.sort((a, b) => a.collection.split(".").length - b.collection.split(".").length);
  // Keyed documents are the source of truth: a parent may still carry a stale inline copy of a collection
  // (seen in packs built by third-party tools), which must be replaced rather than appended to.
  const reset = new Set();
  for ( const { collection, ids, doc } of entries ) {
    const path = collection.split(".");
    let parent = scene;
    let ok = true;
    for ( let i = 0; i < path.length - 1; i++ ) {
      const list = parent[path[i]];
      parent = Array.isArray(list) ? list.find(d => d?._id === ids[i]) : null;
      if ( !parent ) { ok = false; break; }
    }
    if ( !ok ) continue;
    const leaf = path[path.length - 1];
    if ( !reset.has(parent) || !Array.isArray(parent[leaf]) || !reset.has(parent[leaf]) ) {
      parent[leaf] = [];
      reset.add(parent);
      reset.add(parent[leaf]);
    }
    parent[leaf].push(doc);
  }
}

/**
 * Read a pack.
 * @param {PackSource} source
 * @param {object} [options]
 * @param {boolean} [options.verify=true]              Verify checksums (mismatches are reported, not fatal)
 * @param {boolean|Set<string>} [options.embed=false]  Attach embedded documents to all scenes (true) or to these ids
 * @param {(progress: {file: string, bytes: number, loaded: number}) => void} [options.onProgress]
 * @param {(message: string) => void} [options.onWarning]
 * @returns {Promise<PackReadResult>}
 */
export async function readScenePack(source, { verify = true, embed = false, onProgress, onWarning } = {}) {
  const warnings = [];
  const warn = message => {
    warnings.push(message);
    onWarning?.(message);
  };
  const files = {};
  let loaded = 0;
  const load = async name => {
    const bytes = await source.read(name);
    files[name] = bytes.length;
    loaded += bytes.length;
    onProgress?.({ file: name, bytes: bytes.length, loaded });
    return bytes;
  };

  // 1. CURRENT → MANIFEST → live tables and log number
  const current = decoder.decode(await load("CURRENT")).trim();
  if ( !/^MANIFEST-\d{6}$/.test(current) ) throw new Error(`CURRENT does not name a manifest: "${current}"`);
  const manifest = parseManifest(await load(current), { verify, onWarning: warn });
  const listing = source.list ? await source.list() : null;
  const tables = [...manifest.files.values()].sort((a, b) => a.number - b.number);

  // 2. Which logs to replay: every log numbered at or above the oldest live one (LevelDB recovery rule)
  const minLog = manifest.prevLogNumber || manifest.logNumber;
  let logs = [];
  if ( listing ) {
    logs = listing.filter(n => /^\d{6}\.log$/.test(n) && (parseInt(n, 10) >= minLog)).sort();
  } else {
    for ( const n of [manifest.prevLogNumber, manifest.logNumber] ) if ( n ) logs.push(fileName(n, "log"));
    logs = [...new Set(logs)];
  }

  // 3. Merge: latest sequence wins. Document values are copied out of the file buffers; embedded keys
  //    are only tracked for de-duplication (seq, negative for tombstones) unless embedding was requested.
  const documents = new Map();  // key → { seq, deleted, value }
  const embeddedSeq = new Map(); // key → seq (>0 put, <0 delete)
  const embeddedValues = embed ? new Map() : null; // key → JSON bytes copy
  const wantEmbedded = sceneId => (embed === true) || (embed instanceof Set && embed.has(sceneId));

  const put = (keyBytes, valueBytes, type, seq) => {
    const key = decoder.decode(keyBytes);
    const deleted = type === OP_DELETE;
    if ( key.startsWith(SCENE_PREFIX) || key.startsWith(FOLDER_PREFIX) || key.startsWith(ADVENTURE_PREFIX) ) {
      const prev = documents.get(key);
      if ( prev && prev.seq >= seq ) return;
      documents.set(key, { seq, deleted, value: deleted ? null : valueBytes.slice() });
      return;
    }
    if ( key.startsWith(EMBEDDED_PREFIX) ) {
      const prev = embeddedSeq.get(key);
      if ( prev !== undefined && Math.abs(prev) >= seq ) return;
      embeddedSeq.set(key, deleted ? -seq : seq);
      if ( embeddedValues ) {
        if ( deleted ) embeddedValues.delete(key);
        else {
          const sceneId = key.slice(key.indexOf("!", 1) + 1).split(".")[0];
          if ( wantEmbedded(sceneId) ) embeddedValues.set(key, valueBytes.slice());
        }
      }
    }
    // Any other key (unknown document types) is ignored.
  };

  for ( const table of tables ) {
    let name = fileName(table.number, "ldb");
    if ( listing && !listing.includes(name) && listing.includes(fileName(table.number, "sst")) ) name = fileName(table.number, "sst");
    let bytes;
    try {
      bytes = await load(name);
    } catch ( err ) {
      warn(`table ${name} could not be read: ${err.message}`);
      continue;
    }
    try {
      for ( const e of readTableEntries(bytes, { verify, onWarning: warn }) ) put(e.key, e.value, e.type, e.seq);
    } catch ( err ) {
      warn(`table ${name} is corrupt: ${err.message}`);
    }
  }
  for ( const name of logs ) {
    let bytes;
    try {
      bytes = await load(name);
    } catch ( err ) {
      warn(`log ${name} could not be read: ${err.message}`);
      continue;
    }
    if ( !bytes.length ) continue;
    try {
      for ( const record of readLogRecords(bytes, { verify, onWarning: warn }) ) {
        for ( const e of parseWriteBatch(record) ) put(e.key, e.value, e.type, e.seq);
      }
    } catch ( err ) {
      warn(`log ${name} is corrupt: ${err.message}`);
    }
  }

  // 4. Extract documents
  const scenes = [];
  const folders = [];
  const sceneIds = new Set();
  for ( const [key, entry] of documents ) {
    if ( entry.deleted ) continue;
    let doc;
    try {
      doc = JSON.parse(decoder.decode(entry.value));
    } catch ( err ) {
      warn(`${key}: invalid JSON (${err.message})`);
      continue;
    }
    if ( key.startsWith(SCENE_PREFIX) ) {
      if ( doc.name === CF_TEMP_NAME ) continue;   // Compendium Folders placeholder, not a real scene
      if ( !doc._id ) doc._id = key.slice(SCENE_PREFIX.length);
      scenes.push(doc);
      sceneIds.add(doc._id);
    }
    else if ( key.startsWith(ADVENTURE_PREFIX) ) {
      // An Adventure document bundles full scenes (with inline embedded arrays) and mixed-type folders.
      if ( !doc._id ) doc._id = key.slice(ADVENTURE_PREFIX.length);
      const tag = { id: doc._id, name: doc.name ?? "" };
      for ( const sc of doc.scenes ?? [] ) {
        if ( !sc || typeof sc !== "object" ) continue;
        if ( sc.name === CF_TEMP_NAME ) continue;
        sc.__adv = tag;
        scenes.push(sc);
        if ( sc._id ) sceneIds.add(sc._id);
      }
      for ( const f of doc.folders ?? [] ) {
        if ( f?.type !== "Scene" ) continue;
        f.__adv = tag;
        folders.push(f);
      }
    }
    else {
      if ( !doc._id ) doc._id = key.slice(FOLDER_PREFIX.length);
      folders.push(doc);
    }
  }

  // 5. Count embedded documents per scene and collection
  const counts = new Map();
  const embeddedBySceneId = embeddedValues ? new Map() : null;
  for ( const [key, seq] of embeddedSeq ) {
    if ( seq < 0 ) continue;
    const parsed = parseEmbeddedKey(key);
    if ( !parsed || !sceneIds.has(parsed.sceneId) ) continue;
    let c = counts.get(parsed.sceneId);
    if ( !c ) counts.set(parsed.sceneId, c = {});
    c[parsed.collection] = (c[parsed.collection] ?? 0) + 1;
    if ( embeddedValues?.has(key) ) {
      let list = embeddedBySceneId.get(parsed.sceneId);
      if ( !list ) embeddedBySceneId.set(parsed.sceneId, list = []);
      try {
        list.push({ collection: parsed.collection, ids: parsed.ids, doc: JSON.parse(decoder.decode(embeddedValues.get(key))) });
      } catch ( err ) {
        warn(`${key}: invalid JSON (${err.message})`);
      }
    }
  }
  if ( embeddedBySceneId ) {
    for ( const scene of scenes ) {
      const list = embeddedBySceneId.get(scene._id);
      if ( list ) attachEmbedded(scene, list);
    }
  }

  return { manifest: current, files, lastSequence: manifest.lastSequence, scenes, folders, counts, warnings };
}
