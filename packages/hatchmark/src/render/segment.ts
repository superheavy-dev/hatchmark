import type { DashboardData } from "../compiler/dashboard-data.js";
import { esc } from "./svg.js";
import type { Theme } from "./theme.js";

const CHECK =
  '<svg class="hm-chip-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The segment filter: one toggle button per segment, pressed when it is on. Every combination is
 * built ahead, so the runtime only swaps in the chosen one's blocks.
 */
export function segmentControl(filter: NonNullable<DashboardData["segmentFilter"]>): string {
  const buttons = filter.options
    .map(
      (o) =>
        `<button type="button" class="hm-chip" aria-pressed="${filter.selected.includes(o.name)}" data-hm-segment="${esc(o.name)}">${CHECK}<span>${esc(o.label)}</span></button>`,
    )
    .join("");
  return `<div class="hm-chips" role="group" aria-label="${esc(filter.label)}" data-hm-segment-filter="${esc(filter.id)}"><span class="hm-chips-label" aria-hidden="true">${esc(filter.label)}</span>${buttons}</div>`;
}

export function segmentStyles(theme: Theme): string {
  const r = theme.radius.control;
  return [
    `.hm-chips{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;max-width:100%;min-width:0}.hm-chips-label{font-size:12px;line-height:16px;color:var(--hm-text-muted)}`,
    `.hm-chip{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;line-height:16px;font-weight:500;padding:4px 10px;background:var(--hm-card);color:var(--hm-text-muted);border:1px solid var(--hm-border);border-radius:${r}px;cursor:pointer;white-space:nowrap}.hm-chip:hover{color:var(--hm-text);border-color:var(--hm-border-strong)}.hm-chip:focus-visible{outline:2px solid var(--hm-focus);outline-offset:1px}`,
    `.hm-chip-check{display:none;flex-shrink:0}.hm-chip[aria-pressed=true]{color:var(--hm-text);border-color:var(--hm-border-strong);box-shadow:0 0 0 1px var(--hm-border-strong)}.hm-chip[aria-pressed=true] .hm-chip-check{display:block}`,
  ].join("");
}
