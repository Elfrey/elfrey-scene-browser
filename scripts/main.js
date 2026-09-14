/**
 * Elfrey Scene Browser — hooks entry point.
 */
import { MODULE_ID, registerSettings, log } from "./settings.js";
import { SceneBrowserApp } from "./app/browser.js";
import { listScenePackSources, summarizeSources } from "./sources.js";

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
    listScenePackSources,
    summarizeSources
  };
  if ( game.user.isGM ) {
    const s = summarizeSources();
    log(`ready — ${s.packs} scene packs (${s.livePacks} live, ${s.dormantPacks} dormant), ${s.modules.length} modules with scenes`);
  }
});

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
