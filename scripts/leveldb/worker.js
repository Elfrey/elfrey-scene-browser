/**
 * Web Worker: fetches the files of one compendium pack over HTTP and parses them off the main thread.
 *
 * Request:  { id, type: "readPack", baseUrl, path, files, bust, verify, embed }
 *   baseUrl  origin + route prefix, ending with "/"
 *   path     pack directory relative to Data, e.g. "modules/foo/packs/scenes"
 *   files    optional directory listing (names) obtained on the main thread
 *   bust     query-string value appended to every request (also what lets v13 serve the files)
 *   embed    false | true | string[] (scene ids) — attach embedded documents to scenes (for import)
 * Messages: { id, type: "progress", file, bytes, loaded } · { id, type: "warning", message }
 *           { id, type: "done", result } · { id, type: "error", message }
 */
import { readScenePack } from "./pack-reader.js";
import { summarizeScene, summarizeFolder, countsFor } from "./summary.js";

self.addEventListener("message", async ({ data }) => {
  if ( data?.type !== "readPack" ) return;
  const { id, baseUrl, path, files, bust, verify = true, embed = false } = data;
  const source = {
    list: files ? async () => files : undefined,
    read: async name => {
      const url = `${baseUrl}${path}/${name}?v=${encodeURIComponent(bust ?? Date.now())}`;
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if ( !response.ok ) throw new Error(`HTTP ${response.status} for ${name}`);
      return new Uint8Array(await response.arrayBuffer());
    }
  };
  try {
    const embedOption = Array.isArray(embed) ? new Set(embed) : embed;
    const result = await readScenePack(source, {
      verify,
      embed: embedOption,
      onProgress: p => self.postMessage({ id, type: "progress", ...p }),
      onWarning: message => self.postMessage({ id, type: "warning", message })
    });
    self.postMessage({
      id,
      type: "done",
      result: {
        manifest: result.manifest,
        files: result.files,
        lastSequence: result.lastSequence,
        folders: result.folders.map(summarizeFolder),
        scenes: result.scenes.map(s => summarizeScene(s, countsFor(result.counts, s._id))),
        fullScenes: embedOption ? result.scenes : undefined,
        warnings: result.warnings
      }
    });
  } catch ( err ) {
    self.postMessage({ id, type: "error", message: err?.message ?? String(err) });
  }
});
