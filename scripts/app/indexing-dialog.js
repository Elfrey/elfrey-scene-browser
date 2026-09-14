/**
 * IndexingDialog — plans an indexing run (what will be read, how much will be downloaded), runs it with a
 * progress bar and a cancel button, and reports the outcome.
 */
import { MODULE_ID, TEMPLATES, SETTINGS, getSetting, setSetting } from "../settings.js";
import { SceneIndexer } from "../indexer.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export function formatMB(bytes) {
  const mb = (bytes ?? 0) / 1e6;
  return mb >= 100 ? mb.toFixed(0) : mb >= 10 ? mb.toFixed(1) : mb.toFixed(2);
}

export class IndexingDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-indexing`,
    classes: [MODULE_ID, "esb-indexing"],
    tag: "div",
    window: {
      title: "ESB.Indexing.Title",
      icon: "fa-solid fa-magnifying-glass-chart",
      resizable: false,
      contentClasses: ["standard-form"]
    },
    position: { width: 600, height: "auto" },
    actions: {
      start: IndexingDialog.#onStart,
      cancel: IndexingDialog.#onCancel,
      close: IndexingDialog.#onClose,
      toggleLive: IndexingDialog.#onToggleLive
    }
  };

  static PARTS = {
    main: { template: `${TEMPLATES}/indexing.hbs` }
  };

  /**
   * @param {object} options
   * @param {import("../cache.js").SceneCache} options.cache
   * @param {Function} [options.onFinished]   Called with the run result when indexing ends
   */
  constructor({ cache, onFinished, ...options } = {}) {
    super(options);
    this.cache = cache;
    this.onFinished = onFinished;
    this.indexer = new SceneIndexer(cache);
    this.plan = null;
    this.runState = { phase: "idle" };
    this.#lastDone = -1;
  }

  #lastDone;

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext() {
    const { phase } = this.runState;
    const summary = this.plan?.summary;
    return {
      phase,
      isPlanning: phase === "planning",
      isReady: phase === "ready",
      isRunning: phase === "running",
      isFinished: ["done", "cancelled", "error"].includes(phase),
      includeLive: getSetting(SETTINGS.indexActivePacks),
      error: this.runState.error ?? null,
      summary: summary && {
        ...summary,
        mb: formatMB(summary.bytes),
        nothingToDo: (summary.read + summary.api) === 0
      },
      progress: this.#progressContext(this.runState.progress),
      result: this.runState.result && {
        ...this.runState.result,
        cancelled: this.runState.phase === "cancelled",
        okCount: this.runState.result.results.filter(r => r.status === "ok").length,
        failures: this.runState.result.results.filter(r => r.status !== "ok"),
        staleFiles: this.cache.staleFiles.length,
        packsDir: `Data/${this.cache.packsDir}`
      }
    };
  }

  #progressContext(progress) {
    if ( !progress ) return null;
    const percent = progress.totalBytes ? Math.min(100, Math.round(100 * progress.loaded / progress.totalBytes)) : (progress.total ? Math.round(100 * progress.done / progress.total) : 0);
    const current = progress.current;
    return {
      ...progress,
      percent,
      loadedMB: formatMB(progress.loaded),
      totalMB: formatMB(progress.totalBytes),
      currentLabel: current ? `${current.source.packageTitle} › ${current.source.label}` : "",
      recent: progress.results.slice(-6).reverse()
    };
  }

  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#replan();
  }

  async #replan() {
    this.runState = { phase: "planning", progress: null, planning: { done: 0, total: 0 } };
    this.render();
    try {
      this.plan = await this.indexer.plan({
        includeLive: getSetting(SETTINGS.indexActivePacks),
        onProgress: p => this.#updatePlanning(p)
      });
      this.runState = { phase: "ready" };
    } catch ( err ) {
      console.error(`${MODULE_ID} |`, err);
      this.runState = { phase: "error", error: err?.message ?? String(err) };
    }
    this.render();
  }

  #updatePlanning({ done, total }) {
    const el = this.element?.querySelector("[data-planning]");
    if ( el ) el.textContent = `${done} / ${total}`;
  }

  #updateProgress(progress) {
    this.runState.progress = progress;
    if ( progress.done !== this.#lastDone ) {
      this.#lastDone = progress.done;
      this.render();
      return;
    }
    const ctx = this.#progressContext(progress);
    const root = this.element;
    if ( !root ) return;
    const bar = root.querySelector(".esb-progress-bar > span");
    if ( bar ) bar.style.width = `${ctx.percent}%`;
    const text = root.querySelector("[data-progress-bytes]");
    if ( text ) text.textContent = `${ctx.loadedMB} / ${ctx.totalMB} MB`;
    const current = root.querySelector("[data-progress-current]");
    if ( current ) current.textContent = ctx.currentLabel;
  }

  /* -------------------------------------------- */

  static async #onStart() {
    if ( !this.plan || (this.runState.phase !== "ready") ) return;
    this.#lastDone = -1;
    this.runState = { phase: "running", progress: { done: 0, failed: 0, total: 0, loaded: 0, totalBytes: this.plan.summary.bytes, scenes: 0, warnings: 0, current: null, results: [] } };
    this.render();
    let result;
    try {
      result = await this.indexer.run(this.plan, { onProgress: p => this.#updateProgress(p) });
      this.runState = { phase: result.cancelled ? "cancelled" : "done", result };
    } catch ( err ) {
      console.error(`${MODULE_ID} |`, err);
      this.runState = { phase: "error", error: err?.message ?? String(err) };
    }
    this.render();
    this.onFinished?.(result);
  }

  static #onCancel() {
    this.indexer.cancel();
  }

  static #onClose() {
    this.close();
  }

  static async #onToggleLive(event, target) {
    await setSetting(SETTINGS.indexActivePacks, !!target.checked);
    this.#replan();
  }

  /** @override */
  async close(options) {
    if ( this.runState.phase === "running" ) this.indexer.cancel();
    return super.close(options);
  }
}
