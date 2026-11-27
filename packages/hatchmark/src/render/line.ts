import { area as d3area, line as d3line } from "d3-shape";
import type { LineData, Value } from "../compiler/dashboard-data.js";
import { timeLabels } from "./axis.js";
import {
  BODY,
  CAPTION,
  type ChartSize,
  drawYAxis,
  emptyNote,
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
const READOUT_PAD_X = 10;
const READOUT_PAD_Y = 8;
const READOUT_COLUMNS = 3;
const READOUT_GAP = 8;
/** A tall readout (long names in one column) grows the chart instead of squeezing the plot below this. */
const READOUT_MIN_PLOT = 80;

/** Values as drawn: cumulative for stacked areas (missing values count as 0 there). */
export function plottedValues(block: LineData): Value[][] {
  if (!(block.type === "area" && block.stack)) return block.series.map((s) => s.values);
  const totals = block.axis.buckets.map(() => 0);
  return block.series.map((s) =>
    s.values.map((v, i) => {
      totals[i] = (totals[i] ?? 0) + (isNumber(v) ? v : 0);
      return totals[i] as number;
    }),
  );
}

/**
 * A line or area chart over a time axis. Direct labels sit at the line ends when the plot is at
 * least 320 px wide and there are at most 6 series; otherwise a pinned readout above the plot names
 * the series with their latest values (the runtime updates it on hover).
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
  const plotted = plottedValues(block);
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
  let readoutHeight = 0;
  if (!direct && !empty && series.length > 0) {
    const inner = size.width - 2 - READOUT_PAD_X * 2;
    const needed = Math.max(
      ...series.map((s, k) =>
        Math.max(
          13 + textWidth(s.label, { size: CAPTION }),
          textWidth(lastText[k] as string, { size: BODY, weight: 500 }),
        ),
      ),
    );
    let columns = Math.min(series.length, READOUT_COLUMNS);
    while (columns > 1 && inner / columns - READOUT_GAP < needed) columns--;
    const rows = Math.ceil(series.length / columns);
    const inline = columns === 1 && series.length > 1;
    const pitch = inline ? LABEL_LINE + 6 : 40;
    readoutHeight = READOUT_PAD_Y * 2 + LABEL_LINE + 4 + rows * pitch - 6;
    const colWidth = inner / columns;
    const last = Math.max(...lastIndex);
    const parts = [
      `<rect x="0.5" y="0.5" width="${r(size.width - 1)}" height="${readoutHeight - 1}" rx="${ctx.theme.radius.control}"${paint.attrs("cardAlt", "border")}/>`,
      svgText(
        paint,
        READOUT_PAD_X + 1,
        READOUT_PAD_Y + LABEL_LINE / 2,
        last >= 0 ? formatBucket(block.axis.buckets[last] as string, block.axis.grain, locale) : "",
        { size: CAPTION, weight: 500, color: "textMuted", className: "hm-rh" },
      ),
    ];
    series.forEach((s, k) => {
      const col = k % columns;
      const row = Math.floor(k / columns);
      const x = READOUT_PAD_X + 1 + col * colWidth;
      const y = READOUT_PAD_Y + LABEL_LINE + 4 + row * pitch;
      const valueStyle = { size: BODY, weight: 500 } as const;
      const room = inline
        ? colWidth -
          25 -
          Math.max(
            ...s.values.map((v) =>
              textWidth(formatValue(v, metricOf(ctx, s.metric), locale, "compact"), valueStyle),
            ),
          )
        : colWidth - 17;
      parts.push(
        `<circle cx="${r(x + 4)}" cy="${r(y + 8)}" r="4"${paint.attrs(seriesColor(k))}/>`,
        svgText(paint, x + 13, y + 8, truncateEnd(s.label, room, { size: CAPTION }), {
          size: CAPTION,
          color: "textMuted",
          ...(textWidth(s.label, { size: CAPTION }) > room ? { title: s.label } : {}),
        }),
        svgText(
          paint,
          inline ? size.width - 1 - READOUT_PAD_X : x,
          inline ? y + 8 : y + 16 + 9,
          lastText[k] as string,
          {
            ...valueStyle,
            color: "text",
            className: `hm-rv hm-rv-${k}`,
            ...(inline ? { anchor: "end" as const } : {}),
          },
        ),
      );
    });
    readout = `<g class="hm-readout">${parts.join("")}</g>`;
  }

  const top = readoutHeight > 0 ? readoutHeight + 16 : top0;
  const height = Math.max(size.height, readoutHeight > 0 ? top + READOUT_MIN_PLOT + bottomBand : 0);
  const plotBottom = height - bottomBand;
  const axis = yAxis(values, plotBottom - top, metric, locale);
  const [d0, d1] = axis.domain;
  const y = (v: number) => plotBottom - ((v - d0) / (d1 - d0)) * (plotBottom - top);
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
      const lower = stacked && k > 0 ? (plotted[k - 1] as Value[]) : undefined;
      const area = d3area<Value>()
        .defined((v) => isNumber(v))
        .x((_, i) => x(i))
        .y0((_, i) => y(lower ? (lower[i] ?? 0) : Math.max(d0, Math.min(0, d1))))
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
      x: `${r(x(0))},${r(step)},${n}`,
      y: `${d0},${d1},${r(plotBottom)},${r(top)}`,
      plot: `${r(plotLeft)},${r(top)},${r(plotRight)},${r(plotBottom)}`,
      ...(direct ? {} : { readout: 1 }),
    },
    parts.join(""),
    standalone,
  );
}
