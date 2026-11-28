import type { DashboardData } from "../src/compiler/dashboard-data.js";
import { customRangeDashboard, type PeriodData } from "../src/compiler/period-data.js";
import { parseDaysKey } from "../src/compiler/periods.js";
import type { Geographies } from "../src/render/chart.js";
import { useRanges } from "../src/render/format.js";
import { renderDashboardBlocks } from "../src/render/page.js";
import { periodCaption, periodText } from "../src/render/period.js";
import { valueLang } from "../src/render/svg.js";

export interface PeriodView {
  key: string;
  blocks: string;
  caption: string;
  name: string;
  dates?: string;
  nameIsDates: boolean;
  lang?: string;
  presetOnly: string[];
}

function view(
  payload: PeriodData,
  requested: string,
  ranges: Record<string, string> = {},
): PeriodView | undefined {
  useRanges(ranges);
  const days = parseDaysKey(requested);
  const key = requested;
  let data: DashboardData | undefined = payload.presets[key];
  let presetOnly: string[] = [];
  if (data === undefined && days && payload.custom) {
    data = customRangeDashboard(payload.custom, payload.filter, days);
    const metrics = data.metrics;
    presetOnly = payload.custom.presetOnly.flatMap((m) => (metrics[m] ? [metrics[m].label] : []));
  }
  if (data?.periodFilter === undefined) return undefined;
  const text = periodText(data.periodFilter, data.locale);
  const lang = valueLang(data.locale);
  return {
    key,
    blocks: renderDashboardBlocks(
      data,
      undefined,
      (globalThis as { hatchmarkGeo?: Geographies }).hatchmarkGeo,
    ),
    caption: periodCaption(data),
    name: text.name,
    ...(text.dates ? { dates: text.dates } : {}),
    nameIsDates: text.nameIsDates,
    ...(lang === undefined ? {} : { lang }),
    presetOnly,
  };
}

function render(
  data: DashboardData,
  ranges: Record<string, string> = {},
): { blocks: string; caption: string } {
  useRanges(ranges);
  return {
    blocks: renderDashboardBlocks(
      data,
      undefined,
      (globalThis as { hatchmarkGeo?: Geographies }).hatchmarkGeo,
    ),
    caption: periodCaption(data),
  };
}

(globalThis as { hatchmarkPeriods?: unknown }).hatchmarkPeriods = { view, render };
