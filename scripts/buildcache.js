/**
 * In-app cache builder for users who cannot run tools/build-cache.mjs (Foundry v14).
 *
 * Flow (see PLAN.md): a dialog lists installed modules that ship scenes. The GM picks modules; the ones already
 * enabled are indexed immediately over the API; the disabled ones are enabled, the world reloads, they are
 * indexed, the original module configuration is restored and the world reloads again. Because enabling a module
 * runs its code, this is meant for a scratch/empty world.
 */
import { MODULE_ID, SETTINGS, getSetting, setSetting, log, warn } from "./settings.js";
import { SceneCache } from "./cache.js";
import { apiIndexPacks } from "./apiindex.js";

/** Scene/Adventure pack collection ids of a package. */
function scenePackCollections(pkg, packageType) {
  const out = [];
  for ( const pack of pkg.packs ?? [] ) {
    const type = pack.type ?? pack.entity;
    if ( type !== "Scene" && type !== "Adventure" ) continue;
    out.push(pack.id ?? `${packageType === "world" ? "world" : pkg.id}.${pack.name}`);
  }
  return out;
}

/** Installed modules that ship Scene/Adventure packs. */
export function listSceneModules() {
  const out = [];
  for ( const mod of game.modules ) {
    const collections = scenePackCollections(mod, "module");
    if ( collections.length ) out.push({ id: mod.id, title: mod.title ?? mod.id, active: mod.active, collections });
  }
  out.sort((a, b) => a.title.localeCompare(b.title, game.i18n.lang));
  return out;
}

const reload = () => (foundry.utils.debouncedReload ?? (() => window.location.reload()))();

/* ------------------------------ dialog ------------------------------ */

/** Open the module-selection dialog and start the build. GM only. */
export async function openBuildDialog() {
  if ( !game.user.isGM ) return;
  const modules = listSceneModules();
  if ( !modules.length ) { ui.notifications.info(game.i18n.localize("ESB.Build.NoModules")); return; }

  const rows = modules.map(m => `
    <label class="esb-mod-row">
      <input type="checkbox" name="mod" value="${m.id}">
      <span class="esb-mod-title">${foundry.utils.escapeHTML?.(m.title) ?? m.title}</span>
      <span class="esb-mod-state ${m.active ? "on" : "off"}">${game.i18n.localize(m.active ? "ESB.Status.Active" : "ESB.Status.Inactive")}</span>
      <span class="esb-mod-meta">${m.collections.length} pk</span>
    </label>`).join("");
  const content = `
    <p>${game.i18n.localize("ESB.Build.Intro")}</p>
    <p class="notification warning" style="margin:.3rem 0">${game.i18n.localize("ESB.Build.Warning")}</p>
    <div class="esb-mod-list">${rows}</div>`;

  let picked = null;
  try {
    picked = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("ESB.Build.Title"), icon: "fa-solid fa-database" },
      position: { width: 560, height: "auto" },
      content,
      ok: {
        label: game.i18n.localize("ESB.Build.Start"),
        callback: (event, button) => [...button.form.querySelectorAll('input[name="mod"]:checked')].map(i => i.value)
      }
    });
  } catch ( err ) { return; }   // dismissed
  if ( !picked?.length ) return;

  const chosen = modules.filter(m => picked.includes(m.id));
  const enabledNow = chosen.filter(m => m.active);
  const toEnable = chosen.filter(m => !m.active);

  // Index already-enabled modules immediately (no reload).
  if ( enabledNow.length ) {
    const collections = enabledNow.flatMap(m => m.collections);
    await runIndex(collections, game.i18n.localize("ESB.Build.IndexingNow"));
  }

  // Enable the rest, then reload to index them.
  if ( toEnable.length ) {
    await startOrchestration(toEnable);
  } else if ( enabledNow.length ) {
    ui.notifications.info(game.i18n.localize("ESB.Build.Done"));
    SceneBrowserRefresh();
  }
}

/** Enable the chosen modules and reload; indexing resumes on the next load. */
async function startOrchestration(modules) {
  const proceed = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("ESB.Build.Title") },
    content: `<p>${game.i18n.format("ESB.Build.ConfirmEnable", { count: modules.length })}</p>`
  });
  if ( !proceed ) return;

  const original = foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration")) ?? {};
  const next = { ...original, [MODULE_ID]: true };
  for ( const m of modules ) next[m.id] = true;

  await setSetting(SETTINGS.pendingBuild, {
    phase: "index",
    collections: modules.flatMap(m => m.collections),
    restoreConfig: original
  });
  await game.settings.set("core", "moduleConfiguration", next);
  ui.notifications.info(game.i18n.localize("ESB.Build.Enabling"), { permanent: true });
  reload();
}

/**
 * Resume a pending build after a reload: index the enabled packs, restore the module configuration, reload.
 * Called from the ready hook (GM). Always restores config and clears the pending state, even on error.
 */
export async function resumePendingBuild() {
  const pending = getSetting(SETTINGS.pendingBuild);
  if ( !pending || pending.phase !== "index" ) return;

  try {
    const cache = await SceneCache.load();
    await runIndex(pending.collections, game.i18n.localize("ESB.Build.IndexingNow"), cache);
  } catch ( err ) {
    console.error(`${MODULE_ID} |`, err);
  } finally {
    await setSetting(SETTINGS.pendingBuild, null);
    try { await game.settings.set("core", "moduleConfiguration", pending.restoreConfig); }
    catch ( err ) { console.error(`${MODULE_ID} |`, err); }
    ui.notifications.info(game.i18n.localize("ESB.Build.Restoring"), { permanent: true });
    reload();
  }
}

/* ------------------------------ indexing ------------------------------ */

async function runIndex(collections, message, cache) {
  if ( !collections.length ) return;
  cache ??= await SceneCache.load();
  ui.notifications.info(`${message} (${collections.length})`);
  const results = await apiIndexPacks(collections, cache, {
    onProgress: p => { if ( p.phase === "written" ) log(`indexed ${p.done}/${p.total}: ${p.collection}`); }
  });
  const ok = results.filter(r => r.status === "ok");
  const failed = results.filter(r => r.status !== "ok");
  const scenes = ok.reduce((n, r) => n + (r.scenes ?? 0), 0);
  if ( failed.length ) ui.notifications.warn(game.i18n.format("ESB.Build.Result", { ok: ok.length, scenes, failed: failed.length }));
  else ui.notifications.info(game.i18n.format("ESB.Build.Result", { ok: ok.length, scenes, failed: 0 }));
  for ( const f of failed ) warn(`index failed: ${f.collection}: ${f.error}`);
}

/** Refresh an open browser window so newly indexed scenes appear. */
function SceneBrowserRefresh() {
  const app = game.modules.get(MODULE_ID)?.api?.app;
  app?.render();
}
