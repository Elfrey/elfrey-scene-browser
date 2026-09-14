/**
 * The scene cache: one JSON file per compendium pack under Data/<cacheDir>/packs/.
 *
 * Foundry's server never lets a client overwrite an existing non-media file, so cache files are versioned by
 * name — "<collection>.<timestamp>.json" — and a pack gets a new file only when its content changed. On load the
 * newest file per collection wins; superseded files are reported so the user can delete them by hand.
 */
import { DEFAULT_CACHE_DIR, SETTINGS, getSetting, warn } from "./settings.js";

export const CACHE_SCHEMA = 1;
const FILE_RE = /^(.+)\.(\d{13})\.json$/;

/** The FilePicker class of this core version (moved into foundry.applications.apps in v13). */
export function filePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

/** Turn a Data-relative path into a fetchable route. */
export function dataRoute(path) {
  return foundry.utils.getRoute(path.split("/").map(encodeURIComponent).join("/"));
}

/** Only characters that are safe in a file name; pack ids already satisfy this. */
export function safeName(collection) {
  return collection.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * @typedef {object} CacheEntry
 * @property {number} schema
 * @property {string} collection
 * @property {{type: string, id: string, title: string, version: string}} package
 * @property {string} label
 * @property {string} path
 * @property {"files"|"api"} strategy
 * @property {"ok"|"error"} status
 * @property {string|null} error
 * @property {string} scannedAt
 * @property {string} coreVersion
 * @property {object|null} signature
 * @property {object[]} folders
 * @property {object[]} scenes
 * @property {string[]} warnings
 * @property {string} [file]   Data-relative path of the file this entry was loaded from
 * @property {number} [ts]     Timestamp encoded in the file name
 */

export class SceneCache {

  /** @param {string} dir  Data-relative directory */
  constructor(dir) {
    this.dir = dir;
    /** @type {Map<string, CacheEntry>} */
    this.packs = new Map();
    /** @type {string[]} */
    this.staleFiles = [];
    /** @type {{path: string, message: string}[]} */
    this.errors = [];
    this.loadedAt = null;
  }

  /** Configured cache directory, normalised. */
  static get configuredDir() {
    const dir = (getSetting(SETTINGS.cacheDir) || DEFAULT_CACHE_DIR).trim().replace(/^\/+|\/+$/g, "");
    return dir || DEFAULT_CACHE_DIR;
  }

  get packsDir() {
    return `${this.dir}/packs`;
  }

  /**
   * Load the cache from disk.
   * @param {string} [dir]
   * @returns {Promise<SceneCache>}
   */
  static async load(dir = SceneCache.configuredDir) {
    const cache = new SceneCache(dir);
    await cache.reload();
    return cache;
  }

  /** Re-read the directory listing and every current file. */
  async reload() {
    this.packs.clear();
    this.staleFiles = [];
    this.errors = [];
    let files = [];
    try {
      const result = await filePicker().browse("data", this.packsDir);
      files = (result?.files ?? []).map(f => decodeURIComponent(f));
    } catch ( err ) {
      // No directory yet: an empty cache.
      this.loadedAt = new Date();
      return this;
    }

    const newest = new Map();
    for ( const path of files ) {
      const match = FILE_RE.exec(path.split("/").pop());
      if ( !match ) continue;
      const [, name, tsString] = match;
      const ts = Number(tsString);
      const prev = newest.get(name);
      if ( !prev || (ts > prev.ts) ) {
        if ( prev ) this.staleFiles.push(prev.path);
        newest.set(name, { path, ts });
      }
      else this.staleFiles.push(path);
    }

    const queue = [...newest.entries()];
    let next = 0;
    const pull = async () => {
      while ( next < queue.length ) {
        const [name, { path, ts }] = queue[next++];
        try {
          const response = await fetch(`${dataRoute(path)}?v=${ts}`);
          if ( !response.ok ) throw new Error(`HTTP ${response.status}`);
          const entry = await response.json();
          if ( (entry?.schema !== CACHE_SCHEMA) || (safeName(entry.collection ?? "") !== name) ) throw new Error("unexpected content");
          entry.file = path;
          entry.ts = ts;
          this.packs.set(entry.collection, entry);
        } catch ( err ) {
          this.errors.push({ path, message: err.message });
          warn(`cache file ${path}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, pull));
    this.loadedAt = new Date();
    return this;
  }

  /** @param {string} collection */
  get(collection) {
    return this.packs.get(collection) ?? null;
  }

  /** Time of the newest cache file, or null when empty. */
  get generatedAt() {
    let max = 0;
    for ( const e of this.packs.values() ) max = Math.max(max, e.ts ?? 0);
    return max ? new Date(max) : null;
  }

  totals() {
    let scenes = 0;
    let ok = 0;
    let errors = 0;
    for ( const e of this.packs.values() ) {
      if ( e.status === "ok" ) {
        ok++;
        scenes += e.scenes?.length ?? 0;
      }
      else errors++;
    }
    return { packs: this.packs.size, ok, errors, scenes, staleFiles: this.staleFiles.length, badFiles: this.errors.length };
  }

  /** Create the cache directories if they are missing. */
  async ensureDirs() {
    const fp = filePicker();
    for ( const dir of [this.dir, this.packsDir] ) {
      try {
        await fp.createDirectory("data", dir);
      } catch ( err ) {
        if ( !/EEXIST|exists/i.test(err?.message ?? "") ) throw err;
      }
    }
  }

  /**
   * Persist an entry as a new versioned file and make it current.
   * @param {CacheEntry} entry
   * @returns {Promise<CacheEntry>}
   */
  async write(entry) {
    await this.ensureDirs();
    const ts = Date.now();
    const payload = { ...entry, schema: CACHE_SCHEMA };
    delete payload.file;
    delete payload.ts;
    const name = `${safeName(entry.collection)}.${ts}.json`;
    const file = new File([JSON.stringify(payload)], name, { type: "application/json" });
    const response = await filePicker().upload("data", this.packsDir, file, {}, { notify: false });
    if ( !response?.path ) throw new Error(game.i18n.localize("ESB.Errors.UploadFailed"));
    const prev = this.packs.get(entry.collection);
    if ( prev?.file ) this.staleFiles.push(prev.file);
    const stored = { ...payload, file: decodeURIComponent(response.path), ts };
    this.packs.set(entry.collection, stored);
    return stored;
  }
}
