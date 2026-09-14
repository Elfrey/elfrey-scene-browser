/**
 * Enumeration of every place a Scene can live in this world:
 *   - the world's own scenes (game.scenes),
 *   - Scene compendium packs of the world, the active system and every installed module — active or not.
 *
 * A pack descriptor is plain data shared by the indexer, the model and the UI. `live` is the connected
 * CompendiumCollection when the server has it loaded (active package, matching system), otherwise null.
 */

const PACKAGE_DIRS = { module: "modules", system: "systems", world: "worlds" };

/**
 * @typedef {object} ScenePackSource
 * @property {string} collection      Pack id as Foundry names it: "<package>.<name>" or "world.<name>"
 * @property {"module"|"system"|"world"} packageType
 * @property {string} packageId
 * @property {string} packageTitle
 * @property {string} packageVersion
 * @property {boolean} active         Is the owning package active in this world?
 * @property {string} name            Pack name inside the package
 * @property {string} label
 * @property {string|null} system     Pack restricted to a system id (null = any)
 * @property {string} path            Path relative to the Data root, e.g. "modules/foo/packs/scenes"
 * @property {string[]} packFolderPath Names of the package's packFolders leading to this pack
 * @property {CompendiumCollection|null} live
 */

/**
 * Build a map pack-name → array of packFolder names for a package.
 * @param {Set<object>|object[]} packFolders
 * @returns {Map<string, string[]>}
 */
function packFolderPaths(packFolders) {
  const map = new Map();
  const walk = (folders, trail) => {
    for ( const folder of folders ?? [] ) {
      const path = [...trail, folder.name];
      for ( const packName of folder.packs ?? [] ) map.set(packName, path);
      walk(folder.folders, path);
    }
  };
  walk(packFolders, []);
  return map;
}

/**
 * Data-relative path of a pack directory. On the client, `pack.path` is already the full path
 * (e.g. "modules/foo/packs/scenes"); only build it from parts when the package omits it.
 * @param {ClientPackage} pkg
 * @param {"module"|"system"|"world"} packageType
 * @param {object} pack
 * @returns {string}
 */
function packPath(pkg, packageType, pack) {
  const raw = (pack.path || "").replace(/\.db$/, "").replace(/^\/+|\/+$/g, "");
  if ( /^(modules|systems|worlds)\//.test(raw) ) return raw;
  return `${PACKAGE_DIRS[packageType]}/${pkg.id}/${raw || `packs/${pack.name}`}`;
}

/**
 * Describe the Scene packs of one package.
 * @param {ClientPackage} pkg
 * @param {"module"|"system"|"world"} packageType
 * @param {boolean} active
 * @returns {ScenePackSource[]}
 */
function describePackagePacks(pkg, packageType, active) {
  const folders = packFolderPaths(pkg.packFolders);
  const out = [];
  for ( const pack of pkg.packs ?? [] ) {
    const type = pack.type ?? pack.entity;
    if ( type !== "Scene" && type !== "Adventure" ) continue;
    const collection = pack.id ?? `${packageType === "world" ? "world" : pkg.id}.${pack.name}`;
    out.push({
      collection,
      kind: type === "Adventure" ? "adventure" : "scene",
      packageType,
      packageId: pkg.id,
      packageTitle: pkg.title ?? pkg.id,
      packageVersion: String(pkg.version ?? ""),
      active,
      name: pack.name,
      label: pack.label ?? pack.name,
      system: pack.system || null,
      path: packPath(pkg, packageType, pack),
      packFolderPath: folders.get(pack.name) ?? [],
      live: game.packs.get(collection) ?? null
    });
  }
  return out;
}

/**
 * List every Scene pack known to this client.
 * @returns {ScenePackSource[]}
 */
export function listScenePackSources() {
  const sources = [];
  sources.push(...describePackagePacks(game.world, "world", true));
  if ( game.system ) sources.push(...describePackagePacks(game.system, "system", true));
  for ( const mod of game.modules ) sources.push(...describePackagePacks(mod, "module", mod.active));
  return sources;
}

/**
 * Summary numbers for the UI header and diagnostics.
 * @param {ScenePackSource[]} [sources]
 */
export function summarizeSources(sources = listScenePackSources()) {
  const modulesWithScenes = new Map();
  let live = 0, dormant = 0;
  for ( const s of sources ) {
    if ( s.live ) live++; else dormant++;
    if ( s.packageType !== "module" ) continue;
    const entry = modulesWithScenes.get(s.packageId) ?? { id: s.packageId, title: s.packageTitle, active: s.active, packs: 0, live: 0 };
    entry.packs++;
    if ( s.live ) entry.live++;
    modulesWithScenes.set(s.packageId, entry);
  }
  const modules = [...modulesWithScenes.values()].sort((a, b) => a.title.localeCompare(b.title, game.i18n.lang));
  return {
    worldScenes: game.scenes.size,
    packs: sources.length,
    livePacks: live,
    dormantPacks: dormant,
    modules,
    activeModules: modules.filter(m => m.active).length,
    inactiveModules: modules.filter(m => !m.active).length
  };
}
