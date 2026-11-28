import type { DashboardData, PeriodFilter } from "../compiler/dashboard-data.js";
import { formatSpan } from "./format.js";
import { esc, langAttr } from "./svg.js";
import type { Theme } from "./theme.js";

/**
 * The dashboard's period control: a button that names the range shown, opening a dialog with the
 * presets and, when the filter offers custom ranges, a calendar for any first and last day. The
 * server draws the button and the dialog shell; the runtime draws the calendar months and swaps
 * the page's blocks for the chosen range (see runtime/main.ts).
 */

/** What the control shows for a range: the preset's name, and its dates; a range without a name shows its dates as the name. */
export function periodText(
  filter: PeriodFilter,
  locale: string,
): { name: string; dates?: string; nameIsDates: boolean } {
  const option = filter.options.find((o) => o.key === filter.selected);
  const dates = option?.current ? formatSpan(option.current, locale) : undefined;
  if (option?.label !== undefined) {
    return { name: option.label, ...(dates ? { dates } : {}), nameIsDates: false };
  }
  const [first, last] = filter.selected.split("..");
  if (first !== undefined && last !== undefined && option === undefined) {
    const end = new Date(`${last}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const name = formatSpan({ start: first, end: end.toISOString().slice(0, 10) }, locale);
    return { name, nameIsDates: true };
  }
  return { name: dates ?? filter.selected, nameIsDates: dates !== undefined };
}

/**
 * How the custom range fields write a day in the project locale: a Gregorian numeric pattern such
 * as DD.MM.YYYY, and the locale's digits when they are not 0-9. The page embeds both so a browser
 * without that locale's data reads and writes days exactly like the build.
 */
export function fieldFormat(locale: string): { pattern: string; digits?: string } {
  const tag = Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0 ? locale : "en-US";
  const options = { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" } as const;
  const pattern = new Intl.DateTimeFormat(tag, {
    ...options,
    calendar: "gregory",
    numberingSystem: "latn",
  })
    .formatToParts(Date.UTC(2026, 0, 2))
    .map((p) =>
      p.type === "day" ? "DD" : p.type === "month" ? "MM" : p.type === "year" ? "YYYY" : p.value,
    )
    .join("");
  const { numberingSystem } = new Intl.DateTimeFormat(tag, options).resolvedOptions();
  if (numberingSystem === "latn") return { pattern };
  const native = new Intl.NumberFormat("en-US", { numberingSystem, useGrouping: false });
  return { pattern, digits: Array.from({ length: 10 }, (_, d) => native.format(d)).join("") };
}

/** The header caption: the window shown and its comparison, then the currency. */
export function periodCaption(data: DashboardData): string {
  const locale = data.locale;
  const period = data.period.current
    ? `${formatSpan(data.period.current, locale)}${data.period.previous ? ` compared with ${formatSpan(data.period.previous, locale)}` : ""}`
    : "All time";
  return `${period} \u00B7 ${data.currency}`;
}

const ICON =
  '<svg class="hm-period-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false"><rect x="1.5" y="2.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor"/><path d="M1.5 5.5h11M4.5 1v3M9.5 1v3" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>';

/**
 * The control's markup. engine is the URL of the script that recomputes the page for another range;
 * weekStart orders the calendar's weekday columns (0 is Monday).
 */
export function periodControl(
  data: DashboardData & { periodFilter: PeriodFilter },
  engine: string | undefined,
  weekStart: number,
): string {
  const filter = data.periodFilter;
  const locale = data.locale;
  const id = `hm-period-${esc(filter.id)}`;
  const lang = langAttr(locale);
  const { name, dates, nameIsDates } = periodText(filter, locale);
  const presets = filter.options
    .map((o) => {
      const label = o.label ?? (o.current ? formatSpan(o.current, locale) : o.key);
      const span = o.label !== undefined && o.current ? formatSpan(o.current, locale) : "";
      return `<button type="button" role="radio" aria-checked="${o.key === filter.selected}" tabindex="${o.key === filter.selected ? 0 : -1}" data-hm-preset="${esc(o.key)}"><span${o.label === undefined && o.current ? lang : ""}>${esc(label)}</span>${span ? `<span class="hm-period-dates"${lang}>${esc(span)}</span>` : ""}</button>`;
    })
    .join("");
  const field = fieldFormat(locale);
  const custom = filter.custom
    ? `<div class="hm-cal" data-hm-min="${esc(filter.custom.start)}" data-hm-end="${esc(filter.custom.end)}" data-hm-week="${weekStart}" data-hm-pattern="${esc(field.pattern)}"${field.digits ? ` data-hm-digits="${esc(field.digits)}"` : ""}><p class="hm-cal-title" id="${id}-c">Custom range</p><div class="hm-cal-fields"><label>Start<input type="text" inputmode="numeric" autocomplete="off" placeholder="${esc(field.pattern)}" data-hm-edge="start"${lang}></label><label>End<input type="text" inputmode="numeric" autocomplete="off" placeholder="${esc(field.pattern)}" data-hm-edge="end"${lang}></label></div><div class="hm-cal-months"></div><p class="hm-cal-status" aria-live="polite"></p><div class="hm-cal-actions"><button type="button" data-hm-cal="cancel">Cancel</button><button type="button" class="hm-primary" data-hm-cal="apply" disabled>Apply</button></div></div>`
    : "";
  return `<div class="hm-period" data-hm-period="${esc(filter.id)}" data-hm-locale="${esc(locale)}"${engine ? ` data-hm-engine="${esc(engine)}"` : ""}><button type="button" class="hm-period-button" aria-haspopup="dialog" aria-expanded="false" aria-controls="${id}"><span class="hm-sr">${esc(filter.label)}: </span>${ICON}<span class="hm-period-name"${nameIsDates ? lang : ""}>${esc(name)}</span>${dates ? `<span class="hm-period-dates"${lang}>${esc(dates)}</span>` : ""}</button><div class="hm-period-panel" id="${id}" role="dialog" aria-label="${esc(filter.label)}" hidden><div class="hm-period-presets" role="radiogroup" aria-label="Presets">${presets}</div>${custom}</div></div>`;
}

/** The control's styles, in the Default theme's control language (the grain switch's). */
export function periodStyles(theme: Theme): string {
  const r = theme.radius.control;
  return [
    `.hm-period{position:relative;max-width:100%}.hm-period-button{display:inline-flex;align-items:center;gap:6px;max-width:100%;font:inherit;font-size:12px;line-height:16px;font-weight:500;padding:5px 10px;background:var(--hm-card);color:var(--hm-text);border:1px solid var(--hm-border);border-radius:${r}px;cursor:pointer;white-space:nowrap}.hm-period-button:hover{border-color:var(--hm-border-strong)}.hm-period-button[aria-expanded=true]{border-color:var(--hm-border-strong);box-shadow:0 0 0 1px var(--hm-border-strong)}.hm-period-icon{flex-shrink:0;color:var(--hm-text-muted)}.hm-period-button .hm-period-dates{font-weight:400;color:var(--hm-text-muted);overflow:hidden;text-overflow:ellipsis}`,
    `.hm-period-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:20;display:flex;gap:16px;padding:12px;background:var(--hm-card);border:1px solid var(--hm-border-strong);border-radius:${theme.radius.card}px;box-shadow:var(--hm-shadow);text-align:left}.hm-period-panel[hidden]{display:none}`,
    `.hm-period-presets{display:flex;flex-direction:column;gap:2px;min-width:168px}.hm-period-presets button{display:flex;flex-direction:column;align-items:flex-start;gap:0;font:inherit;font-size:13px;line-height:18px;padding:6px 8px;border:0;border-radius:${Math.max(0, r - 1)}px;background:transparent;color:var(--hm-text);cursor:pointer;text-align:left}.hm-period-presets button:hover{background:var(--hm-card-alt)}.hm-period-presets button[aria-checked=true]{background:var(--hm-card-alt);box-shadow:inset 0 0 0 1px var(--hm-border-strong);font-weight:500}.hm-period-presets .hm-period-dates{font-size:12px;line-height:16px;font-weight:400;color:var(--hm-text-subtle)}`,
    `.hm-cal{display:flex;flex-direction:column;gap:10px;padding-left:16px;border-left:1px solid var(--hm-border)}.hm-cal-title{font-size:12px;line-height:16px;font-weight:500;color:var(--hm-text-muted)}.hm-cal-fields{display:flex;gap:8px}.hm-cal-fields label{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:16px;color:var(--hm-text-muted)}.hm-cal-fields input{width:12ch;font:inherit;font-size:13px;line-height:18px;padding:4px 6px;color:var(--hm-text);background:var(--hm-card);border:1px solid var(--hm-border-strong);border-radius:${r}px;min-width:0}`,
    `.hm-cal-months{position:relative;display:flex;gap:16px}.hm-cal-nav{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;pointer-events:none}.hm-cal-nav button{pointer-events:auto;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:14px;padding:0;border:1px solid var(--hm-border);border-radius:${r}px;background:var(--hm-card);color:var(--hm-text-muted);cursor:pointer}.hm-cal-nav button:disabled{opacity:.4;cursor:default}.hm-month{display:flex;flex-direction:column;gap:6px}.hm-month-name{height:24px;font-size:13px;line-height:24px;font-weight:500;text-align:center}`,
    `.hm-days{border-collapse:separate;border-spacing:0 2px}.hm-days th{width:32px;height:20px;font-size:11px;line-height:16px;font-weight:400;color:var(--hm-text-subtle);text-align:center}.hm-days td{padding:0;text-align:center}.hm-days button{width:32px;height:30px;font:inherit;font-size:12px;line-height:16px;padding:0;border:0;border-radius:${r}px;background:transparent;color:var(--hm-text);cursor:pointer;font-variant-numeric:tabular-nums}.hm-days button:hover{box-shadow:inset 0 0 0 1px var(--hm-border-strong)}.hm-days button[aria-disabled=true]{color:var(--hm-text-subtle);opacity:.45;cursor:default;box-shadow:none}.hm-days td.hm-in button{border-radius:0}.hm-days td.hm-in{background:var(--hm-border)}.hm-days button[aria-selected=true]{background:var(--hm-accent);color:var(--hm-accent-contrast);border-radius:${r}px;font-weight:500}`,
    `.hm-cal-status{font-size:12px;line-height:16px;color:var(--hm-text-muted);min-height:16px}.hm-cal-actions{display:flex;justify-content:flex-end;gap:8px}.hm-cal-actions button{font:inherit;font-size:12px;line-height:16px;font-weight:500;padding:5px 12px;border:1px solid var(--hm-border-strong);border-radius:${r}px;background:var(--hm-card);color:var(--hm-text);cursor:pointer}.hm-cal-actions .hm-primary{background:var(--hm-accent);border-color:var(--hm-accent);color:var(--hm-accent-contrast)}.hm-cal-actions button:disabled{opacity:.45;cursor:default}`,
    `.hm-period button:focus-visible,.hm-period input:focus-visible{outline:2px solid var(--hm-focus);outline-offset:1px}.hm-cal-fields input[aria-invalid=true]{border-color:var(--hm-bad)}.hm-period-note{font-size:12px;line-height:16px;color:var(--hm-text-muted)}.hm-period-note[hidden]{display:none}.hm-grid[aria-busy=true]{opacity:.6;transition:opacity .15s}`,
  ].join("");
}

/** Below 600 px the dialog spans the page, presets wrap above one calendar month. */
export const PERIOD_MOBILE =
  ".hm-period{align-self:stretch}.hm-period-button{width:100%}.hm-period-panel{left:0;right:0;flex-direction:column;gap:12px}.hm-period-presets{flex-direction:row;flex-wrap:wrap;min-width:0}.hm-period-presets button{border:1px solid var(--hm-border)}.hm-cal{padding-left:0;border-left:0;padding-top:12px;border-top:1px solid var(--hm-border)}.hm-month+.hm-month{display:none}.hm-days{width:100%}.hm-days button{width:100%;height:36px}.hm-cal-fields label{flex:1;min-width:0}.hm-cal-fields input{width:100%;box-sizing:border-box}";
