/**
 * SceneBrowserApp — the browser window (ApplicationV2 + Handlebars for the shell, direct DOM for the tree and grid).
 *
 * The shell (toolbar, empty tree/grid/details containers) is rendered by Foundry once. The tree, the card grid,
 * search filtering, scope selection and lazy card loading are done by manipulating the DOM directly, so typing
 * in the search box or scrolling never triggers a full re-render. A full render happens only on open, refresh and
 * after indexing, when the model is rebuilt.
 */
import { MODULE_ID, TEMPLATES, SETTINGS, getSetting, setSetting, log } from "../settings.js";
import { summarizeSources } from "../sources.js";
import { SceneCache } from "../cache.js";
import { SceneIndexer } from "../indexer.js";
import { buildModel } from "../model.js";
import { tokenize, matchesTokens } from "../search.js";
import { passes, anyActive, comparator, systemsIn } from "../filters.js";
import * as actions from "./actions.js";
import { IndexingDialog } from "./indexing-dialog.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const CHUNK = 120;

export class SceneBrowserApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: MODULE_ID,
    classes: [MODULE_ID],
    tag: "div",
    window: { title: "ESB.Title", icon: "fa-solid fa-images", resizable: true },
    position: { width: 1180, height: 760 },
    actions: {
      index: SceneBrowserApp.#onIndex,
      refresh: SceneBrowserApp.#onRefresh
    }
  };

  static PARTS = {
    main: { template: `${TEMPLATES}/browser.hbs` }
  };

  static #instance = null;
  static get instance() { return SceneBrowserApp.#instance; }

  /** @type {SceneCache|null} */ cache = null;
  /** @type {{tree:object[],scenes:object[],stats:object,nodeIndex:Map}|null} */ model = null;

  #query = "";
  /** @type {Set<string>} scoped node ids (union) */
  #scopes = new Set();
  #filters = { status: "", grid: "", size: "", content: "", system: "" };
  #sort = "name";
  #selectedUid = null;
  #expanded = new Set();
  #filtered = [];
  #rendered = 0;
  #observer = null;
  #searchTimer = null;

  static open() {
    if ( !game.user.isGM ) return null;
    SceneBrowserApp.#instance ??= new SceneBrowserApp();
    SceneBrowserApp.#instance.render({ force: true });
    return SceneBrowserApp.#instance;
  }

  /* ------------------------------ context ------------------------------ */

  /** @override */
  async _prepareContext() {
    this.cache ??= await SceneCache.load();
    if ( getSetting(SETTINGS.rememberState) ) this.#restoreState();
    this.model = await buildModel(this.cache);
    const stats = summarizeSources();
    const totals = this.cache.totals();
    const fmt = new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "short", timeStyle: "short" });
    return {
      query: this.#query,
      total: this.model.stats.total,
      canRead: SceneIndexer.fileAccess ?? (Number(game.version?.split(".")[0]) <= 13),
      cache: {
        empty: this.cache.packs.size === 0,
        generatedAt: this.cache.generatedAt ? fmt.format(this.cache.generatedAt) : null,
        scenes: totals.scenes, ok: totals.ok, errors: totals.errors,
        staleFiles: this.cache.staleFiles.length, dir: `Data/${this.cache.packsDir}`
      },
      inactiveModules: stats.inactiveModules
    };
  }

  /* ------------------------------ render ------------------------------ */

  /** @override */
  _onRender(context, options) {
    const root = this.element;
    this.#treeEl = root.querySelector(".esb-tree");
    this.#gridEl = root.querySelector(".esb-grid");
    this.#detailsEl = root.querySelector(".esb-details");
    this.#countEl = root.querySelector(".esb-shown-count");
    this.#sentinel = root.querySelector(".esb-sentinel");
    this.#gridEl.style.setProperty("--esb-card", `${getSetting(SETTINGS.cardSize) || 170}px`);

    this.#pinnedEl = root.querySelector(".esb-pinned");
    this.#pinnedEl.addEventListener("click", ev => {
      const row = ev.target.closest(".esb-pinned-row");
      if ( !row ) return;
      const id = row.dataset.id;
      if ( ev.target.closest(".esb-pin-remove") ) {
        this.#scopes.delete(id);
        this.#refilter();
        this.#renderScopes();
      } else {
        this.#revealNode(id);
      }
    });

    const search = root.querySelector('input[name="search"]');
    search.value = this.#query;
    search.addEventListener("input", ev => {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = setTimeout(() => this.#applySearch(ev.target.value), 150);
    });

    this.#treeEl.addEventListener("click", ev => this.#onTreeClick(ev));
    this.#gridEl.addEventListener("click", ev => this.#onGridClick(ev));
    this.#detailsEl.addEventListener("click", ev => this.#onDetailsClick(ev));
    this.#gridEl.addEventListener("dragstart", ev => this.#onDragStart(ev));

    // Filters + sort
    this.#populateSystems(root);
    for ( const sel of root.querySelectorAll(".esb-filters select[data-filter]") ) {
      sel.value = this.#filters[sel.dataset.filter] ?? "";
      sel.addEventListener("change", () => { this.#filters[sel.dataset.filter] = sel.value; this.#persist(); this.#refilter(); });
    }
    const sortSel = root.querySelector('.esb-filters select[name="sort"]');
    sortSel.value = this.#sort;
    sortSel.addEventListener("change", () => { this.#sort = sortSel.value; this.#persist(); this.#refilter(); });

    this.#buildTree();
    this.#refilter();
    this.#renderScopes();

    this.#observer?.disconnect();
    this.#observer = new IntersectionObserver(entries => {
      if ( entries.some(e => e.isIntersecting) ) this.#renderMore();
    }, { root: this.#gridEl.parentElement, rootMargin: "600px" });
    this.#observer.observe(this.#sentinel);
  }

  #treeEl; #gridEl; #detailsEl; #countEl; #sentinel; #pinnedEl;

  #populateSystems(root) {
    const sel = root.querySelector('.esb-filters select[name="system"]');
    if ( !sel ) return;
    const { systems, hasNone } = systemsIn(this.model.scenes);
    for ( const sys of systems ) {
      const opt = document.createElement("option");
      opt.value = sys; opt.textContent = sys;
      sel.append(opt);
    }
    if ( hasNone ) {
      const opt = document.createElement("option");
      opt.value = "__none__"; opt.textContent = game.i18n.localize("ESB.Filter.System.None");
      sel.append(opt);
    }
  }

  /* ------------------------------ tree ------------------------------ */

  #buildTree() {
    this.#treeEl.replaceChildren();
    for ( const node of this.model.tree ) this.#treeEl.append(this.#treeNode(node, 0));
  }

  #treeNode(node, depth) {
    const el = document.createElement("div");
    el.className = `esb-node type-${node.type}`;
    el.dataset.id = node.id;

    const row = document.createElement("div");
    row.className = "esb-node-row";
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    row.dataset.id = node.id;

    const hasChildren = node.children.length > 0;
    const twisty = document.createElement("i");
    twisty.className = hasChildren
      ? `esb-twisty fa-solid ${this.#expanded.has(node.id) ? "fa-caret-down" : "fa-caret-right"}`
      : "esb-twisty esb-twisty-empty";
    row.append(twisty);

    const typeIcon = node.icon ?? (node.type === "adventure" ? "fa-book-sparkles" : null);
    if ( typeIcon ) {
      const icon = document.createElement("i");
      icon.className = `esb-node-icon fa-solid ${typeIcon}`;
      row.append(icon);
    }
    if ( node.type === "pack" && node.status ) {
      const dot = document.createElement("span");
      dot.className = `esb-status-dot status-${node.status}`;
      dot.title = game.i18n.localize(`ESB.PackStatus.${node.status}`);
      row.append(dot);
    }

    const label = document.createElement("span");
    label.className = "esb-node-label";
    label.textContent = node.label;
    row.append(label);

    const count = document.createElement("span");
    count.className = "esb-node-count";
    row.append(count);
    el.append(row);

    if ( hasChildren ) {
      const kids = document.createElement("div");
      kids.className = "esb-node-children";
      kids.hidden = !this.#expanded.has(node.id);
      for ( const c of node.children ) kids.append(this.#treeNode(c, depth + 1));
      el.append(kids);
    }
    return el;
  }

  #onTreeClick(ev) {
    const twisty = ev.target.closest(".esb-twisty");
    const row = ev.target.closest(".esb-node-row");
    if ( !row ) return;
    const id = row.dataset.id;
    if ( twisty && !twisty.classList.contains("esb-twisty-empty") ) {
      this.#toggleNode(id);
      return;
    }
    const additive = ev.ctrlKey || ev.metaKey;
    if ( additive ) {
      if ( this.#scopes.has(id) ) this.#scopes.delete(id);
      else this.#scopes.add(id);
    } else if ( this.#scopes.size === 1 && this.#scopes.has(id) ) {
      this.#scopes.clear();   // clicking the sole selection again clears it (show everything)
    } else {
      this.#scopes.clear();
      this.#scopes.add(id);
    }
    this.#refilter();
    this.#renderScopes();
  }

  #toggleNode(id) {
    if ( this.#expanded.has(id) ) this.#expanded.delete(id);
    else this.#expanded.add(id);
    this.#persist();
    const el = this.#treeEl.querySelector(`.esb-node[data-id="${CSS.escape(id)}"]`);
    if ( !el ) return;
    const kids = el.querySelector(":scope > .esb-node-children");
    const twisty = el.querySelector(":scope > .esb-node-row > .esb-twisty");
    if ( kids ) kids.hidden = !this.#expanded.has(id);
    if ( twisty ) twisty.className = `esb-twisty fa-solid ${this.#expanded.has(id) ? "fa-caret-down" : "fa-caret-right"}`;
  }

  /** Human-readable trail for a node id (package › … › node), skipping the top group. */
  #nodeTrail(id) {
    const node = this.model.nodeIndex.get(id);
    if ( !node?.path ) return node?.label ?? "";
    return node.path.map(pid => this.model.nodeIndex.get(pid)).filter(n => n && n.type !== "group").map(n => n.label).join(" › ");
  }

  #renderScopes() {
    for ( const row of this.#treeEl.querySelectorAll(".esb-node-row.scoped") ) row.classList.remove("scoped");
    this.#pinnedEl.replaceChildren();
    if ( !this.#scopes.size ) { this.#pinnedEl.hidden = true; return; }

    const iconFor = node => node.icon ?? (node.type === "adventure" ? "fa-book-sparkles"
      : node.type === "pack" ? "fa-book-atlas" : node.type === "folder" ? "fa-folder" : "fa-cube");

    for ( const id of [...this.#scopes].reverse() ) {
      const node = this.model.nodeIndex.get(id);
      if ( !node ) { this.#scopes.delete(id); continue; }
      this.#treeEl.querySelector(`.esb-node[data-id="${CSS.escape(id)}"] > .esb-node-row`)?.classList.add("scoped");
      const chip = document.createElement("div");
      chip.className = "esb-pinned-row";
      chip.dataset.id = id;
      chip.title = this.#nodeTrail(id);
      const icon = document.createElement("i");
      icon.className = `esb-node-icon fa-solid ${iconFor(node)}`;
      const label = document.createElement("span");
      label.className = "esb-pinned-label";
      label.textContent = node.label;
      const remove = document.createElement("i");
      remove.className = "esb-pin-remove fa-solid fa-xmark";
      chip.append(icon, label, remove);
      this.#pinnedEl.append(chip);
    }
    if ( this.#scopes.size > 1 ) {
      const clearAll = document.createElement("button");
      clearAll.type = "button";
      clearAll.className = "esb-pin-clear";
      clearAll.title = game.i18n.localize("ESB.SelectedClear");
      clearAll.innerHTML = `<i class="fa-solid fa-xmark" inert></i> ${game.i18n.localize("ESB.SelectedClear")}`;
      clearAll.addEventListener("click", () => { this.#scopes.clear(); this.#refilter(); this.#renderScopes(); });
      this.#pinnedEl.append(clearAll);
    }
    this.#pinnedEl.hidden = false;
  }

  /** Expand ancestors of a node, scroll it into view and flash it. */
  #revealNode(id) {
    const node = this.model.nodeIndex.get(id);
    if ( !node?.path ) return;
    for ( const pid of node.path ) {
      if ( pid === id ) break;
      if ( !this.#expanded.has(pid) ) this.#toggleNode(pid);
    }
    const el = this.#treeEl.querySelector(`.esb-node[data-id="${CSS.escape(id)}"] > .esb-node-row`);
    if ( !el ) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 800);
  }

  /* ------------------------------ filtering ------------------------------ */

  #applySearch(value) {
    this.#query = value.trim();
    this.#persist();
    this.#refilter();
  }

  #refilter() {
    const tokens = tokenize(this.#query);
    const scopes = this.#scopes;
    const scoped = scopes.size > 0;
    const f = this.#filters;
    const filtering = anyActive(f);
    const counts = new Map();
    this.#filtered = [];
    for ( const rec of this.model.scenes ) {
      if ( scoped && !rec.path.some(id => scopes.has(id)) ) continue;
      if ( tokens.length && !matchesTokens(rec.search, tokens) ) continue;
      if ( filtering && !passes(rec, f) ) continue;
      this.#filtered.push(rec);
      for ( const nid of rec.path ) counts.set(nid, (counts.get(nid) ?? 0) + 1);
    }
    this.#filtered.sort(comparator(this.#sort));
    this.#updateTreeCounts(counts, tokens.length > 0 || filtering);
    this.#renderGrid();
  }

  #updateTreeCounts(counts, searching) {
    for ( const el of this.#treeEl.querySelectorAll(".esb-node") ) {
      const id = el.dataset.id;
      const n = counts.get(id) ?? 0;
      const countEl = el.querySelector(":scope > .esb-node-row > .esb-node-count");
      if ( countEl ) countEl.textContent = n ? String(n) : "";
      // While searching, hide empty branches and auto-expand matching ones.
      if ( searching ) {
        el.hidden = n === 0;
        const kids = el.querySelector(":scope > .esb-node-children");
        const twisty = el.querySelector(":scope > .esb-node-row > .esb-twisty");
        if ( kids && n > 0 ) {
          kids.hidden = false;
          if ( twisty && !twisty.classList.contains("esb-twisty-empty") ) twisty.classList.replace("fa-caret-right", "fa-caret-down");
        }
      } else {
        el.hidden = false;
        const kids = el.querySelector(":scope > .esb-node-children");
        const twisty = el.querySelector(":scope > .esb-node-row > .esb-twisty");
        if ( kids ) kids.hidden = !this.#expanded.has(id);
        if ( twisty && !twisty.classList.contains("esb-twisty-empty") ) twisty.className = `esb-twisty fa-solid ${this.#expanded.has(id) ? "fa-caret-down" : "fa-caret-right"}`;
      }
    }
  }

  /* ------------------------------ grid ------------------------------ */

  #renderGrid() {
    this.#gridEl.replaceChildren();
    this.#rendered = 0;
    this.#countEl.textContent = game.i18n.format("ESB.ShownCount", { shown: this.#filtered.length, total: this.model.stats.total });
    this.#renderMore();
    // Move the sentinel to the end so the observer keeps working.
    this.#gridEl.after(this.#sentinel);
  }

  #renderMore() {
    const end = Math.min(this.#rendered + CHUNK, this.#filtered.length);
    const frag = document.createDocumentFragment();
    for ( let i = this.#rendered; i < end; i++ ) frag.append(this.#card(this.#filtered[i]));
    this.#gridEl.append(frag);
    this.#rendered = end;
  }

  #cells(rec) {
    const size = rec.grid?.size;
    if ( !size || !rec.w || !rec.h ) return null;
    return `${Math.round(rec.w / size)}×${Math.round(rec.h / size)}`;
  }

  #card(rec) {
    const card = document.createElement("div");
    card.className = "esb-card";
    card.dataset.uid = rec.uid;
    if ( rec.uuid ) card.draggable = true;
    if ( rec.uid === this.#selectedUid ) card.classList.add("selected");

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "esb-card-thumb";
    // Prefer the thumbnail; if it is missing or fails to load, fall back to the scene background.
    const primary = rec.thumb || rec.bg;
    if ( primary ) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = rec.name;
      img.dataset.fallback = (rec.bg && rec.bg !== primary) ? rec.bg : "";
      img.addEventListener("error", () => {
        if ( img.dataset.fallback ) { img.src = img.dataset.fallback; img.dataset.fallback = ""; }
        else { img.remove(); thumbWrap.classList.add("no-thumb"); }
      });
      img.src = primary;
      thumbWrap.append(img);
    } else thumbWrap.classList.add("no-thumb");
    card.append(thumbWrap);

    const body = document.createElement("div");
    body.className = "esb-card-body";
    const name = document.createElement("div");
    name.className = "esb-card-name";
    name.textContent = rec.name || "—";
    name.title = rec.name;
    const sub = document.createElement("div");
    sub.className = "esb-card-sub";
    sub.textContent = rec.packageType === "world" ? game.i18n.localize("ESB.Tree.World") : `${rec.packageTitle} › ${rec.packLabel}`;
    sub.title = sub.textContent;
    body.append(name, sub);

    const meta = document.createElement("div");
    meta.className = "esb-card-meta";
    const cells = this.#cells(rec);
    if ( rec.w && rec.h ) {
      const dim = document.createElement("span");
      dim.textContent = `${rec.w}×${rec.h}${cells ? ` (${cells})` : ""}`;
      meta.append(dim);
    }
    if ( rec.counts ) {
      if ( rec.counts.walls ) meta.append(this.#badge("fa-block-brick", rec.counts.walls));
      if ( rec.counts.tokens ) meta.append(this.#badge("fa-chess-pawn", rec.counts.tokens));
      if ( rec.counts.lights ) meta.append(this.#badge("fa-lightbulb", rec.counts.lights));
    }
    body.append(meta);
    card.append(body);
    return card;
  }

  #badge(icon, n) {
    const b = document.createElement("span");
    b.className = "esb-count-badge";
    b.innerHTML = `<i class="fa-solid ${icon}" inert></i>${n}`;
    return b;
  }

  #onGridClick(ev) {
    const card = ev.target.closest(".esb-card");
    if ( !card ) return;
    this.#select(card.dataset.uid);
  }

  #select(uid) {
    this.#selectedUid = uid;
    for ( const c of this.#gridEl.querySelectorAll(".esb-card.selected") ) c.classList.remove("selected");
    this.#gridEl.querySelector(`.esb-card[data-uid="${CSS.escape(uid)}"]`)?.classList.add("selected");
    this.#persist();
    this.#renderDetails(this.model.scenes.find(s => s.uid === uid));
  }

  #renderDetails(rec) {
    const el = this.#detailsEl;
    el.replaceChildren();
    if ( !rec ) { el.classList.add("empty"); el.textContent = game.i18n.localize("ESB.Details.None"); return; }
    el.classList.remove("empty");

    const preview = document.createElement("div");
    preview.className = "esb-details-preview";
    const src = rec.bg || rec.thumb;
    if ( src ) {
      const img = document.createElement("img");
      img.loading = "lazy"; img.src = src; img.alt = rec.name;
      img.addEventListener("error", () => preview.classList.add("no-thumb"));
      preview.append(img);
    } else preview.classList.add("no-thumb");
    el.append(preview);

    const h = document.createElement("h3");
    h.className = "esb-details-name";
    h.textContent = rec.name || "—";
    el.append(h);

    const rows = [];
    const cells = this.#cells(rec);
    rows.push(["ESB.Details.Package", rec.packageType === "world" ? game.i18n.localize("ESB.Tree.World") : `${rec.packageTitle}`]);
    rows.push(["ESB.Details.Pack", rec.packLabel]);
    if ( rec.advName ) rows.push(["ESB.Details.Adventure", rec.advName]);
    if ( rec.w && rec.h ) rows.push(["ESB.Details.Size", `${rec.w}×${rec.h}${cells ? ` — ${cells} ${game.i18n.localize("ESB.Details.Cells")}` : ""}`]);
    if ( rec.grid?.size ) rows.push(["ESB.Details.Grid", `${rec.grid.size}px · ${rec.grid.distance ?? "?"} ${rec.grid.units ?? ""}`]);
    if ( rec.system ) rows.push(["ESB.Details.System", `${rec.system}${rec.core ? ` · ${game.i18n.localize("ESB.Details.Core")} ${rec.core}` : ""}`]);
    if ( rec.modified ) rows.push(["ESB.Details.Modified", new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium" }).format(new Date(rec.modified))]);
    rows.push(["ESB.Details.Origin", game.i18n.localize(`ESB.OriginLabel.${rec.origin}`)]);
    if ( rec.uuid ) rows.push(["ESB.Details.Uuid", rec.uuid]);

    const table = document.createElement("dl");
    table.className = "esb-details-table";
    for ( const [key, value] of rows ) {
      const dt = document.createElement("dt"); dt.textContent = game.i18n.localize(key);
      const dd = document.createElement("dd"); dd.textContent = value;
      table.append(dt, dd);
    }
    el.append(table);

    if ( rec.counts ) {
      const counts = document.createElement("div");
      counts.className = "esb-details-counts";
      for ( const [k, v] of Object.entries(rec.counts) ) if ( v ) {
        const chip = document.createElement("span");
        chip.className = "esb-count-badge";
        chip.textContent = `${game.i18n.localize(`ESB.Counts.${k}`)}: ${v}`;
        counts.append(chip);
      }
      if ( counts.children.length ) el.append(counts);
    }
    if ( rec.flags?.length ) {
      const flags = document.createElement("div");
      flags.className = "esb-details-flags";
      for ( const f of rec.flags ) {
        const chip = document.createElement("span"); chip.className = "esb-flag-chip"; chip.textContent = f;
        flags.append(chip);
      }
      el.append(flags);
    }
    el.append(this.#detailsActions(rec));
  }

  /** Build the action buttons for the selected scene, depending on where it lives. */
  #detailsActions(rec) {
    const bar = document.createElement("div");
    bar.className = "esb-actions";
    const add = (action, icon, labelKey, primary = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = primary ? "esb-action primary" : "esb-action";
      b.dataset.esbAction = action;
      b.innerHTML = `<i class="fa-solid ${icon}" inert></i> ${game.i18n.localize(labelKey)}`;
      bar.append(b);
    };
    if ( rec.origin === "world" ) {
      add("view", "fa-eye", "ESB.Action.View", true);
      add("activate", "fa-play", "ESB.Action.Activate");
    } else {
      add("import", "fa-download", "ESB.Action.Import", true);
      add("importView", "fa-eye", "ESB.Action.ImportView");
      if ( game.packs.get(rec.packCollection) ) add("showCompendium", "fa-book-atlas", "ESB.Action.ShowCompendium");
    }
    add("image", "fa-image", "ESB.Action.Image");
    if ( rec.uuid ) add("copyUuid", "fa-copy", "ESB.Action.CopyUuid");
    else if ( rec.bg || rec.thumb ) add("copyPath", "fa-copy", "ESB.Action.CopyPath");
    if ( !rec.active && rec.origin !== "world" ) {
      const note = document.createElement("p");
      note.className = "hint esb-actions-note";
      note.textContent = game.i18n.localize("ESB.Details.InactiveNote");
      bar.append(note);
    }
    return bar;
  }

  async #onDetailsClick(ev) {
    const btn = ev.target.closest("button[data-esb-action]");
    if ( !btn ) return;
    const rec = this.model.scenes.find(s => s.uid === this.#selectedUid);
    if ( !rec ) return;
    const action = btn.dataset.esbAction;
    btn.disabled = true;
    try {
      switch ( action ) {
        case "view": await actions.viewScene(rec); break;
        case "activate": await actions.activateScene(rec); break;
        case "import": await actions.importScene(rec, { folderPath: this.#importFolderPath(rec) }); break;
        case "importView": await actions.importScene(rec, { activate: true, folderPath: this.#importFolderPath(rec) }); break;
        case "showCompendium": await actions.showInCompendium(rec); break;
        case "image": actions.openImage(rec); break;
        case "copyUuid": await actions.copyText(rec.uuid); break;
        case "copyPath": await actions.copyText(rec.bg || rec.thumb); break;
      }
    } finally {
      btn.disabled = false;
    }
  }

  /** Folder chain for an imported scene: [import root?] › module title › in-pack folders. */
  #importFolderPath(rec) {
    const names = [];
    const root = actions.importRootName();
    if ( root ) names.push(root);
    if ( rec.packageType !== "world" ) names.push(rec.packageTitle);
    for ( const nid of rec.path ) {
      const node = this.model.nodeIndex.get(nid);
      if ( node?.type === "adventure" || node?.type === "folder" ) names.push(node.label);
    }
    return names;
  }

  #onDragStart(ev) {
    const card = ev.target.closest(".esb-card");
    if ( !card ) return;
    const rec = this.model.scenes.find(s => s.uid === card.dataset.uid);
    const data = rec && actions.dragData(rec);
    if ( !data ) { ev.preventDefault(); return; }
    ev.dataTransfer.setData("text/plain", JSON.stringify(data));
    ev.dataTransfer.effectAllowed = "copy";
  }

  /* ------------------------------ state ------------------------------ */

  #persist() {
    if ( !getSetting(SETTINGS.rememberState) ) return;
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => {
      setSetting(SETTINGS.uiState, {
        expanded: [...this.#expanded], filters: this.#filters, sort: this.#sort
      });
    }, 400);
  }
  #persistTimer;

  #restoreState() {
    // Only stable preferences are remembered across sessions. The active scope, search query and selection
    // are intentionally NOT restored: a forgotten scope would silently hide search results on the next open.
    const st = getSetting(SETTINGS.uiState) ?? {};
    this.#expanded = new Set(st.expanded ?? []);
    if ( st.filters ) this.#filters = { status: "", grid: "", size: "", content: "", system: "", ...st.filters };
    if ( st.sort ) this.#sort = st.sort;
    if ( !st.expanded ) for ( const id of ["group:world", "group:system", "group:modules"] ) this.#expanded.add(id);
  }

  /* ------------------------------ actions ------------------------------ */

  static async #onIndex() {
    if ( !this.cache ) return;
    new IndexingDialog({ cache: this.cache, onFinished: () => this.render() }).render({ force: true });
  }

  static async #onRefresh() {
    await this.cache?.reload();
    this.render();
  }

  /** @override */
  async close(options) {
    this.#observer?.disconnect();
    return super.close(options);
  }
}
