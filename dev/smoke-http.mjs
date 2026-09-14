#!/usr/bin/env node
/**
 * Smoke test of the browser-side indexer pipeline against a live Foundry server, run from Node:
 * probeSignature() (CURRENT / MANIFEST / HEAD over HTTP) and PackWorker.read() (worker fetching pack files).
 * FilePicker (directory listing, cache writes) needs a socket session and is not covered here.
 *
 *   node dev/smoke-http.mjs https://localhost:30013 modules/ag-dnd2024/packs/dmg-scenes [more pack paths…]
 */
import { Worker as NodeThread } from "node:worker_threads";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const [origin, ...paths] = process.argv.slice(2);
if ( !origin || !paths.length ) {
  console.error("usage: node dev/smoke-http.mjs <origin> <pack path relative to Data> [...]");
  process.exit(2);
}

// Minimal Foundry globals used by the modules under test.
globalThis.location = { origin };
globalThis.foundry = { utils: { getRoute: p => "/" + p.replace(/^\/+|\/+$/g, "") } };
globalThis.game = { version: "13.351", i18n: { localize: k => k, lang: "en" } };
globalThis.Worker = class {
  #thread;
  #listeners = {};
  constructor(url) {
    this.#thread = new NodeThread(new URL("./worker-shim.mjs", import.meta.url), { workerData: { url: url.href } });
    this.#thread.on("message", data => this.#listeners.message?.({ data }));
    this.#thread.on("error", err => this.#listeners.error?.({ message: err.message }));
  }
  addEventListener(type, fn) { this.#listeners[type] = fn; }
  postMessage(message) { this.#thread.postMessage(message); }
  terminate() { this.#thread.terminate(); }
};

const { SceneIndexer, PackWorker } = await import("../scripts/indexer.js");

const indexer = new SceneIndexer({ get: () => null });
const worker = new PackWorker();
let failed = false;
for ( const path of paths ) {
  const source = { path, collection: path, packageTitle: path, label: path, packageVersion: "0", live: null };
  const t0 = performance.now();
  const probe = await indexer.probeSignature(source);
  const t1 = performance.now();
  if ( probe.status !== "ok" ) {
    failed = true;
    console.log(`  probe   ${path}: ${probe.status} ${probe.error ?? ""}`);
    continue;
  }
  const files = Object.entries(probe.signature.files);
  console.log(`  probe   ${path}: ${probe.signature.manifest}, ${files.length} files, ${(probe.bytes / 1e6).toFixed(1)} MB, ${(t1 - t0).toFixed(0)} ms`);
  let warnings = 0;
  let lastLoaded = 0;
  try {
    const result = await worker.read({ path, files: null, bust: indexer.bust, verify: true }, {
      onProgress: p => { lastLoaded = p.loaded; },
      onWarning: () => warnings++
    });
    const t2 = performance.now();
    const withCounts = result.scenes.filter(s => s.counts && Object.values(s.counts).some(n => n > 0)).length;
    console.log(`  worker  ${path}: ${result.scenes.length} scenes (${withCounts} with embedded counts), ${result.folders.length} folders, loaded ${(lastLoaded / 1e6).toFixed(1)} MB, ${(t2 - t1).toFixed(0)} ms, warnings ${warnings}`);
    const sample = result.scenes[0];
    if ( sample ) console.log(`          sample: ${JSON.stringify(sample).slice(0, 220)}…`);
    if ( probe.bytes !== lastLoaded ) console.log(`          note: probe estimated ${probe.bytes} bytes, worker loaded ${lastLoaded}`);
  } catch ( err ) {
    failed = true;
    console.log(`  worker  ${path}: ERROR ${err.message}`);
  }
}
worker.terminate();
process.exit(failed ? 1 : 0);
