import type { DashboardData } from "../src/compiler/dashboard-data.js";
import { customRangeDashboard, type PeriodData } from "../src/compiler/period-data.js";
import { parseDaysKey } from "../src/compiler/periods.js";
import { renderDashboardBlocks } from "../src/render/page.js";
import { periodCaption, periodText } from "../src/render/period.js";

/**
 * The period engine: loaded by the runtime the first time a reader picks another range, so pages
 * that never change period never download it. It takes the data the page embeds (PeriodData),
 * picks the preset's DashboardData or assembles a custom range from the day-grain data, and draws
 * the blocks with the same renderer build uses. The runtime swaps them in.
 */

export interface PeriodView {
  /** The key the page now shows: a preset's when a custom range has the same dates. */
  key: string;
  blocks: string;
  caption: string;
  name: string;
  dates?: string;
  /** Labels of metrics shown as "—" because a custom range cannot compute them. */
  presetOnly: string[];
}

function view(payload: PeriodData, requested: string): PeriodView | undefined {
  const days = parseDaysKey(requested);
  const base = Object.values(payload.presets)[0]?.periodFilter;
  const same =
    days &&
    base?.options.find((o) => o.current?.start === days.start && o.current.end === days.end);
  const key = same ? same.key : requested;
  let data: DashboardData | undefined = payload.presets[key];
  let presetOnly: string[] = [];
  if (data === undefined && days && payload.custom) {
    data = customRangeDashboard(payload.custom, payload.filter, days);
    const metrics = data.metrics;
    presetOnly = payload.custom.presetOnly.flatMap((m) => (metrics[m] ? [metrics[m].label] : []));
  }
  if (data?.periodFilter === undefined) return undefined;
  const text = periodText(data.periodFilter, data.locale);
  return {
    key,
    blocks: renderDashboardBlocks(data),
    caption: periodCaption(data),
    name: text.name,
    ...(text.dates ? { dates: text.dates } : {}),
    presetOnly,
  };
}

(globalThis as { hatchmarkPeriods?: unknown }).hatchmarkPeriods = { view };
