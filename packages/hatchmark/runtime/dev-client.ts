/// <reference types="vite/client" />
/**
 * The hatchmark dev client, served only by hatchmark dev and never part of a build. It listens on
 * Vite's HMR connection: hatchmark:update swaps the cards that changed and attaches the runtime to
 * them, hatchmark:reload reloads the page after a structural change, and hatchmark:error and
 * hatchmark:ok show and clear the diagnostics overlay.
 */

interface CardUpdate {
  /** Position of the card among the grid's children. */
  index: number;
  /** Position of the KPI inside a strip, when only that KPI changed. */
  kpi?: number;
  html: string;
}

const state = JSON.parse(document.getElementById("hm-dev")?.textContent ?? "{}") as {
  dashboard?: string;
};

const fragment = (html: string): Element | null => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.firstElementChild;
};

const hot = import.meta.hot;
if (hot) {
  hot.on("hatchmark:update", (event: { dashboard: string; cards: CardUpdate[] }) => {
    if (event.dashboard !== state.dashboard) return;
    const grid = document.querySelector("main.hm-grid");
    for (const update of event.cards) {
      const item = grid?.children[update.index];
      const target =
        update.kpi === undefined ? item : item?.querySelectorAll(":scope > .hm-kpi")[update.kpi];
      const next = fragment(update.html);
      if (!target || !next) {
        location.reload();
        return;
      }
      target.replaceWith(next);
      window.hatchmark?.mount(next);
    }
  });
  hot.on("hatchmark:reload", (event: { dashboard?: string }) => {
    if (event.dashboard === undefined || event.dashboard === state.dashboard) location.reload();
  });
  hot.on("hatchmark:error", (event: { overlay: string }) => {
    document.getElementById("hm-dev-overlay")?.remove();
    const overlay = fragment(event.overlay);
    if (overlay) document.body.append(overlay);
  });
  hot.on("hatchmark:ok", () => {
    document.getElementById("hm-dev-overlay")?.remove();
  });
}
