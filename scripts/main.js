/**
 * Elfrey Scene Browser — hooks entry point.
 */
import { MODULE_ID, SETTINGS, registerSettings, getSetting, setSetting, log } from "./settings.js";
import { SceneBrowserApp } from "./app/browser.js";
import { listScenePackSources, summarizeSources } from "./sources.js";
import { SceneCache, filePicker } from "./cache.js";
import { resumePendingBuild } from "./buildcache.js";

Hooks.once("init", () => {
  registerSettings();
  game.keybindings.register(MODULE_ID, "open", {
    name: "ESB.Keybinding.Open.Name",
    hint: "ESB.Keybinding.Open.Hint",
    editable: [],
    restricted: true,
    onDown: () => {
      SceneBrowserApp.open();
      return true;
    }
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    open: options => SceneBrowserApp.open(options),
    get app() { return SceneBrowserApp.instance; },
    buildCacheFromModules: () => import("./buildcache.js").then(m => m.openBuildDialog()),
    listScenePackSources,
    summarizeSources
  };
  if ( game.user.isGM ) {
    const s = summarizeSources();
    log(`ready — ${s.packs} scene packs (${s.livePacks} live, ${s.dormantPacks} dormant), ${s.modules.length} modules with scenes`);
    resumePendingBuild().then(() => warnIfCacheStale());
  }
});

/**
 * On Foundry v14 the browser cannot read pack files, so scenes of disabled modules come only from a cache
 * built outside Foundry (tools/build-cache.mjs). Warn the GM at load when that cache is missing entries or
 * is out of date — i.e. a module with scenes was added, or a cached module changed version.
 */
async function warnIfCacheStale() {
  if ( Number(game.version?.split(".")[0]) < 14 ) return;   // v13 can index from the UI; no external cache needed
  let cache;
  try {
    cache = await SceneCache.load();
  } catch ( err ) {
    return;
  }
  const dormant = listScenePackSources().filter(src => !src.live);   // inactive packs need the external cache
  const missing = [];
  const stale = [];
  for ( const src of dormant ) {
    const entry = cache.get(src.collection);
    if ( !entry ) missing.push(src);
    else if ( entry.package?.version !== src.packageVersion ) stale.push(src);
  }
  // Are full scene documents present? Without them, importing scenes from disabled modules is impossible on v14.
  let hasFullScenes = false;
  try {
    const result = await filePicker().browse("data", `${SceneCache.configuredDir}/scenes`);
    hasFullScenes = ((result?.dirs?.length ?? 0) + (result?.files?.length ?? 0)) > 0;
  } catch ( err ) {
    hasFullScenes = false;
  }

  const packages = new Set([...missing, ...stale].map(s => s.packageId));
  const showCache = packages.size > 0;
  const showFull = !hasFullScenes;
  if ( !showCache && !showFull ) return;
  if ( getSetting(SETTINGS.hideCacheWarning) ) return;   // GM chose "don't show again"

  if ( showCache ) log(`cache incomplete: ${missing.length} pack(s) not cached, ${stale.length} outdated; packages: ${[...packages].join(", ")}`);
  if ( showFull ) log("cache has no full scene documents — import from disabled modules is unavailable on v14 until built with --full-scenes");

  const parts = [];
  if ( showFull ) parts.push(`<p>${game.i18n.localize("ESB.CacheWarning.NoFullScenes")}</p>`);
  if ( showCache ) parts.push(`<p>${game.i18n.format("ESB.CacheWarning.Message", { count: packages.size })}</p>`);
  parts.push(`<label class="esb-dialog-check"><input type="checkbox" name="hide"> ${game.i18n.localize("ESB.CacheWarning.DontShowAgain")}</label>`);

  let dontShow = false;
  try {
    dontShow = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("ESB.CacheWarning.Title"), icon: "fa-solid fa-database" },
      position: { width: 480 },
      content: parts.join(""),
      ok: {
        label: game.i18n.localize("ESB.CacheWarning.Ok"),
        callback: (event, button) => button.form?.elements?.hide?.checked ?? false
      }
    });
  } catch ( err ) {
    return;   // dialog dismissed
  }
  if ( dontShow ) await setSetting(SETTINGS.hideCacheWarning, true);
}

/**
 * Add the "Scene Browser" button to a sidebar directory header (Scenes and Compendium tabs).
 * @param {Application} app
 * @param {HTMLElement|jQuery} element
 */
function injectHeaderButton(app, element) {
  if ( !game.user?.isGM ) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const actions = root?.querySelector(".directory-header .header-actions");
  if ( !actions || actions.querySelector(".esb-open") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "esb-open";
  button.dataset.tooltip = game.i18n.localize("ESB.Button.OpenTooltip");
  button.innerHTML = `<i class="fa-solid fa-images" inert></i><span>${game.i18n.localize("ESB.Button.Open")}</span>`;
  button.addEventListener("click", () => SceneBrowserApp.open());
  actions.append(button);
}

Hooks.on("renderSceneDirectory", injectHeaderButton);
Hooks.on("renderCompendiumDirectory", injectHeaderButton);
