/**
 * The unified model: merges the cache, connected packs and the world's own scenes into one tree
 *   Group → Package → (PackFolder…) → Pack → (Folder…) → Scene
 * and a flat list of scene records the grid and search work on.
 *
 * Data source per pack (PLAN.md §2.1):
 *   world scenes         → game.scenes + game.folders (live documents)
 *   pack with cache      → cached entry (scenes with sizes, counts, flags, folders)
 *   connected, no cache  → pack.getIndex() + pack.folders (names, thumbs, sizes; counts unknown)
 *   dormant, no cache    → empty pack node, status "unindexed"
 */
import { listScenePackSources } from "./sources.js";
import { summarizeScene, summarizeFolder } from "./leveldb/summary.js";
import { normalize } from "./search.js";

/** Placeholder scenes injected by the Compendium Folders module; never real scenes. */
const CF_TEMP_NAME = "#[CF_tempEntity]";

const LIVE_INDEX_FIELDS = [
  "navName", "width", "height",
  "grid.type", "grid.size", "grid.distance", "grid.units",
  "background.src", "thumb", "sort", "folder",
  "_stats.systemId", "_stats.coreVersion", "_stats.modifiedTime"
];

/** Resolve a stored asset path to something usable in an <img src>. */
export function assetUrl(path) {
  if ( !path ) return null;
  if ( /^(https?:|data:|blob:)/.test(path) ) return path;
  return foundry.utils.getRoute(path.split("/").map(encodeURIComponent).join("/"));
}

/**
 * @typedef {object} SceneRecord
 * @property {string} uid              Unique within the model
 * @property {string|null} uuid        Foundry UUID when addressable (world or connected pack), else null
 * @property {string} name
 * @property {string} navName
 * @property {string|null} thumb        Ready-to-use URL
 * @property {string|null} bg           Ready-to-use URL
 * @property {number|null} w
 * @property {number|null} h
 * @property {object} grid
 * @property {Record<string, number>|null} counts
 * @property {string[]|null} flags
 * @property {string|null} system
 * @property {number|null} modified
 * @property {"world"|"live"|"cache"} origin
 * @property {string} packageId
 * @property {string} packageTitle
 * @property {"module"|"system"|"world"} packageType
 * @property {boolean} active
 * @property {string} packCollection
 * @property {string} packLabel
 * @property {string} nodeId           Tree node this scene belongs to
 * @property {string} search           Precomputed normalized search text
 */

let uidSeq = 0;

class Node {
  constructor(id, type, label, extra = {}) {
    this.id = id;
    this.type = type;      // group | package | packFolder | pack | folder
    this.label = label;
    this.children = [];
    this.scenes = [];      // SceneRecord[] directly in this node
    this.count = 0;        // scenes in subtree (recomputed by filters)
    Object.assign(this, extra);
  }
  child(id) { return this.children.find(c => c.id === id); }
  ensureChild(id, type, label, extra) {
    let c = this.child(id);
    if ( !c ) { c = new Node(id, type, label, extra); this.children.push(c); }
    return c;
  }
}

/**
 * Build the folder subtree of a pack (or the world) from flat folder records and place scenes into it.
 * @param {Node} rootNode           Pack node (or a world group node)
 * @param {string} scope            Prefix for folder node ids
 * @param {object[]} folders        { _id, name, folder, sort, color }
 * @param {SceneRecord[]} scenes    Records whose `folder` points into these folders
 */
function buildFolderTree(rootNode, scope, folders, scenes) {
  const byId = new Map();
  for ( const f of folders ) byId.set(f._id, f);
  const nodeFor = new Map();  // folderId → Node
  const nodeId = fid => `folder:${scope}:${fid}`;

  const resolve = fid => {
    if ( !fid || !byId.has(fid) ) return rootNode;
    if ( nodeFor.has(fid) ) return nodeFor.get(fid);
    const f = byId.get(fid);
    const parent = resolve(f.folder);
    const node = parent.ensureChild(nodeId(fid), "folder", f.name || "—", { sort: f.sort ?? 0, color: f.color ?? null });
    nodeFor.set(fid, node);
    return node;
  };
  for ( const f of folders ) resolve(f._id);
  for ( const s of scenes ) resolve(s._folder).scenes.push(s);
}

function sortNode(node) {
  node.children.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label, game.i18n.lang));
  node.scenes.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name, game.i18n.lang));
  for ( const c of node.children ) sortNode(c);
}

/**
 * Turn a compact scene summary into a full SceneRecord.
 * @param {object} s               summarizeScene output (has _id, name, thumb, bg, w, h, grid, folder, sort, counts, flags, system, modified)
 * @param {object} ctx             { origin, source, uuid, nodeId }
 */
function toRecord(s, ctx) {
  const rec = {
    uid: `r${++uidSeq}`,
    uuid: ctx.uuid ?? null,
    name: s.name ?? "",
    navName: s.navName ?? "",
    thumb: assetUrl(s.thumb),
    bg: assetUrl(s.bg),
    w: s.w ?? null,
    h: s.h ?? null,
    grid: s.grid ?? {},
    counts: s.counts ?? null,
    flags: s.flags ?? null,
    system: s.system ?? null,
    modified: s.modified ?? null,
    origin: ctx.origin,
    packageId: ctx.source.packageId,
    packageTitle: ctx.source.packageTitle,
    packageType: ctx.source.packageType,
    active: ctx.source.active,
    packCollection: ctx.source.collection,
    packLabel: ctx.source.label,
    advId: s.advId ?? null,
    advName: s.advName ?? null,
    sceneId: s._id,
    scenesPath: ctx.scenesPath ?? null,
    _folder: s.folder ?? null,
    nodeId: ctx.nodeId
  };
  return rec;
}

function precomputeSearch(rec, trail) {
  rec.search = normalize([rec.name, rec.navName, rec.packLabel, rec.packageTitle, ...trail].join(" "));
}

/**
 * @param {import("./cache.js").SceneCache} cache
 * @returns {Promise<{tree: Node[], scenes: SceneRecord[], stats: object}>}
 */
export async function buildModel(cache) {
  const scenes = [];
  const groups = {
    world: new Node("group:world", "group", game.i18n.localize("ESB.Tree.World"), { icon: "fa-globe", order: 0 }),
    system: new Node("group:system", "group", game.i18n.localize("ESB.Tree.System"), { icon: "fa-cubes", order: 1 }),
    modules: new Node("group:modules", "group", game.i18n.localize("ESB.Tree.Modules"), { icon: "fa-puzzle-piece", order: 2 })
  };

  /* ---- world scenes ---- */
  {
    const worldNode = groups.world.ensureChild("world:scenes", "pack", game.i18n.localize("ESB.Tree.WorldScenes"), { status: "world", packageType: "world" });
    const source = { collection: "world.__scenes__", packageId: "world", packageTitle: game.world.title ?? "world", packageType: "world", active: true, label: game.world.title ?? "world" };
    const folders = game.folders.filter(f => f.type === "Scene").map(f => summarizeFolder(f.toObject()));
    const recs = [];
    for ( const scene of game.scenes ) {
      const s = summarizeScene(scene.toObject());
      const rec = toRecord(s, { origin: "world", source, uuid: scene.uuid, nodeId: worldNode.id });
      recs.push(rec);
      scenes.push(rec);
    }
    buildFolderTree(worldNode, "world", folders, recs);
  }

  /* ---- compendium packs ---- */
  const sources = listScenePackSources();
  for ( const source of sources ) {
    const group = source.packageType === "system" ? groups.system : source.packageType === "world" ? groups.world : groups.modules;

    // Package node (skip an extra level for the world group; world packs sit beside "World scenes")
    const pkgNode = source.packageType === "world"
      ? group
      : group.ensureChild(`pkg:${source.packageType}:${source.packageId}`, "package", source.packageTitle, {
          packageId: source.packageId, active: source.active, packageType: source.packageType
        });

    // packFolder chain from the manifest
    let parent = pkgNode;
    let trail = [];
    for ( const name of source.packFolderPath ) {
      trail = [...trail, name];
      parent = parent.ensureChild(`pf:${source.packageId}:${trail.join("/")}`, "packFolder", name, {});
    }

    const isAdventure = source.kind === "adventure";
    const cached = cache.get(source.collection);
    const stale = cached && (cached.package?.version !== source.packageVersion);
    let status = "unindexed";
    if ( cached?.status === "ok" ) status = stale ? "stale" : (cached.strategy === "api" ? "live" : "cache");
    else if ( cached?.status === "error" ) status = "error";
    else if ( source.live && !isAdventure ) status = "live";

    const packNode = parent.ensureChild(`pack:${source.collection}`, "pack", source.label, {
      collection: source.collection, status, packageType: source.packageType,
      active: source.active, error: cached?.error ?? null
    });

    let sceneSummaries = [];
    let folders = [];
    let origin = "cache";
    // Scenes embedded in an Adventure have no compendium UUID of their own; they are imported from raw JSON.
    let getUuid = s => (s.advId ? null : `Compendium.${source.collection}.Scene.${s._id}`);

    if ( cached?.status === "ok" ) {
      sceneSummaries = cached.scenes ?? [];
      folders = cached.folders ?? [];
      origin = cached.strategy === "api" ? "live" : "cache";
      if ( source.live?.getUuid ) getUuid = s => (s.advId ? null : source.live.getUuid(s._id));
      else if ( !source.live ) getUuid = () => null;   // dormant: not addressable until imported
    }
    else if ( source.live && !isAdventure ) {
      // Connected Scene pack, not cached: read names/thumbs/sizes from the API.
      try {
        const index = await source.live.getIndex({ fields: LIVE_INDEX_FIELDS });
        sceneSummaries = [...index.values()].map(e => { const r = summarizeScene(e, null); r.counts = null; r.flags = null; return r; });
        folders = (source.live.folders ?? []).map(f => summarizeFolder(f.toObject ? f.toObject() : f));
        origin = "live";
        getUuid = s => source.live.getUuid(s._id);
      } catch ( err ) {
        packNode.status = "error";
        packNode.error = err.message;
      }
    }

    // Group by adventure: scenes/folders carrying an advId hang under a per-adventure node.
    const groupsByAdv = new Map();   // advId|"" → { name, scenes:[], folders:[] }
    for ( const sc of sceneSummaries ) {
      if ( sc.name === CF_TEMP_NAME ) continue;   // guard old caches built before CF placeholders were filtered
      const key = sc.advId ?? "";
      let g = groupsByAdv.get(key);
      if ( !g ) groupsByAdv.set(key, g = { name: sc.advName ?? "", scenes: [], folders: [] });
      g.scenes.push(sc);
    }
    for ( const f of folders ) {
      const key = f.advId ?? "";
      let g = groupsByAdv.get(key);
      if ( !g ) groupsByAdv.set(key, g = { name: "", scenes: [], folders: [] });
      g.folders.push(f);
    }

    for ( const [advId, g] of groupsByAdv ) {
      const container = advId
        ? packNode.ensureChild(`adv:${source.collection}:${advId}`, "adventure", g.name || game.i18n.localize("ESB.Tree.Adventure"), {})
        : packNode;
      const scope = advId ? `${source.collection}:${advId}` : source.collection;
      const recs = g.scenes.map(sc => toRecord(sc, { origin, source, uuid: getUuid(sc), nodeId: container.id, scenesPath: cached?.scenesPath ?? null }));
      for ( const r of recs ) { scenes.push(r); precomputeSearch(r, [...trail, ...(advId ? [g.name] : [])]); }
      buildFolderTree(container, scope, g.folders, recs);
    }
  }

  // Search text for world scenes (packFolder trail is empty)
  for ( const r of scenes ) if ( !r.search ) precomputeSearch(r, []);

  const tree = [groups.world, groups.system, groups.modules].filter(g => g.children.length);
  for ( const g of tree ) sortNode(g);

  // Ancestor paths (for scope filtering and node counts) and a node lookup.
  const nodeIndex = new Map();
  const assignPaths = (node, ancestors) => {
    nodeIndex.set(node.id, node);
    const path = [...ancestors, node.id];
    node.path = path;
    for ( const sc of node.scenes ) sc.path = path;
    for ( const c of node.children ) assignPaths(c, path);
  };
  for ( const g of tree ) assignPaths(g, []);

  const stats = {
    total: scenes.length,
    world: scenes.filter(s => s.origin === "world").length,
    cache: scenes.filter(s => s.origin === "cache").length,
    live: scenes.filter(s => s.origin === "live").length
  };
  return { tree, scenes, stats, nodeIndex };
}

export { Node };
