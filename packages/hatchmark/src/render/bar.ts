import { scaleBand } from "d3-scale";
import type { BarData, Value } from "../compiler/dashboard-data.js";
import { timeLabels } from "./axis.js";
import {
  BODY,
  CAPTION,
  type ChartSize,
  drawYAxis,
  emptyNote,
  fraction,
  isNumber,
  LABEL_LINE,
  metricOf,
  type RenderContext,
  shareAxis,
  svgRoot,
  yAxis,
} from "./chart.js";
import { formatBucket, formatKey, formatValue } from "./format.js";
import { thinTicks } from "./labels.js";
import { textWidth, truncateEnd, wrapLines } from "./measure.js";
import { r, svgLine, svgText } from "./svg.js";
import { type Paint, seriesColor } from "./theme.js";

const BAR_THICKNESS = 10;
const GROUPED_THICKNESS = 8;
const VALUE_GAP = 6;
const KEY_GAP = 16;

/** The text naming each position on the bar axis. */
export function barCategories(block: BarData, locale: string): string[] {
  return block.axis.kind === "category"
    ? block.axis.categories.map((c) => formatKey(c, locale))
    : block.axis.buckets.map((b) =>
        formatBucket(b, (block.axis as { grain: "day" }).grain, locale),
      );
}

/**
 * Bar extents per series and position: stacked bars start where the previous series ended. A 100%
 * stack draws each series' share of its position's total instead of its value.
 */
function extents(block: BarData, stacked: boolean): [number, number][][] {
  const n =
    block.axis.kind === "category" ? block.axis.categories.length : block.axis.buckets.length;
  const positive = new Array<number>(n).fill(0);
  const negative = new Array<number>(n).fill(0);
  return block.series.map((s) =>
    drawnValues(block, s).map((v, i): [number, number] => {
      if (!isNumber(v)) return [0, 0];
      if (!stacked) return [0, v];
      const base = v >= 0 ? (positive[i] as number) : (negative[i] as number);
      if (v >= 0) positive[i] = base + v;
      else negative[i] = base + v;
      return [base, base + v];
    }),
  );
}

/** What a bar series draws: its shares in a 100% stack, else its values. */
function drawnValues(block: BarData, s: BarData["series"][number]): Value[] {
  return block.percent && s.share ? s.share : s.values;
}

/**
 * The value printed at each bar's end: the position's total for stacked bars (the engine's, which
 * a distinct count or ratio needs; summed only for data without totals), or the single series'
 * values; undefined when grouped.
 */
function labelValues(block: BarData, stacked: boolean): Value[] | undefined {
  if (block.totals && (stacked || block.percent)) return block.totals;
  if (block.series.length === 1) return block.series[0]?.values;
  if (!stacked) return undefined;
  const n = block.series[0]?.values.length ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const vals = block.series.map((s) => s.values[i]).filter(isNumber);
    return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
  });
}

/** A one-row (or wrapping) key of coloured squares and series names, for multi-series bars. */
function drawKey(
  paint: Paint,
  labels: readonly string[],
  width: number,
): { svg: string; height: number } {
  if (labels.length < 2) return { svg: "", height: 0 };
  const parts: string[] = [];
  let x = 0;
  let row = 0;
  labels.forEach((label, k) => {
    const text = truncateEnd(label, width - 14, { size: CAPTION });
    const w = 14 + textWidth(text, { size: CAPTION });
    if (x > 0 && x + w > width) {
      x = 0;
      row++;
    }
    const cy = row * LABEL_LINE + LABEL_LINE / 2;
    parts.push(
      `<rect x="${r(x)}" y="${r(cy - 4)}" width="8" height="8" rx="1"${paint.attrs(seriesColor(k))}/>`,
      svgText(paint, x + 14, cy, text, {
        size: CAPTION,
        color: "textMuted",
        ...(text === label ? {} : { title: label }),
      }),
    );
    x += w + KEY_GAP;
  });
  return { svg: `<g class="hm-key">${parts.join("")}</g>`, height: (row + 1) * LABEL_LINE + 8 };
}

const NAME_STYLE = { size: BODY };
const NAME_LINES = 2;
const NAME_LINE = 17;

/** Category names of a horizontal bar chart: a column as wide as they need up to 40% of the chart, wrapped to two lines. */
function rowNames(names: string[], width: number) {
  const column = Math.min(width * 0.4, Math.max(0, ...names.map((t) => textWidth(t, NAME_STYLE))));
  return { column, wrapped: names.map((t) => wrapLines(t, column, NAME_STYLE, NAME_LINES)) };
}

/** Row height of a horizontal bar chart: rows stretch to fill the chart height, within limits. */
export function barRowHeight(block: BarData, ctx: RenderContext, chartHeight: number): number {
  const n = Math.max(1, barCategories(block, ctx.data.locale).length);
  const { barRow } = ctx.theme.density;
  if (block.series.length > 1 && !block.stack) {
    const thick = block.series.length * GROUPED_THICKNESS + (block.series.length - 1) * 2;
    return Math.max(barRow, thick + 12);
  }
  return Math.max(barRow, Math.min(barRow + 8, Math.floor(chartHeight / n)));
}

/** The height a bar chart takes at a width: fixed for vertical bars, by rows for horizontal. */
export function barHeight(
  block: BarData,
  ctx: RenderContext,
  width: number,
  chartHeight: number,
): number {
  if (block.orientation === "vertical") return chartHeight;
  const names = barCategories(block, ctx.data.locale);
  const key = drawKey(
    cssLessPaint,
    block.series.map((s) => s.label),
    width,
  ).height;
  const wraps = rowNames(names, width).wrapped.some((w) => w.lines.length > 1);
  const row = barRowHeight(block, ctx, chartHeight);
  return (
    key + Math.max(1, names.length) * (wraps ? Math.max(row, NAME_LINES * NAME_LINE + 6) : row)
  );
}

const cssLessPaint: Paint = { attrs: () => "" };

/**
 * A bar chart: vertical or horizontal, on a category or time axis, one series or several
 * (grouped side by side, or stacked). Values are printed on the bars when they fit, so most bar
 * charts need no axis on the value side.
 */
export function renderBar(
  block: BarData,
  ctx: RenderContext,
  size: ChartSize,
  standalone?: { font: string; background: string },
): string {
  const { paint, data } = ctx;
  const locale = data.locale;
  const names = barCategories(block, locale);
  const n = names.length;
  const series = block.series;
  const multi = series.length > 1;
  const stacked = (multi && block.stack) || block.percent === true;
  const metric = metricOf(ctx, series[0]?.metric ?? "");
  const valueAxis = (height: number) =>
    block.percent ? shareAxis(ends, height, locale) : yAxis(ends, height, metric, locale);
  const ext = extents(block, stacked);
  const ends = ext.flat().flat();
  const empty = !series.some((s) => s.values.some(isNumber));
  const totals = labelValues(block, stacked);
  const totalText = totals?.map((v) =>
    isNumber(v) ? formatValue(v, metric, locale, "compact") : "",
  );
  const key = drawKey(
    paint,
    series.map((s) => s.label),
    size.width,
  );
  const parts: string[] = [key.svg];
  const label = block.title ?? series.map((s) => s.label).join(", ");

  if (block.orientation === "horizontal") {
    const top = key.height;
    const rowH = (size.height - top) / Math.max(1, n);
    const { column: labelWidth, wrapped } = rowNames(names, size.width);
    const grouped = multi && !stacked;
    const valueStyle = { size: grouped ? CAPTION : BODY, weight: 500 } as const;
    const valueTexts = grouped
      ? series.map((s) =>
          s.values.map((v) => (isNumber(v) ? formatValue(v, metric, locale, "compact") : "")),
        )
      : [totalText ?? []];
    const valueWidth = Math.max(0, ...valueTexts.flat().map((t) => textWidth(t, valueStyle)));
    const hasNegative = ends.some((v) => v < 0);
    const barLeft = labelWidth + 12 + (hasNegative ? valueWidth + VALUE_GAP : 0);
    const barRight = size.width - valueWidth - VALUE_GAP;
    const lo = Math.min(0, ...ends);
    const hi = Math.max(0, ...ends);
    const scale = (v: number) =>
      hi === lo ? barLeft : barLeft + fraction(v, lo, hi) * (barRight - barLeft);
    const zero = scale(0);
    names.forEach((name, i) => {
      const cy = top + i * rowH + rowH / 2;
      const { lines, cut } = wrapped[i] as { lines: string[]; cut: boolean };
      lines.forEach((line, j) => {
        parts.push(
          svgText(paint, 0, cy + (j - (lines.length - 1) / 2) * NAME_LINE, line, {
            ...NAME_STYLE,
            color: "textMuted",
            ...(cut ? { title: name } : {}),
          }),
        );
      });
      series.forEach((_, k) => {
        const [a, b] = (ext[k] as [number, number][])[i] as [number, number];
        if (a === b) return;
        const thick = grouped ? GROUPED_THICKNESS : BAR_THICKNESS;
        const offset = grouped ? (k - (series.length - 1) / 2) * (GROUPED_THICKNESS + 2) : 0;
        const x0 = Math.min(scale(a), scale(b));
        const w = Math.max(1, Math.abs(scale(b) - scale(a)));
        parts.push(
          `<rect x="${r(x0)}" y="${r(cy + offset - thick / 2)}" width="${r(w)}" height="${thick}" rx="${ctx.theme.radius.bar}"${paint.attrs(seriesColor(k))}/>`,
        );
        if (grouped) {
          const text = (valueTexts[k] as string[])[i] as string;
          const neg = b < 0;
          parts.push(
            svgText(paint, scale(b) + (neg ? -VALUE_GAP : VALUE_GAP), cy + offset, text, {
              ...valueStyle,
              anchor: neg ? "end" : "start",
              color: "textMuted",
            }),
          );
        }
      });
      if (!grouped) {
        const total = totals?.[i];
        if (isNumber(total)) {
          const end = stacked
            ? Math.max(...ext.map((e) => (e[i] as [number, number])[1]), 0)
            : total;
          const neg = !stacked && total < 0;
          parts.push(
            svgText(
              paint,
              scale(neg ? total : end) + (neg ? -VALUE_GAP : VALUE_GAP),
              cy,
              (totalText as string[])[i] as string,
              { ...valueStyle, anchor: neg ? "end" : "start", color: "text" },
            ),
          );
        }
      }
    });
    if (hasNegative) {
      parts.push(svgLine(paint, zero, top, zero, top + n * rowH, "baseline"));
    }
    if (empty) parts.push(emptyNote(paint, series, ctx, size.width / 2, top + (n * rowH) / 2));
    return svgRoot(
      size,
      label,
      {
        kind: "bar",
        o: "h",
        band: `${r(top)},${r(top + n * rowH)},${n}`,
        plot: `0,${r(top)},${r(size.width)},${r(top + n * rowH)}`,
      },
      parts.join(""),
      standalone,
    );
  }

  const bottomBand = 24;
  const valueStyle = { size: CAPTION } as const;
  const provisionalTop = key.height + 8;
  const axis0 = valueAxis(size.height - provisionalTop - bottomBand);
  const plotLeft = empty ? 0 : axis0.labelWidth + 8;
  const plotRight = size.width;
  const band = scaleBand<number>()
    .domain(names.map((_, i) => i))
    .range([plotLeft, plotRight])
    .paddingInner(0.25)
    .paddingOuter(0.125);
  const bw = band.bandwidth();
  const step = band.step();
  const showValues =
    !empty &&
    totalText !== undefined &&
    n <= 24 &&
    totalText.every((t) => textWidth(t, valueStyle) <= step - 2);
  const top = provisionalTop + (showValues ? LABEL_LINE : 0);
  const plotBottom = size.height - bottomBand;
  const axis = valueAxis(plotBottom - top);
  const [d0, d1] = axis.domain;
  const y = (v: number) => plotBottom - fraction(v, d0, d1) * (plotBottom - top);
  parts.push(
    empty
      ? svgLine(paint, plotLeft, plotBottom, plotRight, plotBottom, "baseline")
      : drawYAxis(paint, axis, y, plotLeft, plotRight),
  );
  const inner = scaleBand<number>()
    .domain(series.map((_, k) => k))
    .range([0, bw])
    .paddingInner(multi && !stacked ? 0.1 : 0);
  names.forEach((_, i) => {
    const x0 = band(i) as number;
    series.forEach((_, k) => {
      const [a, b] = (ext[k] as [number, number][])[i] as [number, number];
      if (a === b) return;
      const x = stacked || !multi ? x0 : x0 + (inner(k) as number);
      const w = stacked || !multi ? bw : inner.bandwidth();
      const top1 = Math.min(y(a), y(b));
      parts.push(
        `<rect x="${r(x)}" y="${r(top1)}" width="${r(w)}" height="${r(Math.max(1, Math.abs(y(b) - y(a))))}" rx="${ctx.theme.radius.bar}"${paint.attrs(seriesColor(k))}/>`,
      );
    });
    if (showValues) {
      const total = totals?.[i];
      if (isNumber(total)) {
        const end = stacked
          ? total >= 0
            ? Math.max(...ext.map((e) => (e[i] as [number, number])[1]), 0)
            : Math.min(...ext.map((e) => (e[i] as [number, number])[1]), 0)
          : total;
        const ly = total >= 0 ? y(end) - 4 - LABEL_LINE / 2 : y(end) + 4 + LABEL_LINE / 2;
        parts.push(
          svgText(paint, x0 + bw / 2, ly, (totalText as string[])[i] as string, {
            ...valueStyle,
            anchor: "middle",
            color: "textMuted",
          }),
        );
      }
    }
  });

  const centre = (i: number) => (band(i) as number) + bw / 2;
  if (block.axis.kind === "time") {
    parts.push(
      ...timeLabels(block.axis, centre, locale, 0, size.width).map((l) =>
        svgText(paint, l.x, plotBottom + 16, l.text, {
          size: CAPTION,
          anchor: "middle",
          color: "textSubtle",
        }),
      ),
    );
  } else {
    const tick = { size: CAPTION };
    const fitted = names.map((t) => truncateEnd(t, step - 4, tick));
    const readable = fitted.every((t, i) => t === names[i] || Array.from(t).length >= 4);
    const placed = readable
      ? fitted.map((t, i) => ({ index: i, centre: centre(i), text: t }))
      : thinTicks(
          names.map((t, i) => ({
            pos: centre(i),
            width: textWidth(truncateEnd(t, 120, tick), tick),
            phase: i,
          })),
          [1, 2, 3, 4, 5, 10, 20],
          8,
          0,
          size.width,
        ).map((p) => ({ ...p, text: truncateEnd(names[p.index] as string, 120, tick) }));
    parts.push(
      ...placed.map((p) =>
        svgText(paint, p.centre, plotBottom + 16, p.text, {
          ...tick,
          anchor: "middle",
          color: "textSubtle",
          ...(p.text === names[p.index] ? {} : { title: names[p.index] as string }),
        }),
      ),
    );
  }
  if (empty)
    parts.push(emptyNote(paint, series, ctx, (plotLeft + plotRight) / 2, (top + plotBottom) / 2));
  return svgRoot(
    size,
    label,
    {
      kind: "bar",
      o: "v",
      band: `${r((band(0) ?? plotLeft) - (step - bw) / 2)},${r((band(0) ?? plotLeft) - (step - bw) / 2 + n * step)},${n}`,
      plot: `${r(plotLeft)},${r(top)},${r(plotRight)},${r(plotBottom)}`,
    },
    parts.join(""),
    standalone,
  );
}
