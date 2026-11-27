import { area as d3area, line as d3line } from "d3-shape";
import type { LineData, Value } from "../compiler/dashboard-data.js";
import { timeLabels } from "./axis.js";
import {
  CAPTION,
  type ChartSize,
  drawYAxis,
  emptyNote,
  fraction,
  isNumber,
  LABEL_LINE,
  lastDefined,
  metricOf,
  type RenderContext,
  svgRoot,
  yAxis,
} from "./chart.js";
import { formatBucket, formatValue } from "./format.js";
import { stackLabels } from "./labels.js";
import { textWidth, truncateEnd } from "./measure.js";
import { r, svgLine, svgText } from "./svg.js";
import { seriesColor } from "./theme.js";

/** Direct labels need this much plot width; below it a pinned readout replaces them. */
export const DIRECT_LABEL_MIN_PLOT = 320;
const MAX_DIRECT_SERIES = 6;
const LINE_WIDTH = 1.75;
const LEGEND_NAME_X = 13;
const LEGEND_GAP = 16;
const LEGEND_ROW = LABEL_LINE + 4;

/**
 * Each series' band as drawn: upper is the value itself, or for stacked areas the running total
 * at that bucket, and lower is where the band starts. Stacks diverge from zero: positive values
 * stack upward and negative values downward. A missing value is a gap in its own band, never 0.
 */
export function stackBands(block: LineData): { lower: Value[][]; upper: Value[][] } {
  const upper = block.series.map((s) => s.values);
  if (!(block.type === "area" && block.stack)) return { lower: upper.map(() => []), upper };
  const up = block.axis.buckets.map(() => 0);
  const down = block.axis.buckets.map(() => 0);
  const lower: Value[][] = [];
  const stacked: Value[][] = [];
  for (const s of block.series) {
    lower.push(s.values.map((v, i) => (isNumber(v) ? ((v < 0 ? down : up)[i] as number) : null)));
    stacked.push(
      s.values.map((v, i) => {
        if (!isNumber(v)) return null;
        const totals = v < 0 ? down : up;
        totals[i] = (totals[i] as number) + v;
        return totals[i] as number;
      }),
    );
  }
  return { lower, upper: stacked };
}

/** Values as drawn: running totals for stacked areas, with gaps where a value is missing. */
export function plottedValues(block: LineData): Value[][] {
  return stackBands(block).upper;
}

/**
 * A line or area chart over a time axis. Direct labels sit at the line ends when the plot is at
 * least 320 px wide and there are at most 6 series; otherwise a key above the plot flows across the
 * card, the period first and then each series' name and value (the runtime updates both on hover).
 * The plot is always as tall as size.height allows; a longer key makes the chart taller.
 */
export function renderLine(
  block: LineData,
  ctx: RenderContext,
  size: ChartSize,
  standalone?: { font: string; background: string },
): string {
  const { paint, data } = ctx;
  const locale = data.locale;
  const n = block.axis.buckets.length;
  const series = block.series;
  const metric = metricOf(ctx, series[0]?.metric ?? "");
  const bands = stackBands(block);
  const plotted = bands.upper;
  const values = plotted.flat().filter(isNumber);
  const empty = values.length === 0;

  const nameStyle = { size: CAPTION, weight: 500 } as const;
  const lastIndex = series.map((s) => lastDefined(s.values));
  const lastText = series.map((s, k) =>
    formatValue(s.values[lastIndex[k] ?? -1] ?? null, metricOf(ctx, s.metric), locale, "compact"),
  );
  const directWidth =
    Math.max(
      0,
      ...series.map(
        (s, k) =>
          12 +
          textWidth(s.label, nameStyle) +
          6 +
          textWidth(lastText[k] as string, { size: CAPTION }),
      ),
    ) + 8;

  const bottomBand = 24;
  const top0 = 8;
  const provisional = yAxis(values, size.height - top0 - bottomBand, metric, locale);
  const left = empty ? 0 : provisional.labelWidth + 8;
  const direct =
    !empty &&
    series.length <= MAX_DIRECT_SERIES &&
    size.width - left - directWidth >= DIRECT_LABEL_MIN_PLOT;

  let readout = "";
  let legendHeight = 0;
  if (!direct && !empty && series.length > 0) {
    const last = Math.max(...lastIndex);
    const style = { size: CAPTION } as const;
    const headers = block.axis.buckets.map((b) => formatBucket(b, block.axis.grain, locale));
    const valueWidth = series.map((s) =>
      Math.max(
        0,
        ...s.values.map((v) =>
          textWidth(formatValue(v, metricOf(ctx, s.metric), locale, "compact"), style),
        ),
      ),
    );
    const items = [
      { width: Math.max(0, ...headers.map((h) => textWidth(h, style))), k: -1 },
      ...series.map((s, k) => ({
        width: LEGEND_NAME_X + textWidth(s.label, style) + 6 + (valueWidth[k] as number),
        k,
      })),
    ];
    const parts: string[] = [];
    let x = 0;
    let row = 0;
    for (const item of items) {
      if (x > 0 && x + item.width > size.width) {
        x = 0;
        row++;
      }
      const cy = row * LEGEND_ROW + LABEL_LINE / 2;
      const s = series[item.k];
      if (s === undefined) {
        parts.push(
          svgText(paint, x, cy, last >= 0 ? (headers[last] as string) : "", {
            ...style,
            color: "textSubtle",
            className: "hm-rh",
          }),
        );
      } else {
        const room = size.width - x - LEGEND_NAME_X - 6 - (valueWidth[item.k] as number);
        const name = truncateEnd(s.label, room, style);
        parts.push(
          `<circle cx="${r(x + 4)}" cy="${r(cy)}" r="4"${paint.attrs(seriesColor(item.k))}/>`,
          svgText(paint, x + LEGEND_NAME_X, cy, name, {
            ...style,
            color: "textMuted",
            ...(name === s.label ? {} : { title: s.label }),
          }),
          svgText(
            paint,
            x + LEGEND_NAME_X + textWidth(name, style) + 6,
            cy,
            formatValue(s.values[last] ?? null, metricOf(ctx, s.metric), locale, "compact"),
            { ...style, color: "text", className: `hm-rv hm-rv-${item.k}` },
          ),
        );
      }
      x += item.width + LEGEND_GAP;
    }
    legendHeight = row * LEGEND_ROW + LABEL_LINE;
    readout = `<g class="hm-readout">${parts.join("")}</g>`;
  }

  const top = legendHeight > 0 ? legendHeight + 16 : top0;
  const height = top + size.height - top0;
  const plotBottom = height - bottomBand;
  const axis = yAxis(values, plotBottom - top, metric, locale);
  const [d0, d1] = axis.domain;
  const y = (v: number) => plotBottom - fraction(v, d0, d1) * (plotBottom - top);
  const targets = series.map((_, k) => {
    const v = (plotted[k] as Value[])[lastIndex[k] ?? -1];
    return isNumber(v) ? y(v) : plotBottom;
  });
  const centres = direct ? stackLabels(targets, LABEL_LINE, 2, 0, plotBottom + 4) : [];
  const moved = centres.some((c, k) => Math.abs(c - (targets[k] as number)) > 0.5);
  const plotLeft = empty ? 0 : axis.labelWidth + 8;
  const plotRight = size.width - (direct ? directWidth + (moved ? 6 : 0) : 4);
  const plotWidth = plotRight - plotLeft;
  const step = n > 1 ? plotWidth / (n - 1) : 0;
  const x = (i: number) => (n > 1 ? plotLeft + i * step : plotLeft + plotWidth / 2);

  const parts: string[] = [readout];
  parts.push(
    empty
      ? svgLine(paint, plotLeft, plotBottom, plotRight, plotBottom, "baseline")
      : drawYAxis(paint, axis, y, plotLeft, plotRight),
  );

  const stacked = block.type === "area" && block.stack === true;
  if (block.type === "area") {
    const order = series.map((_, k) => k).reverse();
    for (const k of order) {
      const lower = bands.lower[k] as Value[];
      const area = d3area<Value>()
        .defined((v) => isNumber(v))
        .x((_, i) => x(i))
        .y0((_, i) => y(stacked ? (lower[i] as number) : Math.max(d0, Math.min(0, d1))))
        .y1((v) => y(v as number))
        .digits(1)(plotted[k] as Value[]);
      if (area) {
        parts.push(`<path d="${area}"${paint.attrs(seriesColor(k))} fill-opacity="0.14"/>`);
      }
    }
  }
  for (let k = series.length - 1; k >= 0; k--) {
    const vals = plotted[k] as Value[];
    const path = d3line<Value>()
      .defined((v) => isNumber(v))
      .x((_, i) => x(i))
      .y((v) => y(v as number))
      .digits(1)(vals);
    if (path) {
      parts.push(
        `<path d="${path}"${paint.attrs("none", seriesColor(k))} stroke-width="${LINE_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    }
    vals.forEach((v, i) => {
      if (isNumber(v) && !isNumber(vals[i - 1]) && !isNumber(vals[i + 1])) {
        parts.push(`<circle cx="${r(x(i))}" cy="${r(y(v))}" r="2"${paint.attrs(seriesColor(k))}/>`);
      }
    });
  }

  parts.push(
    ...timeLabels(block.axis, x, locale, 0, size.width).map((label) =>
      svgText(paint, label.x, plotBottom + 16, label.text, {
        size: CAPTION,
        anchor: "middle",
        color: "textSubtle",
      }),
    ),
  );

  if (empty)
    parts.push(emptyNote(paint, series, ctx, plotLeft + plotWidth / 2, (top + plotBottom) / 2));

  if (direct) {
    const labelX = plotRight + (moved ? 14 : 8);
    series.forEach((_, k) => {
      const centre = centres[k] as number;
      const target = targets[k] as number;
      if (moved && Math.abs(centre - target) > 0.5) {
        parts.push(
          `<polyline points="${r(plotRight + 2)},${r(target)} ${r(plotRight + 6)},${r(target)} ${r(plotRight + 10)},${r(centre)}"${paint.attrs("none", "textSubtle")}/>`,
        );
      }
      const name = series[k]?.label ?? "";
      const nameWidth = textWidth(name, nameStyle);
      parts.push(
        `<circle cx="${r(labelX + 4)}" cy="${r(centre)}" r="4"${paint.attrs(seriesColor(k))}/>`,
        svgText(paint, labelX + 12, centre, name, {
          ...nameStyle,
          color: "text",
        }),
        svgText(paint, labelX + 12 + nameWidth + 6, centre, lastText[k] as string, {
          size: CAPTION,
          color: "textMuted",
        }),
      );
    });
  }

  return svgRoot(
    { width: size.width, height },
    block.title ?? series.map((s) => s.label).join(", "),
    {
      kind: "line",
      x: `${r(x(0))},${r(x(n - 1))},${n}`,
      y: `${d0},${d1},${r(plotBottom)},${r(top)}`,
      plot: `${r(plotLeft)},${r(top)},${r(plotRight)},${r(plotBottom)}`,
      ...(direct ? {} : { readout: 1 }),
    },
    parts.join(""),
    standalone,
  );
}
