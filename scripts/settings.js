/**
 * Module constants and settings registration.
 */
export const MODULE_ID = "elfrey-scene-browser";
export const TEMPLATES = `modules/${MODULE_ID}/templates`;
export const DEFAULT_CACHE_DIR = "elfrey-scene-browser";

export const SETTINGS = Object.freeze({
  cacheDir: "cacheDir",
  importFolder: "importFolder",
  indexActivePacks: "indexActivePacks",
  cardSize: "cardSize",
  rememberState: "rememberState",
  showInactive: "showInactive",
  uiState: "uiState"
});

export const log = (...args) => console.log(`${MODULE_ID} |`, ...args);
export const warn = (...args) => console.warn(`${MODULE_ID} |`, ...args);

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.cacheDir, {
    name: "ESB.Settings.CacheDir.Name",
    hint: "ESB.Settings.CacheDir.Hint",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_CACHE_DIR
  });
  game.settings.register(MODULE_ID, SETTINGS.importFolder, {
    name: "ESB.Settings.ImportFolder.Name",
    hint: "ESB.Settings.ImportFolder.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "Scene Browser"
  });
  game.settings.register(MODULE_ID, SETTINGS.indexActivePacks, {
    name: "ESB.Settings.IndexActivePacks.Name",
    hint: "ESB.Settings.IndexActivePacks.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, SETTINGS.cardSize, {
    name: "ESB.Settings.CardSize.Name",
    scope: "client",
    config: true,
    type: Number,
    choices: {
      120: "ESB.Settings.CardSize.Small",
      160: "ESB.Settings.CardSize.Medium",
      220: "ESB.Settings.CardSize.Large"
    },
    default: 160
  });
  game.settings.register(MODULE_ID, SETTINGS.rememberState, {
    name: "ESB.Settings.RememberState.Name",
    hint: "ESB.Settings.RememberState.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, SETTINGS.showInactive, {
    name: "ESB.Settings.ShowInactive.Name",
    hint: "ESB.Settings.ShowInactive.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, SETTINGS.uiState, {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
}

export const getSetting = key => game.settings.get(MODULE_ID, key);
export const setSetting = (key, value) => game.settings.set(MODULE_ID, key, value);
