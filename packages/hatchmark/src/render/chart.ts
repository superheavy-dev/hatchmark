import type { DashboardData, MetricInfo, Series, Value } from "../compiler/dashboard-data.js";
import { yTicks } from "./axis.js";
import { formatTicks } from "./format.js";
import { textWidth } from "./measure.js";
import { esc, r, svgLine, svgText } from "./svg.js";
import type { Paint, Theme } from "./theme.js";

/** What every component renderer needs besides its block. */
export interface RenderContext {
  data: DashboardData;
  theme: Theme;
  paint: Paint;
}

/** A chart's pixel size. Text is measured for this width, never scaled to another. */
export interface ChartSize {
  width: number;
  height: number;
}

export const CAPTION = 12;
export const BODY = 13;
export const TICK_PADDING = 8;
export const LABEL_LINE = 16;

/** The metric a series shows, with a neutral fallback so a renderer never throws on bad input. */
export function metricOf(ctx: RenderContext, name: string): MetricInfo {
  return (
    ctx.data.metrics[name] ?? {
      name,
      label: name,
      format: { type: "number" },
      better: "neutral",
    }
  );
}

/** The format of a share of a total: the value axis of a 100% stack, tooltip and key shares. */
export const SHARE: MetricInfo = {
  name: "share",
  label: "Share",
  format: { type: "percent" },
  better: "neutral",
};

/** "Revenue" becomes "revenue" for use mid-sentence; acronyms such as "ARR" stay. */
export function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]?.toLowerCase() + text.slice(1) : text;
}

export const isNumber = (v: Value | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Where v sits between lo and hi, from 0 to 1. Halving first keeps hi - lo finite for any two
 * finite numbers, and halving is exact, so ordinary values give the same result as (v - lo) / (hi - lo).
 */
export function fraction(v: number, lo: number, hi: number): number {
  return (v / 2 - lo / 2) / (hi / 2 - lo / 2);
}

/** The last index where a series has a value, or -1. */
export function lastDefined(values: readonly Value[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (isNumber(values[i])) return i;
  return -1;
}

export interface YAxis {
  domain: [number, number];
  ticks: number[];
  labels: string[];
  labelWidth: number;
}

export function yAxis(
  values: readonly number[],
  plotHeight: number,
  metric: MetricInfo,
  locale: string,
): YAxis {
  const { domain, ticks } = yTicks(values, plotHeight);
  const labels = formatTicks(ticks, metric, locale);
  const labelWidth = Math.max(0, ...labels.map((l) => textWidth(l, { size: CAPTION })));
  return { domain, ticks, labels, labelWidth };
}

/**
 * The value axis of a 100% stack: 0% to 100% in quarters (halves on plots shorter than quartersFrom), so every chart
 * of shares reads the same. Shares outside 0 to 1 (a negative part, HM4061) get a computed axis.
 */
export function shareAxis(
  values: readonly number[],
  length: number,
  locale: string,
  quartersFrom = 160,
): YAxis {
  const eps = 1e-9;
  if (!values.every((v) => v >= -eps && v <= 1 + eps)) {
    return yAxis(values, length, SHARE, locale);
  }
  const ticks = length >= quartersFrom ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  const labels = formatTicks(ticks, SHARE, locale);
  const labelWidth = Math.max(0, ...labels.map((l) => textWidth(l, { size: CAPTION })));
  return { domain: [0, 1], ticks, labels, labelWidth };
}

/** Horizontal gridlines with the zero line as the baseline, and right-aligned tick labels. */
export function drawYAxis(
  paint: Paint,
  axis: YAxis,
  y: (v: number) => number,
  plotLeft: number,
  plotRight: number,
): string {
  return axis.ticks
    .map(
      (t, k) =>
        svgLine(paint, plotLeft, y(t), plotRight, y(t), t === 0 ? "baseline" : "grid") +
        svgText(paint, plotLeft - TICK_PADDING, y(t), axis.labels[k] as string, {
          size: CAPTION,
          anchor: "end",
          color: "textSubtle",
        }),
    )
    .join("");
}

/** The root element of a chart SVG, with the geometry the runtime reads for hover. */
export function svgRoot(
  size: ChartSize,
  label: string,
  attrs: Record<string, string | number>,
  body: string,
  standalone: { font: string; background: string } | undefined,
): string {
  const data = Object.entries(attrs)
    .map(([k, v]) => ` data-hm-${k}="${esc(String(v))}"`)
    .join("");
  const head = standalone
    ? ` xmlns="http://www.w3.org/2000/svg" font-family="${esc(standalone.font)}"`
    : "";
  const background = standalone
    ? `<rect width="${size.width}" height="${size.height}" fill="${standalone.background}"/>`
    : "";
  return `<svg${head} width="${r(size.width)}" height="${r(size.height)}" viewBox="0 0 ${r(size.width)} ${r(size.height)}" role="img" aria-label="${esc(label)}"${data}>${background}${body}</svg>`;
}

/** A short note in the middle of an empty plot: "No revenue in this period". */
export function emptyNote(
  paint: Paint,
  series: readonly Series[],
  ctx: RenderContext,
  x: number,
  y: number,
): string {
  const metric = series[0] ? metricOf(ctx, series[0].metric).label : "data";
  return svgText(paint, x, y, `No ${lowerFirst(metric)} in this period`, {
    size: BODY,
    anchor: "middle",
    color: "textMuted",
  });
}
