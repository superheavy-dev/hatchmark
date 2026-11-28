import type {
  BarData,
  BlockData,
  DashboardData,
  GrainOption,
  GrainSwitch,
  KpiData,
  LineData,
  PieData,
  ScatterData,
  TableData,
} from "../compiler/dashboard-data.js";
import type { PeriodData } from "../compiler/period-data.js";
import { type HeightPreset, layoutItems, MIN_CHART_SPAN } from "../spec/layout.js";
import { barCategories, barHeight, renderBar } from "./bar.js";
import type { RenderContext } from "./chart.js";
import { chartRuntimeData, chartTable, describeChart } from "./describe.js";
import { formatDate, formatSpan, recordRanges } from "./format.js";
import { renderKpi } from "./kpi.js";
import { renderLine } from "./line.js";
import { timeOf } from "./partial.js";
import { PERIOD_MOBILE, periodCaption, periodControl, periodStyles, periodText } from "./period.js";
import { isPie, pieHeight, renderPie } from "./pie.js";
import { renderScatter } from "./scatter.js";
import { esc, scriptJson } from "./svg.js";

export { scriptJson };

import { renderTable, tableHeight } from "./table.js";
import {
  type BlockHeight,
  COLOR_KEYS,
  colorValue,
  cssPaint,
  cssVar,
  DEFAULT_THEME,
  type Device,
  groupColorKeys,
  hexPaint,
  type Mode,
  type Theme,
} from "./theme.js";

/**
 * Page layouts, widest first; min is the space a layout needs (content plus page padding). Charts
 * are pre-rendered at each layout's exact pixel width and container queries on the page's root
 * show the one that matches, so chart text is always measured for the width it is drawn at and
 * never scaled. Between breakpoints the page keeps the narrower layout's width, centred. Container
 * queries (not media queries) let the same markup work inside an iframe, a gallery tile or an
 * embed. Below the narrowest layout (phones under 360 px) charts scale down to fit.
 */
export const LAYOUTS = [
  { min: 1440, content: 1392, page: 24, grid: true, mobile: false },
  { min: 1280, content: 1232, page: 24, grid: true, mobile: false },
  { min: 1024, content: 976, page: 24, grid: true, mobile: false },
  { min: 768, content: 720, page: 24, grid: false, mobile: false },
  { min: 600, content: 552, page: 24, grid: false, mobile: false },
  { min: 390, content: 358, page: 16, grid: false, mobile: true },
  { min: 0, content: 328, page: 16, grid: false, mobile: true },
] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Weekdays from Monday, to order the calendar's columns from the project's week anchor. */
const WEEK_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The container query of the phone layouts: below the narrowest layout that is not mobile. */
export const PHONE_QUERY = `(max-width:${Math.min(...LAYOUTS.filter((l) => !l.mobile).map((l) => l.min)) - 0.02}px)`;

/**
 * Styles for one non-default height preset, scoped to the elements that carry it, so a page that
 * uses no preset keeps its stylesheet unchanged.
 */
export function heightStyle(
  theme: Theme,
  preset: HeightPreset,
  rules: (h: BlockHeight, scope: string) => string,
  print = "",
): string {
  const scope = `[data-hm-height=${preset}]`;
  const { desktop, phone } = theme.height[preset];
  return `<style>${rules(desktop, scope)}@container hm ${PHONE_QUERY}{${rules(phone, scope)}}${print ? `@media print{${print.replaceAll("&", scope)}}` : ""}</style>`;
}

/** One bundled font file: the page loads it with @font-face from a relative URL. */
export interface FontFile {
  file: string;
  weight: 400 | 500 | 600;
  unicodeRange: string;
}

const LATIN1 =
  "U+0020-007E, U+00A0-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2013-2014, U+2018-201A, U+201C-201E, U+2020-2022, U+2026, U+2030, U+2039-203A, U+2044, U+20AC, U+2122, U+2212, U+FB01-FB02";
const LATIN2 =
  "U+0100-0101, U+0104-0130, U+0132-0151, U+0154-017F, U+018F, U+0192, U+01A0-01A1, U+01AF-01B0, U+01FA-01FF, U+0218-021B, U+0237, U+0259, U+1E80-1E85, U+1E9E, U+20A1, U+20A4, U+20A6, U+20A8-20AA, U+20AD-20AE, U+20B1-20B2, U+20B4-20B5, U+20B8-20BA, U+20BD, U+20BF";

/** The IBM Plex Sans subsets in assets/fonts that pages use (SIL OFL 1.1, see assets/fonts/OFL.txt). */
export const FONT_FILES: FontFile[] = (
  [
    [400, "Regular"],
    [500, "Medium"],
    [600, "SemiBold"],
  ] as const
).flatMap(([weight, style]) => [
  { file: `IBMPlexSans-${style}-Latin1.woff2`, weight, unicodeRange: LATIN1 },
  { file: `IBMPlexSans-${style}-Latin2.woff2`, weight, unicodeRange: LATIN2 },
]);

/** Where a page finds its assets, as URLs relative to the page. */
export interface PageAssets {
  /** The browser runtime script. */
  runtime: string;
  /** The script that recomputes a page for another period (runtime/periods.ts), when one is used. */
  periods?: string;
  /** URL per font file name from FONT_FILES. */
  fonts: Record<string, string>;
}

export interface PageOptions {
  assets: PageAssets;
  theme?: Theme;
  /** Data files the dashboard reads, named in the footer. */
  sources?: string[];
  /** Presets and day-grain data for the period filter, embedded in the page (runPeriodData). */
  periods?: PeriodData;
}

function context(data: DashboardData, theme: Theme): RenderContext {
  return { data, theme, paint: cssPaint };
}

const humanize = (column: string) => column.replaceAll("_", " ");

/** "A", "A and B", "A, B and C". */
const listOf = (labels: string[]) =>
  labels.length <= 2
    ? labels.join(" and ")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;

function metricLabels(ctx: RenderContext, names: string[]): string {
  return listOf([...new Set(names)].map((n) => ctx.data.metrics[n]?.label ?? n));
}

/** The card title (the block's, else what it measures) and a subtitle saying what is measured. */
export function blockHeading(
  block: LineData | BarData | PieData | TableData | ScatterData,
  ctx: RenderContext,
): { title: string; subtitle: string } {
  const locale = ctx.data.locale;
  if (block.type === "scatter") return scatterHeading(block, ctx);
  if (isPie(block)) {
    const what = `${metricLabels(ctx, [block.metric])} by ${humanize(block.column)}`;
    const window = block.window ?? ctx.data.period.current;
    const span = window ? formatSpan(window, locale) : undefined;
    const extra = block.other
      ? `top ${block.slices.length} of ${block.slices.length + block.other.count}`
      : undefined;
    const subtitle = [what, span, extra].filter((p) => p !== undefined).join(", ");
    return {
      title: block.title ?? what,
      subtitle: block.title ? subtitle : [span, extra].filter(Boolean).join(", "),
    };
  }
  const measured = metricLabels(
    ctx,
    block.type === "table" ? block.metrics : block.series.map((s) => s.metric),
  );
  let by: string;
  let span: string | undefined;
  if (block.type === "table") {
    by = listOf(block.by.map((b) => b.label));
    span = tableSpan(block, ctx);
  } else if (block.axis.kind === "time") {
    by = block.axis.grain;
    span = formatSpan(block.axis.window, locale);
  } else {
    by = humanize(block.axis.column);
    span = ctx.data.period.current ? formatSpan(ctx.data.period.current, locale) : undefined;
  }
  const what = `${measured} by ${by}`;
  const extra =
    block.type === "bar" && block.omittedCategories
      ? `top ${barCategories(block, locale).length} of ${barCategories(block, locale).length + block.omittedCategories}`
      : undefined;
  const subtitle = [what, span, extra].filter((p) => p !== undefined).join(", ");
  return {
    title: block.title ?? what,
    subtitle: block.title ? subtitle : [span, extra].filter(Boolean).join(", "),
  };
}

function tableSpan(block: TableData, ctx: RenderContext): string | undefined {
  if (block.empty) return undefined;
  const locale = ctx.data.locale;
  if (block.window?.endAt !== undefined) {
    return `${formatSpan(block.window, locale)}, through ${timeOf(block.window.endAt, locale)}`;
  }
  return block.window
    ? formatSpan(block.window, locale)
    : block.through
      ? `through ${formatDate(block.through, locale)}`
      : "all time";
}

/**
 * A scatter card's heading: "Average order value against Orders by country", the window, how many
 * points a limit kept, and how many categories have no x or y value to place them at.
 */
function scatterHeading(
  block: ScatterData,
  ctx: RenderContext,
): { title: string; subtitle: string } {
  const label = (m: string) => ctx.data.metrics[m]?.label ?? m;
  const what = `${label(block.y)} against ${label(block.x)} by ${humanize(block.column)}`;
  const dated = block.window
    ? formatSpan(block.window, ctx.data.locale)
    : block.through
      ? `through ${formatDate(block.through, ctx.data.locale)}`
      : undefined;
  const span = dated
    ? [dated, ...(block.allTime ?? []).map((m) => `${label(m)} over all time`)].join(", ")
    : block.empty
      ? undefined
      : "all time";
  const shown = block.points.length;
  const limited = block.omittedCategories
    ? `top ${shown} of ${shown + block.omittedCategories}`
    : undefined;
  const missing = block.omittedPoints ? `${block.omittedPoints} without data not shown` : undefined;
  const extra = [span, limited, missing].filter((p) => p !== undefined);
  return {
    title: block.title ?? what,
    subtitle: (block.title ? [what, ...extra] : extra)
      .join(", ")
      .replace(/^./, (c) => c.toUpperCase()),
  };
}

/**
 * The columns a chart card takes: its span, but never fewer than MIN_CHART_SPAN (check warns with
 * HM2024). CSS grid auto-placement moves the card to the next row when the widened card no longer
 * fits beside the cards before it, so the layout stays a function of the spec alone.
 */
function chartSpan(block: LineData | BarData | PieData | ScatterData): number {
  return Math.max(block.span, MIN_CHART_SPAN);
}

/** Card widths per layout: the span's share of the 12-column grid, or the full width. */
export function cardWidth(layout: Layout, span: number, theme: Theme = DEFAULT_THEME): number {
  if (!layout.grid) return layout.content;
  const gap = theme.density.gap;
  const column = (layout.content - 11 * gap) / 12;
  return Math.floor(span * column + (span - 1) * gap);
}

/**
 * Draws a chart for every layout. In the 12-column layouts it takes rowHeight, the tallest preset
 * of the charts in its grid row, so cards side by side end level; narrower layouts stack every card
 * and use the chart's own preset.
 */
function chartBody(
  block: LineData | BarData | PieData | ScatterData,
  ctx: RenderContext,
  label: string,
  rowHeight: HeightPreset,
): string {
  const { theme } = ctx;
  const variants = new Map<string, { svg: string; layouts: number[] }>();
  LAYOUTS.forEach((layout, index) => {
    const width = cardWidth(layout, chartSpan(block), theme) - 2 * theme.density.cardPadding - 2;
    const preset = layout.grid ? rowHeight : (block.height ?? "default");
    const sizes = theme.height[preset][layout.mobile ? "phone" : "desktop"];
    const base = sizes.chart;
    const height =
      block.type === "bar"
        ? barHeight(block, ctx, width, base)
        : isPie(block)
          ? pieHeight(block, ctx, width, base, sizes.pie)
          : base;
    const key = `${width}x${height}x${base}`;
    const found = variants.get(key);
    if (found) {
      found.layouts.push(index);
      return;
    }
    const size = { width, height };
    const svg =
      block.type === "bar"
        ? renderBar(block, ctx, size)
        : isPie(block)
          ? renderPie(block, ctx, size, undefined, sizes.pie)
          : block.type === "scatter"
            ? renderScatter(block, ctx, size)
            : renderLine(block, ctx, size);
    variants.set(key, {
      svg: svg.replace("<svg ", `<svg tabindex="0" aria-describedby="hm-${esc(block.id)}-d" `),
      layouts: [index],
    });
  });
  const description = describeChart(block, ctx);
  return [
    `<figure class="hm-chart" data-hm-chart="${esc(block.id)}">`,
    `<script type="application/json">${scriptJson(chartRuntimeData(block, ctx))}</script>`,
    ...[...variants.values()].map(
      (v) => `<div class="hm-v ${v.layouts.map((l) => `hm-l${l}`).join(" ")}">${v.svg}</div>`,
    ),
    `<figcaption class="hm-sr" id="hm-${esc(block.id)}-d">${esc(description)}</figcaption>`,
    chartTable(block, ctx, label),
    "</figure>",
  ].join("");
}

/** A segmented control: one radio button per grain, the selected one checked. */
function grainControl(options: GrainOption[], selected: string, label: string, extra = ""): string {
  const buttons = options
    .map(
      (o) =>
        `<button type="button" role="radio" aria-checked="${o.key === selected}" tabindex="${o.key === selected ? 0 : -1}" data-hm-grain="${esc(o.key)}">${esc(o.label)}</button>`,
    )
    .join("");
  return `<div class="hm-seg"${extra} role="radiogroup" aria-label="${esc(label)}">${buttons}</div>`;
}

/**
 * A chart card that switches grains: the control in its header, and every grain's heading and chart
 * drawn ahead, all but the selected one hidden. The runtime only toggles which one shows.
 */
function grainCard(
  block: (LineData | BarData) & { grains: GrainSwitch },
  ctx: RenderContext,
  rowHeight: HeightPreset,
): string {
  const id = `hm-${block.id}-t`;
  const { selected, options } = block.grains;
  const panels = options.map((o) => {
    const { totals: _, ...rest } = block;
    const variant = {
      ...rest,
      id: `${block.id}-${o.key.replace(":", "-")}`,
      axis: o.axis,
      series: o.series,
      ...(o.totals === undefined ? {} : { totals: o.totals }),
    } as LineData | BarData;
    const { title, subtitle } = blockHeading(variant, ctx);
    const hidden = o.key === selected ? "" : " hidden";
    return {
      title: `<span data-hm-grain="${esc(o.key)}"${hidden}>${esc(title)}</span>`,
      subtitle: subtitle
        ? `<span data-hm-grain="${esc(o.key)}"${hidden}>${esc(subtitle)}</span>`
        : "",
      body: `<div class="hm-grain-panel" data-hm-grain="${esc(o.key)}"${hidden}>${chartBody(variant, ctx, title, rowHeight)}</div>`,
    };
  });
  const subtitles = panels.map((p) => p.subtitle).join("");
  const head = `<header class="hm-card-head hm-switch"><div class="hm-card-titles"><h2 id="${esc(id)}">${panels.map((p) => p.title).join("")}</h2>${subtitles ? `<p>${subtitles}</p>` : ""}</div>${grainControl(
    options,
    selected,
    `Grain: ${
      block.title ??
      metricLabels(
        ctx,
        block.series.map((s) => s.metric),
      )
    }`,
  )}</header>`;
  return `<section class="hm-card hm-${block.type}" style="--span:${chartSpan(block)}" aria-labelledby="${esc(id)}" data-hm-grains>${head}${panels.map((p) => p.body).join("")}</section>`;
}

/** The scroll area's height for a table with a non-default preset: header, rows and total row. */
function tableStyle(block: TableData, ctx: RenderContext, alone: boolean): string {
  const preset = tableHeight(block, alone);
  if (preset === undefined) return "";
  const row = ctx.theme.density.tableRow;
  return heightStyle(
    ctx.theme,
    preset,
    (h, scope) =>
      `.hm-table-wrap${scope}.hm-tall{max-height:${row - 4 + Math.round(h.tableRows * row) + row}px}`,
    ".hm-table-wrap&.hm-tall{max-height:none}",
  );
}

function card(
  block: LineData | BarData | PieData | TableData | ScatterData,
  ctx: RenderContext,
  alone: boolean,
  rowHeight: HeightPreset,
): string {
  if ((block.type === "line" || block.type === "area" || block.type === "bar") && block.grains) {
    return grainCard(block as (LineData | BarData) & { grains: GrainSwitch }, ctx, rowHeight);
  }
  const { title, subtitle } = blockHeading(block, ctx);
  const id = `hm-${block.id}-t`;
  const body =
    block.type === "table"
      ? renderTable(block, ctx, alone, subtitle !== "") + tableStyle(block, ctx, alone)
      : chartBody(block, ctx, title, rowHeight);
  if (block.type === "table") {
    const download = `<button type="button" class="hm-csv" data-hm-csv="${esc(block.id)}" aria-label="Download ${esc(title)} as CSV" hidden>Download CSV</button>`;
    return `<section class="hm-card hm-table" style="--span:${block.span}" aria-labelledby="${esc(id)}"><header class="hm-card-head hm-switch"><div class="hm-card-titles"><h2 id="${esc(id)}">${esc(title)}</h2>${subtitle ? `<p id="hm-${esc(block.id)}-s">${esc(subtitle)}</p>` : ""}</div>${download}</header>${body}</section>`;
  }
  return `<section class="hm-card hm-${block.type}" style="--span:${chartSpan(block)}" aria-labelledby="${esc(id)}"><header class="hm-card-head"><h2 id="${esc(id)}">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</header>${body}</section>`;
}

function strip(kpis: KpiData[], ctx: RenderContext, height: HeightPreset): GridItem {
  const span = Math.min(
    12,
    kpis.reduce((sum, k) => sum + k.span, 0),
  );
  const parts = kpis.map((k) => renderKpi(k, ctx));
  const sized =
    height === "default"
      ? ">"
      : ` data-hm-height="${height}">${heightStyle(
          ctx.theme,
          height,
          (h, scope) =>
            `.hm-strip${scope} .hm-kpi-value{font-size:${h.kpiSize}px;line-height:${h.kpiLineHeight}px}.hm-strip${scope} .hm-spark{height:${h.sparkline}px}`,
        )}`;
  return {
    blocks: kpis.map((k) => k.id),
    html: `<section class="hm-strip" style="--span:${span}" aria-label="Key metrics"${sized}${parts.join("")}</section>`,
    kpis: parts,
  };
}

/** One child of the dashboard grid: a card, or a strip holding consecutive KPIs (kpis, in order). */
export interface GridItem {
  /** Ids of the blocks it shows. */
  blocks: string[];
  html: string;
  kpis?: string[];
}

/** The blocks of a dashboard as grid items: consecutive KPIs share one strip card. */
export function renderBlocks(blocks: readonly BlockData[], ctx: RenderContext): string {
  return gridItems(blocks, ctx)
    .map((item) => item.html)
    .join("");
}

/**
 * The grid items of renderBlocks one by one, so a dev server can compare two renders card by card
 * and replace only the cards that changed.
 */
export function gridItems(blocks: readonly BlockData[], ctx: RenderContext): GridItem[] {
  return layoutItems(blocks).map((item) => {
    const shown = item.blocks.map((i) => blocks[i] as BlockData);
    if (item.kind === "strip") return strip(shown as KpiData[], ctx, item.height);
    const block = shown[0] as Exclude<BlockData, KpiData>;
    return { blocks: [block.id], html: card(block, ctx, item.alone, item.height) };
  });
}

function themeVariables(theme: Theme, mode: Mode): string {
  return [
    ...COLOR_KEYS.map((k) => `${cssVar(k)}:${colorValue(theme, mode, k)}`),
    `--hm-partial-region:${theme.partial.regionOpacity[mode]}`,
  ].join(";");
}

function groupStyles(theme: Theme): string {
  const keys = groupColorKeys(theme);
  if (keys.length === 0) return "";
  const vars = (mode: Mode) =>
    keys.map((k) => `${cssVar(k)}:${colorValue(theme, mode, k)}`).join(";");
  return [
    `:root{${vars("light")}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars("dark")}}}`,
    `:root[data-theme=dark]{${vars("dark")}}`,
    keys
      .map(
        (k) =>
          `.hm-f-${k}{fill:var(${cssVar(k)})}.hm-s-${k}{stroke:var(${cssVar(k)})}.hm-b-${k}{background:var(${cssVar(k)})}.hm-tip i.hm-h-${k}{color:var(${cssVar(k)})}`,
      )
      .join(""),
    ".hm-tip-g{font-size:12px;line-height:16px;font-weight:500;color:var(--hm-text);margin-bottom:-2px}",
  ].join("\n");
}

/** Whether any chart of a dashboard draws a series group. */
export function usesGroups(data: DashboardData): boolean {
  return data.blocks.some((b) => "groups" in b && b.groups !== undefined);
}

/** The page stylesheet: fonts, theme variables for light and dark, layout and components. */
export function pageStyles(
  assets: PageAssets,
  theme: Theme = DEFAULT_THEME,
  groups = false,
): string {
  const d = theme.density;
  const fonts = FONT_FILES.filter((f) => assets.fonts[f.file] !== undefined)
    .map(
      (f) =>
        `@font-face{font-family:"${theme.font.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url("${assets.fonts[f.file]}") format("woff2");unicode-range:${f.unicodeRange}}`,
    )
    .join("");
  const paint = COLOR_KEYS.map(
    (k) => `.hm-f-${k}{fill:var(${cssVar(k)})}.hm-s-${k}{stroke:var(${cssVar(k)})}`,
  ).join("");
  const light = themeVariables(theme, "light");
  const dark = themeVariables(theme, "dark");
  const layouts = LAYOUTS.map((layout, i) => {
    const upper = LAYOUTS[i - 1];
    const query = [
      ...(layout.min > 0 ? [`(min-width:${layout.min}px)`] : []),
      ...(upper ? [`(max-width:${upper.min - 0.02}px)`] : []),
    ].join(" and ");
    const width =
      layout.min === 0
        ? `width:${layout.content}px;max-width:calc(100% - ${2 * layout.page}px)`
        : `width:${layout.content}px`;
    const column = layout.grid
      ? ""
      : `.hm-grid>*{grid-column:1/-1}.hm-strip{--cols:2}.hm-kpi{grid-column:span 1}`;
    const mobile = layout.mobile
      ? `${PERIOD_MOBILE}.hm-header{flex-direction:column;align-items:flex-start}.hm-header-side{align-items:flex-start;align-self:stretch}.hm-kpi-value{font-size:20px;line-height:28px;letter-spacing:-0.01em}.hm-kpi-figure{gap:6px}.hm-track{display:none}.hm-table td.hm-cellbar,.hm-table td.hm-share{padding-left:16px}.hm-table:is(.hm-ma,.hm-mb) tr>.hm-outer{width:0;min-width:0;max-width:0;padding:0;border-left:0;overflow:hidden}.hm-table:is(.hm-ma,.hm-mb) tr>.hm-outer>*{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.hm-table:is(.hm-ma,.hm-mb) thead tr>.hm-outer>*{display:none}.hm-table:is(.hm-ma,.hm-mb) tr>.hm-fill{position:sticky;left:0;z-index:1;padding-left:0;padding-right:12px;background:var(--hm-card);box-shadow:inset -1px 0 0 var(--hm-border)}.hm-table:is(.hm-ma,.hm-mb) thead tr>.hm-fill{z-index:3}.hm-tall .hm-table:is(.hm-ma,.hm-mb) thead tr>.hm-fill{box-shadow:inset -1px 0 0 var(--hm-border),inset 0 -1px 0 var(--hm-border-strong)}.hm-table:is(.hm-ma,.hm-mb) .hm-fill span{max-width:176px}.hm-table:is(.hm-ma,.hm-mb) tr>.hm-fill+*{padding-left:12px}.hm-table:is(.hm-ma,.hm-mb) .hm-key span.hm-m{display:-webkit-box}.hm-table .hm-key span.hm-msub{-webkit-line-clamp:1;font-size:12px;line-height:16px;font-weight:400;color:var(--hm-text-muted)}.hm-table.hm-deep tr[data-hm-level="2"] .hm-m{padding-left:12px}.hm-table.hm-deep tr:not(.hm-subtotal)>.hm-fill>span{padding-left:24px}.hm-table:is(.hm-ma,.hm-mb) tfoot tr>:first-child{box-shadow:inset -1px 0 0 var(--hm-border)}.hm-tall .hm-table:is(.hm-ma,.hm-mb) tfoot tr>:first-child{box-shadow:inset -1px 0 0 var(--hm-border),inset 0 1px 0 var(--hm-border-strong)}`
      : "";
    return `@container hm ${query}{.hm-page{${width};padding:${layout.page}px 0}.hm-l${i}{display:block}${column}${mobile}}`;
  }).join("");
  return [
    fonts,
    `:root{color-scheme:light;${light};--hm-shadow:0 4px 12px rgba(0,0,0,.08);--hm-font:"${theme.font.family}",${theme.font.fallback}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;${dark};--hm-shadow:none}}`,
    `:root[data-theme=dark]{color-scheme:dark;${dark};--hm-shadow:none}`,
    `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--hm-page);color:var(--hm-text);font:400 13px/18px var(--hm-font);font-variant-numeric:tabular-nums}`,
    `.hm-root{container:hm/inline-size}.hm-root :where(h1,h2,p,ul,li,section,header,footer,main,figure,figcaption){margin:0;padding:0;border:0;max-width:none}.hm-page{margin:0 auto;display:flex;flex-direction:column;gap:${d.gap}px}`,
    `.hm-header{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;padding:4px 0 8px}`,
    `.hm-titles{display:flex;flex-direction:column;gap:12px}.hm-brand{display:flex;align-items:center;gap:8px;font-weight:600}.hm-logo{width:16px;height:16px;border-radius:3px;background:var(--hm-accent);flex-shrink:0}`,
    `.hm-title{display:flex;flex-direction:column;gap:2px}.hm-root h1{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.01em}`,
    `.hm-caption,.hm-asof,.hm-footer{font-size:12px;line-height:16px;color:var(--hm-text-muted)}.hm-asof,.hm-footer{color:var(--hm-text-subtle)}.hm-description{max-width:720px;color:var(--hm-text-muted)}`,
    `.hm-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:${d.gap}px;align-items:stretch}`,
    `.hm-card,.hm-strip{grid-column:span var(--span);background:var(--hm-card);border:1px solid var(--hm-border);border-radius:${theme.radius.card}px;min-width:0}`,
    `.hm-card{display:flex;flex-direction:column;gap:14px;padding:${d.cardPadding}px}.hm-table{gap:10px}`,
    `.hm-card-head{display:flex;flex-direction:column;gap:2px}.hm-root h2{font-size:14px;line-height:20px;font-weight:500}.hm-card-head p{font-size:12px;line-height:16px;color:var(--hm-text-muted)}`,
    `.hm-strip{--cols:var(--span);display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));overflow:hidden}`,
    `.hm-kpi{grid-column:span var(--span);position:relative;display:flex;flex-direction:column;gap:4px;padding:${d.kpiPadding}px;box-shadow:-1px 0 0 var(--hm-border),0 -1px 0 var(--hm-border);min-width:0}`,
    `.hm-kpi-label{font-size:12px;line-height:16px;color:var(--hm-text-muted)}.hm-kpi-figure{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}`,
    `.hm-kpi-value{font-size:${d.kpiSize}px;line-height:${d.kpiLineHeight}px;letter-spacing:-0.02em;white-space:nowrap}.hm-kpi-value.hm-null{color:var(--hm-text-subtle)}`,
    `.hm-delta{font-weight:500;white-space:nowrap}.hm-good{color:var(--hm-good)}.hm-bad{color:var(--hm-bad)}.hm-neutral{color:var(--hm-text-muted)}`,
    `.hm-kpi-note{font-size:12px;line-height:16px;color:var(--hm-text-subtle)}.hm-spark{display:block;width:100%;height:24px;margin-top:8px}`,
    `.hm-switch{flex-direction:row;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px 12px}.hm-card-titles{display:flex;flex-direction:column;gap:2px;min-width:0}.hm-header-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:100%;min-width:0}`,
    `.hm-seg{display:inline-flex;flex:0 1 auto;flex-wrap:wrap;max-width:100%;min-width:0;gap:2px;padding:2px;background:var(--hm-card-alt);border:1px solid var(--hm-border);border-radius:${theme.radius.control}px}.hm-seg button{font:inherit;font-size:12px;line-height:16px;font-weight:500;padding:3px 10px;border:0;border-radius:${Math.max(0, theme.radius.control - 2)}px;background:transparent;color:var(--hm-text-muted);cursor:pointer}.hm-seg button:hover{color:var(--hm-text)}.hm-seg button[aria-checked=true]{background:var(--hm-card);color:var(--hm-text);box-shadow:0 0 0 1px var(--hm-border-strong)}.hm-seg button:focus-visible{outline:2px solid var(--hm-focus);outline-offset:1px}[data-hm-grain][hidden]{display:none}`,
    periodStyles(theme),
    `.hm-chart{position:relative}.hm-v{display:none}.hm-v svg{display:block;max-width:100%;height:auto;overflow:visible;touch-action:pan-y}.hm-v svg:focus,.hm-spark:focus{outline:none}.hm-v svg:focus-visible,.hm-spark:focus-visible,.hm-table-wrap:focus-visible{outline:2px solid var(--hm-focus);outline-offset:2px;border-radius:2px}`,
    `.hm-chart text{font-variant-numeric:tabular-nums}.hm-dim .hm-slice:not(.hm-on){opacity:.35}.hm-b-context{background:var(--hm-context)}`,
    `.hm-table-wrap{overflow-x:auto}.hm-table{width:100%;border-collapse:collapse}`,
    `.hm-table th,.hm-table td{height:${d.tableRow}px;padding:0 0 0 16px;text-align:right;font-weight:400;white-space:nowrap}.hm-table .hm-key{text-align:left;padding-left:0;white-space:normal;min-width:120px}.hm-table tbody .hm-key{padding-top:6px;padding-bottom:6px}.hm-table .hm-key2{padding-left:16px}.hm-table .hm-fill{width:100%}`,
    `.hm-table tr>:first-child{position:sticky;left:0;z-index:1;background:var(--hm-card)}.hm-table .hm-key span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}`,
    `.hm-table thead th{height:${d.tableRow - 4}px;font-size:12px;line-height:16px;font-weight:500;color:var(--hm-text-muted);border-bottom:1px solid var(--hm-border-strong);vertical-align:bottom;padding-bottom:4px}`,
    `.hm-table tfoot th,.hm-table tfoot td{font-weight:600;border-top:1px solid var(--hm-border-strong)}.hm-table .hm-null{color:var(--hm-text-subtle)}`,
    `.hm-table td.hm-share{min-width:64px}.hm-table td.hm-cellbar,.hm-table td.hm-share{padding-left:108px}.hm-table tbody td.hm-cellbar,.hm-table tbody td.hm-share{position:relative}.hm-track{display:inline-flex;width:80px;height:6px;background:var(--hm-card-alt);vertical-align:middle}.hm-table td .hm-track{position:absolute;left:16px;top:50%;margin-top:-3px}.hm-track span{display:block;height:6px;background:var(--hm-context)}`,
    `.hm-table-note{font-size:12px;line-height:16px;color:var(--hm-text-subtle)}`,
    `.hm-table thead th{position:sticky;top:0;z-index:2;background:var(--hm-card)}.hm-table thead tr>:first-child{z-index:3}.hm-tall{max-height:${d.tableRow - 4 + Math.round(15.5 * d.tableRow) + d.tableRow}px;overflow:auto;margin-right:-16px;padding-right:16px}.hm-tall thead th{border-bottom:0;box-shadow:inset 0 -1px 0 var(--hm-border-strong)}.hm-tall tfoot th,.hm-tall tfoot td{position:sticky;bottom:0;z-index:2;background:var(--hm-card);border-top:0;box-shadow:inset 0 1px 0 var(--hm-border-strong)}.hm-tall tfoot tr>:first-child{z-index:3}`,
    `.hm-sort{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px;text-align:inherit;white-space:nowrap}.hm-sort:hover,.hm-table th[aria-sort=ascending],.hm-table th[aria-sort=descending]{color:var(--hm-text)}.hm-sort:focus-visible{outline:2px solid var(--hm-focus);outline-offset:2px;border-radius:2px}.hm-caret{flex:none;visibility:hidden}.hm-sort:hover .hm-caret{visibility:visible;opacity:.5}[aria-sort=ascending] .hm-caret,[aria-sort=descending] .hm-caret{visibility:visible;opacity:1}[aria-sort=ascending] .hm-caret{transform:rotate(180deg)}`,
    `.hm-table-wrap{scrollbar-width:thin;scrollbar-color:var(--hm-border-strong) transparent}.hm-tall.hm-grow{max-height:none;margin-right:0;padding-right:0}.hm-table .hm-key span.hm-m{display:none}.hm-table tr[data-hm-solo]{display:none}.hm-table .hm-subtotal>*,.hm-table tr[data-hm-lead]>*{border-top:1px solid var(--hm-border)}.hm-table .hm-subtotal>*{font-weight:500}.hm-table .hm-other{color:var(--hm-text-muted)}.hm-track{position:relative}.hm-zero{position:absolute;top:-2px;bottom:-2px;width:1px;background:var(--hm-baseline)}`,
    `.hm-csv{flex:none;font:inherit;font-size:12px;line-height:16px;font-weight:500;padding:3px 10px;border:1px solid var(--hm-border);border-radius:${theme.radius.control}px;background:var(--hm-card-alt);color:var(--hm-text-muted);cursor:pointer}.hm-csv:hover{color:var(--hm-text)}.hm-csv:focus-visible{outline:2px solid var(--hm-focus);outline-offset:1px}.hm-csv[hidden]{display:none}`,
    `@media print{.hm-tall{max-height:none;overflow:visible}.hm-grow th,.hm-grow td{transform:none!important}.hm-csv{display:none}}`,
    `.hm-footer{display:flex;justify-content:space-between;gap:2px 12px;flex-wrap:wrap;padding-top:4px}`,
    `.hm-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}`,
    `.hm-winw{position:relative;display:inline-block;margin-left:1px}.hm-win{display:inline-block;font:inherit;line-height:inherit;padding:0 4px;margin:0;border:0;background:none;color:var(--hm-text-subtle);cursor:help}.hm-win>span{display:inline-block;width:6px;height:6px;border-radius:50%;border:1.5px solid currentColor;vertical-align:middle}.hm-win:hover,.hm-winw.hm-open .hm-win{color:var(--hm-text-muted)}.hm-win:focus-visible{outline:2px solid var(--hm-focus);outline-offset:0;border-radius:50%}.hm-win-tip{display:none;position:absolute;top:calc(100% + 4px);right:0;z-index:10;width:max-content;max-width:260px;white-space:normal;text-align:left;padding:6px 8px;font-size:12px;line-height:16px;font-weight:400;color:var(--hm-text);background:var(--hm-card);border:1px solid var(--hm-border-strong);border-radius:${theme.radius.tooltip}px;box-shadow:var(--hm-shadow)}.hm-win-tip::before{content:"";position:absolute;left:0;right:0;top:-6px;height:6px}.hm-win-print{display:none}.hm-winw:hover .hm-win-tip,.hm-win:focus-visible+.hm-win-tip,.hm-winw.hm-open .hm-win-tip{display:block}.hm-winw.hm-shut .hm-win-tip{display:none}@media print{.hm-winw{display:none}.hm-win-print{display:block;font-size:10px;line-height:14px;font-weight:400;white-space:normal;color:var(--hm-text-muted)}}`,
    `.hm-tip{position:absolute;z-index:10;pointer-events:none;min-width:168px;max-width:260px;display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:var(--hm-card);border:1px solid var(--hm-border-strong);border-radius:${theme.radius.tooltip}px;box-shadow:var(--hm-shadow)}`,
    `.hm-kpi .hm-tip{position:fixed}.hm-tip-h{font-size:12px;line-height:16px;font-weight:500}.hm-tip-s{font-size:12px;line-height:16px;margin-top:-4px;color:var(--hm-text-muted)}.hm-tip-r{display:flex;justify-content:space-between;align-items:center;gap:16px}.hm-tip-n{display:flex;align-items:center;gap:6px;color:var(--hm-text-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hm-tip-n i{width:10px;height:2px;border-radius:1px;flex-shrink:0}.hm-tip-sq .hm-tip-n i{width:8px;height:8px;border-radius:2px}.hm-tip i.hm-tip-hatch{width:10px;height:10px;border-radius:0;flex-shrink:0;box-sizing:border-box;color:var(--hm-text-subtle);border:1px solid currentColor;background:repeating-linear-gradient(135deg,color-mix(in srgb,currentColor 75%,transparent) 0 1px,transparent 1px 3px),color-mix(in srgb,currentColor 10%,transparent)}.hm-tip-s{display:flex;align-items:center;gap:6px}.hm-pr{opacity:var(--hm-partial-region)}.hm-tip-v{font-weight:500;white-space:nowrap}.hm-tip-p{display:inline-block;min-width:52px;text-align:right;font-weight:400;color:var(--hm-text-muted)}.hm-tip-t{padding-top:6px;border-top:1px solid var(--hm-border)}.hm-tip-t .hm-tip-v{font-weight:600}`,
    paint,
    COLOR_KEYS.filter((k) => /^[cf]\d$/.test(k))
      .map(
        (k) =>
          `.hm-b-${k}{background:var(${cssVar(k)})}.hm-tip i.hm-h-${k}{color:var(${cssVar(k)})}`,
      )
      .join(""),
    layouts,
    ...(groups ? [groupStyles(theme)] : []),
  ].join("\n");
}

const THEME_SCRIPT =
  'var t=new URLSearchParams(location.search).get("theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t';

/** Everything a page's head needs: fonts preload, styles, the theme switch and the runtime. */
export function pageHead(assets: PageAssets, theme: Theme = DEFAULT_THEME, groups = false): string {
  const preload = FONT_FILES.filter((f) => f.file.endsWith("-Latin1.woff2") && f.weight !== 600)
    .map((f) => assets.fonts[f.file])
    .filter((url) => url !== undefined)
    .map((url) => `<link rel="preload" href="${esc(url)}" as="font" type="font/woff2" crossorigin>`)
    .join("");
  return `${preload}<style>${pageStyles(assets, theme, groups)}</style><script>${THEME_SCRIPT}</script><script defer src="${esc(assets.runtime)}"></script>`;
}

function document(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Hatchmark">
<title>${esc(title)}</title>
${head}
</head>
<body>
<div class="hm-root">${body}</div>
</body>
</html>
`;
}

/** A dashboard's blocks as the page's grid items, for the runtime that redraws them for a period. */
export function renderDashboardBlocks(data: DashboardData, theme: Theme = DEFAULT_THEME): string {
  return renderBlocks(data.blocks, context(data, theme));
}

/**
 * A dashboard's blocks without the page header and footer, for galleries and embeds; pair it with
 * pageHead() once per document.
 */
export function renderFragment(data: DashboardData, theme: Theme = DEFAULT_THEME): string {
  return `<div class="hm-root"><div class="hm-page"><div class="hm-grid">${renderBlocks(data.blocks, context(data, theme))}</div></div></div>`;
}

/**
 * One dashboard as a complete HTML page: header with the data date (never the build time, so
 * output is byte-identical for identical input), the KPI strip, a 12-column grid of cards and a
 * footer naming the sources. Light and dark follow prefers-color-scheme; data-theme on the html
 * element (or ?theme=dark) overrides it.
 */
export function renderDashboardPage(data: DashboardData, options: PageOptions): string {
  const { periods } = options;
  const { result: html, ranges } = recordRanges(() => {
    const page = dashboardPage(data, options);
    for (const preset of Object.values(periods?.presets ?? {})) {
      renderDashboardBlocks(preset, options.theme);
      periodCaption(preset);
      if (preset.periodFilter) periodText(preset.periodFilter, preset.locale);
    }
    return page;
  });
  if (!periods) return html;
  return html.replace(
    RANGES_SLOT,
    () => `<script type="application/json" data-hm-ranges>${scriptJson(ranges)}</script>`,
  );
}

const RANGES_SLOT = "<!--hm-ranges-->";

function dashboardPage(data: DashboardData, options: PageOptions): string {
  const theme = options.theme ?? DEFAULT_THEME;
  const ctx = context(data, theme);
  const locale = data.locale;
  const asOf = `<p class="hm-asof">Data through ${esc(formatDate(data.asOf, locale))}</p>`;
  const controls = [
    data.periodFilter
      ? periodControl(
          { ...data, periodFilter: data.periodFilter },
          options.periods ? options.assets.periods : undefined,
          WEEK_ORDER.indexOf(data.anchors.week),
        )
      : "",
    data.grainFilter
      ? grainControl(
          data.grainFilter.options,
          data.grainFilter.selected,
          `${data.grainFilter.label}, all charts`,
          ` data-hm-grain-filter="${esc(data.grainFilter.id)}"`,
        )
      : "",
  ].join("");
  const note = data.periodFilter
    ? `<p class="hm-period-note" data-hm-period-note aria-live="polite" hidden></p>`
    : "";
  const header = `<header class="hm-header"><div class="hm-titles"><div class="hm-brand"><span class="hm-logo" aria-hidden="true"></span>${esc(data.project)}</div><div class="hm-title"><h1>${esc(data.title)}</h1><p class="hm-caption" data-hm-caption>${esc(periodCaption(data))}</p>${note}${data.description ? `<p class="hm-description">${esc(data.description)}</p>` : ""}</div></div>${controls ? `<div class="hm-header-side">${controls}${asOf}</div>` : asOf}</header>`;
  const embedded = options.periods
    ? `<script type="application/json" data-hm-periods>${scriptJson(options.periods)}</script>${RANGES_SLOT}`
    : "";
  const sources = options.sources?.length
    ? `Source: ${options.sources.join(", ")}`
    : `Source: ${data.project}`;
  const footer = `<footer class="hm-footer"><span>${esc(sources)}</span><span>Hatchmark \u00B7 ${esc(theme.id === "default" ? "Default theme" : theme.id)}</span></footer>`;
  const body = `<div class="hm-page">${header}<main class="hm-grid">${renderBlocks(data.blocks, ctx)}</main>${footer}</div>${embedded}`;
  return document(
    `${data.title} \u00B7 ${data.project}`,
    pageHead(options.assets, theme, usesGroups(data)),
    body,
  );
}

/** The index page listing every dashboard of a build, linked by relative URL. */
export function renderIndexPage(
  project: string,
  dashboards: { name: string; title: string; description?: string }[],
  options: PageOptions,
): string {
  const theme = options.theme ?? DEFAULT_THEME;
  const items = dashboards
    .map(
      (d) =>
        `<li class="hm-card"><h2><a href="./${esc(encodeURIComponent(d.name))}/">${esc(d.title)}</a></h2>${d.description ? `<p class="hm-caption">${esc(d.description)}</p>` : ""}</li>`,
    )
    .join("");
  const body = `<div class="hm-page"><header class="hm-header"><div class="hm-titles"><div class="hm-brand"><span class="hm-logo" aria-hidden="true"></span>${esc(project)}</div><h1>Dashboards</h1></div></header><ul class="hm-grid hm-index">${items}</ul></div>`;
  const head = `${pageHead(options.assets, theme)}<style>.hm-index{list-style:none;margin:0;padding:0}.hm-index .hm-card{grid-column:span 4}.hm-index a{color:inherit}</style>`;
  return document(`Dashboards \u00B7 ${project}`, head, body);
}

/**
 * One chart as a standalone SVG with hex colours baked in and the font named on the root, for
 * rasterisers (resvg) and for embedding outside a Hatchmark page.
 */
export function renderChartSvg(
  block: LineData | BarData | PieData | ScatterData,
  data: DashboardData,
  options: { width: number; height?: number; device?: Device; mode?: Mode; theme?: Theme },
): string {
  const theme = options.theme ?? DEFAULT_THEME;
  const mode = options.mode ?? "light";
  const ctx: RenderContext = { data, theme, paint: hexPaint(theme, mode) };
  const standalone = {
    font: `${theme.font.family}, ${theme.font.fallback}`,
    background: colorValue(theme, mode, "card"),
  };
  const sizes = theme.height[block.height ?? "default"][options.device ?? "desktop"];
  const base = options.height ?? sizes.chart;
  const size = { width: options.width, height: base };
  if (isPie(block)) {
    return renderPie(
      block,
      ctx,
      { ...size, height: pieHeight(block, ctx, size.width, base, sizes.pie) },
      standalone,
      sizes.pie,
    );
  }
  if (block.type === "bar") {
    return renderBar(
      block,
      ctx,
      { ...size, height: barHeight(block, ctx, size.width, base) },
      standalone,
    );
  }
  if (block.type === "scatter") return renderScatter(block, ctx, size, standalone);
  return renderLine(block, ctx, size, standalone);
}
