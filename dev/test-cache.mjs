#!/usr/bin/env node
/** Unit check of scripts/cache.js against stubbed FilePicker / fetch / settings. Developer tooling only. */
import assert from "node:assert/strict";

const stored = new Map(); // Data-relative path → JSON text
const uploads = [];
globalThis.game = {
  version: "13.351",
  i18n: { localize: k => k, lang: "en" },
  settings: { get: () => "elfrey-scene-browser" }
};
globalThis.foundry = {
  utils: { getRoute: p => "/" + p.replace(/^\/+|\/+$/g, "") },
  applications: { apps: { FilePicker: { implementation: {
    browse: async (source, target) => {
      const files = [...stored.keys()].filter(p => p.startsWith(target + "/"));
      if ( !files.length && !target.endsWith("packs") ) throw new Error(`Directory ${target} does not exist`);
      return { target, files: files.map(encodeURI), dirs: [] };
    },
    createDirectory: async (source, target) => {
      if ( target === "elfrey-scene-browser" ) throw new Error("EEXIST: file already exists, mkdir");
      return target;
    },
    upload: async (source, target, file) => {
      const path = `${target}/${file.name}`;
      stored.set(path, await file.text());
      uploads.push(path);
      return { path };
    }
  } } } }
};
globalThis.fetch = async url => {
  const path = decodeURIComponent(new URL(url, "http://x").pathname.slice(1));
  if ( !stored.has(path) ) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => JSON.parse(stored.get(path)) };
};

const { SceneCache, safeName } = await import("../scripts/cache.js");

const entry = (collection, ts, extra = {}) => JSON.stringify({ schema: 1, collection, status: "ok", scenes: [{ _id: "a" }, { _id: "b" }], folders: [], package: { version: "1" }, ...extra });
stored.set("elfrey-scene-browser/packs/mod.pack.1700000000001.json", entry("mod.pack", 1));
stored.set("elfrey-scene-browser/packs/mod.pack.1700000000009.json", entry("mod.pack", 9, { scenes: [{ _id: "x" }] }));
stored.set("elfrey-scene-browser/packs/mod.pack.1700000000005.json", entry("mod.pack", 5));
stored.set("elfrey-scene-browser/packs/other.one.1700000000002.json", entry("other.one", 2, { status: "error", error: "boom", scenes: [] }));
stored.set("elfrey-scene-browser/packs/garbage.txt", "nope");
stored.set("elfrey-scene-browser/packs/bad.pack.1700000000003.json", "{not json");

const cache = await SceneCache.load();
assert.equal(cache.packs.size, 2, "two collections loaded");
assert.equal(cache.get("mod.pack").scenes.length, 1, "newest file wins");
assert.equal(cache.get("mod.pack").ts, 1700000000009);
assert.deepEqual(cache.staleFiles.sort(), ["elfrey-scene-browser/packs/mod.pack.1700000000001.json", "elfrey-scene-browser/packs/mod.pack.1700000000005.json"]);
assert.equal(cache.errors.length, 1, "unparseable file reported");
assert.deepEqual(cache.totals(), { packs: 2, ok: 1, errors: 1, scenes: 1, staleFiles: 2, badFiles: 1 });
assert.equal(cache.generatedAt.getTime(), 1700000000009);

const written = await cache.write({ collection: "mod.pack", status: "ok", scenes: [{ _id: "n1" }, { _id: "n2" }, { _id: "n3" }], folders: [], package: { version: "2" }, label: "L", path: "p", strategy: "files", error: null, scannedAt: "", coreVersion: "13", signature: null, warnings: [] });
assert.equal(uploads.length, 1);
assert.match(uploads[0], /^elfrey-scene-browser\/packs\/mod\.pack\.\d{13}\.json$/);
assert.equal(cache.get("mod.pack").scenes.length, 3, "written entry is current");
assert.equal(cache.staleFiles.length, 3, "previous current file became stale");
assert.equal(written.schema, 1);
assert.equal(JSON.parse(stored.get(uploads[0])).file, undefined, "runtime fields not persisted");

const reloaded = await SceneCache.load();
assert.equal(reloaded.get("mod.pack").scenes.length, 3, "reload picks the newly written file");
assert.equal(safeName("a b/c.d"), "a_b_c.d");

const empty = new SceneCache("nowhere");
await empty.reload();
assert.equal(empty.packs.size, 0, "missing directory → empty cache");

console.log("cache tests passed");
