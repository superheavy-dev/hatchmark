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

const checked = (group: Element | null | undefined): string | undefined =>
  group?.querySelector<HTMLElement>("button[aria-checked=true]")?.dataset.hmGrain;

/**
 * Gives a swapped-in card the grain the reader had chosen: each segmented control takes the old
 * card's selection when the new card offers it, else the header grain filter's. The runtime is
 * already attached, so a click on the button selects the grain as a reader's click would.
 */
const keepGrains = (before: Element, after: Element) => {
  const old = [...before.querySelectorAll(".hm-seg")];
  const page = checked(document.querySelector("[data-hm-grain-filter]"));
  after.querySelectorAll(".hm-seg").forEach((group, i) => {
    for (const key of [checked(old[i]), page]) {
      const button = [...group.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.dataset.hmGrain === key,
      );
      if (key === undefined || !button) continue;
      if (button.getAttribute("aria-checked") !== "true") button.click();
      return;
    }
  });
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
      keepGrains(target, next);
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
