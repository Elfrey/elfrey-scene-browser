/**
 * The indexer: decides how each Scene pack can be read, estimates the download, reads packs (files through the
 * Web Worker, or the Foundry API for connected packs when files are out of reach) and stores the results.
 */
import { warn } from "./settings.js";
import { parseManifest, fileName } from "./leveldb/manifest.js";
import { summarizeIndexEntry, summarizeFolder } from "./leveldb/summary.js";
import { filePicker } from "./cache.js";
import { listScenePackSources } from "./sources.js";

/** Fields requested from the server for connected packs (cheap scalar fields only). */
const LIVE_INDEX_FIELDS = [
  "navName", "width", "height",
  "grid.type", "grid.size", "grid.distance", "grid.units",
  "background.src",
  "_stats.systemId", "_stats.coreVersion", "_stats.modifiedTime"
];

/** Origin + route prefix, with a trailing slash. */
export function foundryBaseUrl() {
  return new URL(foundry.utils.getRoute(""), location.origin).href.replace(/\/?$/, "/");
}

/* -------------------------------------------- */
/*  Worker client                               */
/* -------------------------------------------- */

export class PackWorker {
  #worker;
  #jobs = new Map();
  #seq = 0;

  constructor() {
    this.#worker = new Worker(new URL("./leveldb/worker.js", import.meta.url), { type: "module" });
    this.#worker.addEventListener("message", ({ data }) => {
      const job = this.#jobs.get(data?.id);
      if ( !job ) return;
      switch ( data.type ) {
        case "progress": job.onProgress?.(data); break;
        case "warning": job.onWarning?.(data.message); break;
        case "done":
          this.#jobs.delete(data.id);
          job.resolve(data.result);
          break;
        case "error":
          this.#jobs.delete(data.id);
          job.reject(new Error(data.message));
          break;
      }
    });
    this.#worker.addEventListener("error", event => {
      const err = new Error(event?.message ?? "worker error");
      for ( const job of this.#jobs.values() ) job.reject(err);
      this.#jobs.clear();
    });
  }

  /**
   * @param {object} params
   * @param {string} params.path         Pack directory relative to Data
   * @param {string[]|null} params.files Directory listing, if known
   * @param {string|number} params.bust  Query-string value for every request
   * @param {boolean} [params.verify]
   * @param {boolean|string[]} [params.embed]
   * @param {object} [callbacks]
   * @returns {Promise<object>}
   */
  read({ path, files, bust, verify = true, embed = false }, { onProgress, onWarning } = {}) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#jobs.set(id, { resolve, reject, onProgress, onWarning });
      this.#worker.postMessage({ id, type: "readPack", baseUrl: foundryBaseUrl(), path, files, bust, verify, embed });
    });
  }

  terminate() {
    this.#worker.terminate();
    const err = new Error("cancelled");
    for ( const job of this.#jobs.values() ) job.reject(err);
    this.#jobs.clear();
  }
}

/* -------------------------------------------- */
/*  Indexer                                     */
/* -------------------------------------------- */

/**
 * @typedef {object} PlanItem
 * @property {import("./sources.js").ScenePackSource} source
 * @property {object|null} cached
 * @property {"files"|"api"|"none"} strategy
 * @property {"unchanged"|"missing"|"unavailable"|null} skip
 * @property {object|null} probe        Result of probeSignature for the files strategy
 * @property {object|null} signature
 * @property {string[]|null} listing
 * @property {number} bytes
 */

export class SceneIndexer {

  /** @param {import("./cache.js").SceneCache} cache */
  constructor(cache) {
    this.cache = cache;
    this.baseUrl = foundryBaseUrl();
    this.bust = Date.now();
    this.cancelled = false;
    /** @type {PackWorker|null} */
    this.worker = null;
  }

  /** Session-wide memo of whether the server serves pack database files. */
  static fileAccess = undefined;

  /* -------------------------------------------- */

  fileUrl(path, name) {
    return `${this.baseUrl}${path.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(name)}?v=${this.bust}`;
  }

  /**
   * Can pack database files be fetched? Tries CURRENT of up to five packs (a 404 means a missing pack, not a
   * blocked server), remembers the answer for the session.
   * @param {import("./sources.js").ScenePackSource[]} sources
   * @returns {Promise<boolean>}
   */
  async probeFileAccess(sources) {
    if ( SceneIndexer.fileAccess !== undefined ) return SceneIndexer.fileAccess;
    let verdict = false;
    let tried = 0;
    for ( const source of sources ) {
      if ( tried >= 5 ) break;
      tried++;
      try {
        const response = await fetch(this.fileUrl(source.path, "CURRENT"), { cache: "no-store" });
        if ( response.ok ) { verdict = true; break; }
        if ( response.status === 403 ) { verdict = false; break; }
      } catch ( err ) {
        warn(`file access probe failed for ${source.path}: ${err.message}`);
      }
    }
    SceneIndexer.fileAccess = verdict;
    return verdict;
  }

  /** Directory listing through the FilePicker (file names only), or null when it fails. */
  async listDir(path) {
    try {
      const result = await filePicker().browse("data", path);
      return (result?.files ?? []).map(f => decodeURIComponent(f).split("/").pop());
    } catch ( err ) {
      return null;
    }
  }

  /** Size of a file in bytes via HEAD (falls back to a Range request), or null. */
  async headSize(url) {
    try {
      const head = await fetch(url, { method: "HEAD", cache: "no-store" });
      if ( head.ok && head.headers.has("content-length") ) return Number(head.headers.get("content-length"));
      const ranged = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
      const match = /\/(\d+)$/.exec(ranged.headers.get("content-range") ?? "");
      if ( match ) return Number(match[1]);
      if ( ranged.ok ) return (await ranged.arrayBuffer()).byteLength;
    } catch ( err ) {
      warn(`size probe failed for ${url}: ${err.message}`);
    }
    return null;
  }

  /**
   * Read CURRENT and the MANIFEST of a pack to learn which files it consists of and how large they are.
   * @param {import("./sources.js").ScenePackSource} source
   */
  async probeSignature(source) {
    const response = await fetch(this.fileUrl(source.path, "CURRENT"), { cache: "no-store" });
    if ( response.status === 404 ) return { status: "missing" };
    if ( response.status === 403 ) return { status: "forbidden" };
    if ( !response.ok ) return { status: "error", error: `HTTP ${response.status} (CURRENT)` };
    const currentText = await response.text();
    const current = currentText.trim();
    if ( !/^MANIFEST-\d{6}$/.test(current) ) return { status: "error", error: `CURRENT: "${current.slice(0, 40)}"` };

    const manifestResponse = await fetch(this.fileUrl(source.path, current), { cache: "no-store" });
    if ( !manifestResponse.ok ) return { status: "error", error: `HTTP ${manifestResponse.status} (${current})` };
    const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
    let manifest;
    try {
      manifest = parseManifest(manifestBytes, { verify: false });
    } catch ( err ) {
      return { status: "error", error: `${current}: ${err.message}` };
    }

    const listing = await this.listDir(source.path);
    const files = { [current]: manifestBytes.length };
    let bytes = manifestBytes.length + new TextEncoder().encode(currentText).length; // CURRENT is read too
    for ( const table of manifest.files.values() ) {
      let name = fileName(table.number, "ldb");
      if ( listing && !listing.includes(name) && listing.includes(fileName(table.number, "sst")) ) name = fileName(table.number, "sst");
      files[name] = table.size;
      bytes += table.size;
    }
    const minLog = manifest.prevLogNumber || manifest.logNumber;
    let logs;
    if ( listing ) logs = listing.filter(n => /^\d{6}\.log$/.test(n) && (parseInt(n, 10) >= minLog)).sort();
    else logs = [...new Set([manifest.prevLogNumber, manifest.logNumber].filter(Boolean).map(n => fileName(n, "log")))];
    for ( const name of logs ) {
      const size = await this.headSize(this.fileUrl(source.path, name));
      if ( size === null ) continue;
      files[name] = size;
      bytes += size;
    }
    return { status: "ok", signature: { manifest: current, files }, bytes, listing };
  }

  static signaturesEqual(a, b) {
    if ( !a || !b || (a.manifest !== b.manifest) ) return false;
    const ka = Object.keys(a.files ?? {});
    const kb = Object.keys(b.files ?? {});
    return (ka.length === kb.length) && ka.every(k => a.files[k] === b.files[k]);
  }

  /* -------------------------------------------- */

  /**
   * Decide what to do with every pack and estimate the download.
   * @param {object} [options]
   * @param {boolean} [options.includeLive]   Read files of connected packs too (for embedded counts)
   * @param {Function} [options.onProgress]
   */
  async plan({ includeLive = true, onProgress } = {}) {
    const sources = listScenePackSources();
    const fileAccess = await this.probeFileAccess(sources);

    /** @type {PlanItem[]} */
    const items = sources.map(source => ({
      source, cached: this.cache.get(source.collection), strategy: "none", skip: null, probe: null, signature: null, listing: null, bytes: 0
    }));
    for ( const item of items ) {
      const adventure = item.source.kind === "adventure";
      if ( fileAccess && (!item.source.live || includeLive) ) item.strategy = "files";
      else if ( item.source.live && !adventure ) item.strategy = "api";  // API index has no embedded scenes for Adventure packs
      else item.skip = "unavailable";
    }

    const toProbe = items.filter(i => i.strategy === "files");
    let done = 0;
    let next = 0;
    const pull = async () => {
      while ( next < toProbe.length ) {
        const item = toProbe[next++];
        try {
          item.probe = await this.probeSignature(item.source);
        } catch ( err ) {
          item.probe = { status: "error", error: err.message };
        }
        const p = item.probe;
        if ( p.status === "ok" ) {
          item.signature = p.signature;
          item.bytes = p.bytes;
          item.listing = p.listing;
          const c = item.cached;
          const sameVersion = c && (c.package?.version === item.source.packageVersion);
          if ( c?.status === "ok" && sameVersion && (c.strategy === "files") && SceneIndexer.signaturesEqual(c.signature, p.signature) ) item.skip = "unchanged";
        }
        else if ( p.status === "missing" ) item.skip = "missing";
        else if ( p.status === "forbidden" ) item.skip = "unavailable";
        done++;
        onProgress?.({ phase: "planning", done, total: toProbe.length });
      }
    };
    await Promise.all(Array.from({ length: 4 }, pull));

    for ( const item of items ) {
      if ( item.strategy !== "api" ) continue;
      const c = item.cached;
      if ( c?.status === "ok" && (c.package?.version === item.source.packageVersion) ) item.skip = "unchanged";
    }

    const read = items.filter(i => !i.skip && (i.strategy === "files") && (i.probe?.status === "ok"));
    const summary = {
      fileAccess,
      total: items.length,
      read: read.length,
      bytes: read.reduce((sum, i) => sum + i.bytes, 0),
      api: items.filter(i => !i.skip && (i.strategy === "api")).length,
      unchanged: items.filter(i => i.skip === "unchanged").length,
      missing: items.filter(i => i.skip === "missing").length,
      unavailable: items.filter(i => i.skip === "unavailable").length,
      errors: items.filter(i => !i.skip && (i.strategy === "files") && (i.probe?.status !== "ok")).length
    };
    return { items, summary, includeLive };
  }

  /* -------------------------------------------- */

  /**
   * Execute a plan: read every pack that is not skipped and write it to the cache as it completes.
   * @param {{items: PlanItem[], summary: object}} plan
   * @param {object} [options]
   * @param {Function} [options.onProgress]
   */
  async run(plan, { onProgress } = {}) {
    this.cancelled = false;
    const queue = plan.items.filter(i => !i.skip && (i.strategy !== "none"));
    const state = {
      done: 0, failed: 0, total: queue.length,
      loaded: 0, totalBytes: plan.summary.bytes,
      scenes: 0, warnings: 0, current: null, results: []
    };
    const emit = () => onProgress?.({ phase: "running", ...state });
    const needWorker = queue.some(i => i.strategy === "files");
    this.worker = needWorker ? new PackWorker() : null;

    try {
      for ( const item of queue ) {
        if ( this.cancelled ) break;
        state.current = item;
        emit();
        const { source } = item;
        const base = {
          collection: source.collection,
          package: { type: source.packageType, id: source.packageId, title: source.packageTitle, version: source.packageVersion },
          label: source.label,
          path: source.path,
          strategy: item.strategy,
          scannedAt: new Date().toISOString(),
          coreVersion: game.version,
          signature: item.signature
        };
        let entry;
        try {
          if ( item.strategy === "files" ) {
            if ( item.probe?.status !== "ok" ) throw new Error(item.probe?.error ?? item.probe?.status ?? "probe failed");
            const before = state.loaded;
            const result = await this.worker.read(
              { path: source.path, files: item.listing, bust: this.bust, verify: true },
              {
                onProgress: p => { state.loaded = before + p.loaded; emit(); },
                onWarning: () => { state.warnings++; }
              }
            );
            state.loaded = before + item.bytes;
            entry = { ...base, status: "ok", error: null, folders: result.folders, scenes: result.scenes, warnings: result.warnings.slice(0, 20) };
          }
          else {
            const result = await SceneIndexer.readLivePack(source.live);
            entry = { ...base, status: "ok", error: null, folders: result.folders, scenes: result.scenes, warnings: [] };
          }
          state.scenes += entry.scenes.length;
        } catch ( err ) {
          if ( this.cancelled ) break;
          entry = { ...base, status: "error", error: err?.message ?? String(err), folders: [], scenes: [], warnings: [] };
          state.failed++;
        }

        // Do not pile up identical error files.
        const c = item.cached;
        const duplicateError = (entry.status === "error") && (c?.status === "error") && (c.error === entry.error)
          && (c.package?.version === source.packageVersion);
        if ( !duplicateError ) {
          try {
            await this.cache.write(entry);
          } catch ( err ) {
            entry.writeError = err?.message ?? String(err);
            if ( entry.status === "ok" ) state.failed++;
            warn(`could not write cache for ${entry.collection}: ${entry.writeError}`);
          }
        }
        state.done++;
        state.results.push({
          collection: entry.collection, label: entry.label, packageTitle: source.packageTitle,
          status: entry.writeError ? "error" : entry.status, error: entry.error ?? entry.writeError ?? null,
          scenes: entry.scenes.length, strategy: entry.strategy
        });
        emit();
      }
    } finally {
      this.worker?.terminate();
      this.worker = null;
    }
    state.current = null;
    return { ...state, cancelled: this.cancelled };
  }

  cancel() {
    this.cancelled = true;
    this.worker?.terminate();
  }

  /**
   * Read a connected pack through the Foundry API: index with extra fields plus compendium folders.
   * @param {CompendiumCollection} pack
   */
  static async readLivePack(pack) {
    const index = await pack.getIndex({ fields: LIVE_INDEX_FIELDS });
    const scenes = [];
    for ( const entry of index.values() ) scenes.push(summarizeIndexEntry(entry));
    const folders = [];
    for ( const folder of pack.folders ?? [] ) folders.push(summarizeFolder(folder.toObject()));
    return { scenes, folders };
  }
}
