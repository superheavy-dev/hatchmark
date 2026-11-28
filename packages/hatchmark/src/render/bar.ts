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
  GROUP_STYLE,
  groupHeading,
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
import { hatchDefs, hollowPoint, partialBar, partialId } from "./partial.js";
import { r, svgLine, svgText } from "./svg.js";
import {
  type ChartTargets,
  chartTargets,
  paceMarker,
  targetDash,
  targetExtent,
  targetKey,
} from "./target.js";
import { type ColorKey, type Paint, type SeriesPaint, seriesPaints, type Theme } from "./theme.js";

const BAR_THICKNESS = 10;
const GROUPED_THICKNESS = 8;
const VALUE_GAP = 6;
const KEY_GAP = 16;

export function barCategories(block: BarData, locale: string): string[] {
  return block.axis.kind === "category"
    ? block.axis.categories.map((c) => formatKey(c, locale))
    : block.axis.buckets.map((b) =>
        formatBucket(b, (block.axis as { grain: "day" }).grain, locale),
      );
}

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

function drawnValues(block: BarData, s: BarData["series"][number]): Value[] {
  return block.percent && s.share ? s.share : s.values;
}

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

interface KeyItem {
  label: string;
  fill: ColorKey;
  heading?: string;
}

function keyItems(block: BarData, theme: Theme): KeyItem[] {
  const paints = seriesPaints(theme, block.series, block.groups?.length);
  return block.series.map((s, k) => {
    const heading = groupHeading(block, k);
    return {
      label: s.label,
      fill: (paints[k] as SeriesPaint).fill,
      ...(heading === undefined ? {} : { heading }),
    };
  });
}

function drawKey(
  paint: Paint,
  items: readonly KeyItem[],
  width: number,
): { svg: string; height: number } {
  if (items.length < 2) return { svg: "", height: 0 };
  const parts: string[] = [];
  let x = 0;
  let row = 0;
  items.forEach(({ label, fill, heading }) => {
    const text = truncateEnd(label, width - 14, { size: CAPTION });
    const w = 14 + textWidth(text, { size: CAPTION });
    if (heading !== undefined) {
      const shown = truncateEnd(heading, Math.max(width / 2, width - w - 8), GROUP_STYLE);
      const headingWidth = textWidth(shown, GROUP_STYLE) + 8;
      if (x > 0 && x + headingWidth + w > width) {
        x = 0;
        row++;
      }
      parts.push(
        svgText(paint, x, row * LABEL_LINE + LABEL_LINE / 2, shown, {
          ...GROUP_STYLE,
          color: "text",
          ...(shown === heading ? {} : { title: heading }),
        }),
      );
      x += headingWidth;
    }
    if (x > 0 && x + w > width) {
      x = 0;
      row++;
    }
    const cy = row * LABEL_LINE + LABEL_LINE / 2;
    parts.push(
      `<rect x="${r(x)}" y="${r(cy - 4)}" width="8" height="8" rx="1"${paint.attrs(fill)}/>`,
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

const SHARE_AXIS_BAND = 20;
const SHARE_QUARTERS_WIDTH = 240;

const KEY_ROW = LABEL_LINE + 8;

const NAME_STYLE = { size: BODY };
const NAME_LINES = 2;
const NAME_LINE = 17;

function rowNames(names: string[], width: number) {
  const column = Math.min(width * 0.4, Math.max(0, ...names.map((t) => textWidth(t, NAME_STYLE))));
  return { column, wrapped: names.map((t) => wrapLines(t, column, NAME_STYLE, NAME_LINES)) };
}

export interface BarRows {
  barRow: number;
  barRowMax: number;
}

export function barRowHeight(
  block: BarData,
  ctx: RenderContext,
  chartHeight: number,
  rows: BarRows,
): number {
  const n = Math.max(1, barCategories(block, ctx.data.locale).length);
  if (block.series.length > 1 && !block.stack) {
    const thick = block.series.length * GROUPED_THICKNESS + (block.series.length - 1) * 2;
    return Math.max(rows.barRow, thick + 12);
  }
  return Math.max(rows.barRow, Math.min(rows.barRowMax, Math.floor(chartHeight / n)));
}

function goalKey(block: BarData, ctx: RenderContext, width: number, empty: boolean) {
  const goals = chartTargets(block, ctx);
  const key = goals && !empty ? targetKey(ctx, goals, width, "tick") : { svg: "", height: 0 };
  return { goals, key };
}

const hasValues = (block: BarData) => block.series.some((s) => s.values.some(isNumber));

function goalReach(goals: ChartTargets | undefined, i: number, k?: number): number[] {
  return (goals?.tracks ?? [])
    .filter((t) => t.drawn && (k === undefined || t.series === k))
    .flatMap((t) => [t.values[i] ?? null, t.pace?.[i] ?? null])
    .filter(isNumber);
}

export function barHeight(
  block: BarData,
  ctx: RenderContext,
  width: number,
  chartHeight: number,
  rows: BarRows,
): number {
  const key =
    drawKey(cssLessPaint, keyItems(block, ctx.theme), width).height +
    goalKey(block, ctx, width, !hasValues(block)).key.height;
  if (block.orientation === "vertical") return chartHeight + Math.max(0, key - KEY_ROW);
  const names = barCategories(block, ctx.data.locale);
  const wraps = rowNames(names, width).wrapped.some((w) => w.lines.length > 1);
  const row = barRowHeight(block, ctx, chartHeight, rows);
  return (
    key +
    Math.max(1, names.length) * (wraps ? Math.max(row, NAME_LINES * NAME_LINE + 6) : row) +
    (block.percent ? SHARE_AXIS_BAND : 0)
  );
}

const cssLessPaint: Paint = { attrs: () => "" };

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
  const empty = !hasValues(block);
  const { goals, key: goalRow } = goalKey(block, ctx, size.width, empty);
  const goalPad = Math.max(
    ctx.theme.target.tick.width / 2 + ctx.theme.target.tick.haloWidth,
    ctx.theme.target.pace.size / 2,
  );
  const clear = (end: number, reach: number[], neg: boolean) => {
    const far = neg ? Math.min(end, ...reach) : Math.max(end, ...reach);
    return { far, pad: far === end ? 0 : goalPad };
  };
  const ends = [...ext.flat().flat(), ...(empty ? [] : targetExtent(goals))];
  const totals = labelValues(block, stacked);
  const totalText = totals?.map((v) =>
    isNumber(v) ? formatValue(v, metric, locale, "compact") : "",
  );
  const paints = seriesPaints(ctx.theme, series, block.groups?.length);
  const strokeOf = (k: number) => (paints[k] as SeriesPaint).stroke;
  const fillOf = (k: number) => (paints[k] as SeriesPaint).fill;
  const seriesKey = drawKey(paint, keyItems(block, ctx.theme), size.width);
  const key = {
    height: goalRow.height + seriesKey.height,
    svg:
      goalRow.svg +
      (goalRow.height > 0 && seriesKey.svg
        ? `<g transform="translate(0,${goalRow.height})">${seriesKey.svg}</g>`
        : seriesKey.svg),
  };
  const parts: string[] = [key.svg];
  const label = block.title ?? series.map((s) => s.label).join(", ");
  const partial = series.map((s) =>
    ctx.data.metrics[s.metric]?.nature === "point"
      ? new Set<number>()
      : new Set((s.partial ?? []).map((p) => p.index)),
  );
  const markers = series.map((s) =>
    ctx.data.metrics[s.metric]?.nature === "point"
      ? new Set((s.partial ?? []).map((p) => p.index))
      : new Set<number>(),
  );
  const marks: string[] = [];
  const hatch = partialId(block, size.width);
  const anyPartial = !empty && partial.some((p) => p.size > 0);
  const defs = (x: number, y: number) =>
    anyPartial
      ? hatchDefs(
          paint,
          hatch,
          series.map((_, k) => fillOf(k)),
          ctx.theme.partial.spacing,
          x,
          y,
        )
      : "";

  if (block.orientation === "horizontal") {
    const top = key.height;
    const band = block.percent ? SHARE_AXIS_BAND : 0;
    const rowH = (size.height - top - band) / Math.max(1, n);
    const { column: labelWidth, wrapped } = rowNames(names, size.width);
    const grouped = multi && !stacked;
    const valueStyle = { size: grouped ? CAPTION : BODY, weight: 500 } as const;
    const valueTexts = grouped
      ? series.map((s) =>
          s.values.map((v) => (isNumber(v) ? formatValue(v, metric, locale, "compact") : "")),
        )
      : [totalText ?? []];
    const hasNegative = ends.some((v) => v < 0);
    const textWidthMax = Math.max(0, ...valueTexts.flat().map((t) => textWidth(t, valueStyle)));
    const plotRoom = size.width - labelWidth - 12;
    const labelRoom = (textWidthMax + VALUE_GAP) * (hasNegative ? 2 : 1);
    const showValues = plotRoom - labelRoom >= plotRoom / 2;
    const valueWidth = showValues ? textWidthMax : 0;
    const barLeft = labelWidth + 12 + (hasNegative && showValues ? valueWidth + VALUE_GAP : 0);
    const barRight = size.width - (showValues ? valueWidth + VALUE_GAP : 0);
    const shares =
      block.percent && !empty
        ? shareAxis(ends, barRight - barLeft, locale, SHARE_QUARTERS_WIDTH)
        : undefined;
    const [lo, hi] = shares?.domain ?? [Math.min(0, ...ends), Math.max(0, ...ends)];
    const scale = (v: number) =>
      hi === lo ? barLeft : barLeft + fraction(v, lo, hi) * (barRight - barLeft);
    const zero = scale(0);
    parts.push(defs(barLeft, top));
    shares?.ticks.forEach((t, k) => {
      const x = scale(t);
      parts.push(
        svgLine(paint, x, top, x, top + n * rowH, t === 0 ? "baseline" : "grid"),
        svgText(paint, x, top + n * rowH + band / 2 + 2, shares.labels[k] as string, {
          size: CAPTION,
          anchor: k === 0 ? "start" : k === shares.ticks.length - 1 ? "end" : "middle",
          color: "textSubtle",
          lang: shares.locale,
        }),
      );
    });
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
          partial[k]?.has(i)
            ? partialBar(ctx, hatch, fillOf(k), x0, cy + offset - thick / 2, w, thick, w)
            : `<rect x="${r(x0)}" y="${r(cy + offset - thick / 2)}" width="${r(w)}" height="${thick}" rx="${ctx.theme.radius.bar}"${paint.attrs(fillOf(k))}/>`,
        );
        if (markers[k]?.has(i)) marks.push(hollowPoint(ctx, strokeOf(k), scale(b), cy + offset));
        if (grouped && showValues) {
          const text = (valueTexts[k] as string[])[i] as string;
          const neg = b < 0;
          const { far, pad } = clear(
            b,
            goalReach(goals, i, series.length > 1 ? k : undefined),
            neg,
          );
          const gap = VALUE_GAP + pad;
          parts.push(
            svgText(paint, scale(far) + (neg ? -gap : gap), cy + offset, text, {
              ...valueStyle,
              anchor: neg ? "end" : "start",
              color: "textMuted",
              lang: locale,
            }),
          );
        }
      });
      if (!grouped && showValues) {
        const total = totals?.[i];
        if (isNumber(total)) {
          const end = stacked
            ? Math.max(...ext.map((e) => (e[i] as [number, number])[1]), 0)
            : total;
          const neg = !stacked && total < 0;
          const { far, pad } = clear(neg ? total : end, goalReach(goals, i), neg);
          const gap = VALUE_GAP + pad;
          parts.push(
            svgText(
              paint,
              scale(far) + (neg ? -gap : gap),
              cy,
              (totalText as string[])[i] as string,
              {
                ...valueStyle,
                anchor: neg ? "end" : "start",
                color: partial.some((p) => p.has(i)) ? "textMuted" : "text",
                lang: locale,
              },
            ),
          );
        }
      }
    });
    if (hasNegative) {
      parts.push(svgLine(paint, zero, top, zero, top + n * rowH, "baseline"));
    }
    parts.push(...marks);
    if (!empty && goals) {
      parts.push(
        ...goalMarks(ctx, goals, n, grouped, series.length, {
          position: scale,
          across: (i, k) => {
            const thick = grouped ? GROUPED_THICKNESS : BAR_THICKNESS;
            const cy = top + i * rowH + rowH / 2;
            const offset =
              k === undefined || !grouped
                ? 0
                : (k - (series.length - 1) / 2) * (GROUPED_THICKNESS + 2);
            return [cy + offset - thick / 2, cy + offset + thick / 2];
          },
          span: [top, top + n * rowH],
          horizontal: true,
        }),
      );
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
  parts.push(defs(plotLeft, top));
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
      const h = Math.max(1, Math.abs(y(b) - y(a)));
      parts.push(
        partial[k]?.has(i)
          ? partialBar(ctx, hatch, fillOf(k), x, top1, w, h, h)
          : `<rect x="${r(x)}" y="${r(top1)}" width="${r(w)}" height="${r(h)}" rx="${ctx.theme.radius.bar}"${paint.attrs(fillOf(k))}/>`,
      );
      if (markers[k]?.has(i)) marks.push(hollowPoint(ctx, strokeOf(k), x + w / 2, y(b)));
    });
    if (showValues) {
      const total = totals?.[i];
      if (isNumber(total)) {
        const end = stacked
          ? total >= 0
            ? Math.max(...ext.map((e) => (e[i] as [number, number])[1]), 0)
            : Math.min(...ext.map((e) => (e[i] as [number, number])[1]), 0)
          : total;
        const { far, pad } = clear(end, goalReach(goals, i), total < 0);
        const ly =
          total >= 0 ? y(far) - 4 - pad - LABEL_LINE / 2 : y(far) + 4 + pad + LABEL_LINE / 2;
        parts.push(
          svgText(paint, x0 + bw / 2, ly, (totalText as string[])[i] as string, {
            ...valueStyle,
            anchor: "middle",
            color: "textMuted",
            lang: locale,
          }),
        );
      }
    }
  });

  parts.push(...marks);
  if (!empty && goals) {
    const groupedBars = multi && !stacked;
    parts.push(
      ...goalMarks(ctx, goals, n, groupedBars, series.length, {
        position: y,
        across: (i, k) => {
          const x0 = band(i) as number;
          if (k === undefined || !groupedBars) return [x0, x0 + bw];
          const x = x0 + (inner(k) as number);
          return [x, x + inner.bandwidth()];
        },
        span: [plotLeft, plotRight],
        horizontal: false,
      }),
    );
  }
  const centre = (i: number) => (band(i) as number) + bw / 2;
  if (block.axis.kind === "time") {
    parts.push(
      ...timeLabels(block.axis, centre, locale, 0, size.width).map((l) =>
        svgText(paint, l.x, plotBottom + 16, l.text, {
          size: CAPTION,
          anchor: "middle",
          color: "textSubtle",
          lang: locale,
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

function goalMarks(
  ctx: RenderContext,
  goals: ChartTargets,
  n: number,
  grouped: boolean,
  seriesCount: number,
  geometry: {
    position: (v: number) => number;
    across: (i: number, k: number | undefined) => [number, number];
    span: [number, number];
    horizontal: boolean;
  },
): string[] {
  const { paint, theme } = ctx;
  const tick = theme.target.tick;
  const { position, across, span, horizontal } = geometry;
  const line = (a: number, b: number, at: number, stroke: string) =>
    horizontal
      ? `<line x1="${r(at)}" y1="${r(a)}" x2="${r(at)}" y2="${r(b)}"${stroke}/>`
      : `<line x1="${r(a)}" y1="${r(at)}" x2="${r(b)}" y2="${r(at)}"${stroke}/>`;
  const halo = `${paint.attrs(undefined, tick.halo)} stroke-width="${tick.width + 2 * tick.haloWidth}"`;
  const ink = `${paint.attrs(undefined, tick.color, "hm-target")} stroke-width="${tick.width}"`;
  const out: string[] = [];
  for (const track of goals.tracks) {
    if (!track.drawn) continue;
    const k = grouped && seriesCount > 1 ? track.series : undefined;
    for (let i = 0; i < n; i++) {
      const v = track.values[i];
      const [a, b] = across(i, k);
      if (isNumber(v)) {
        const at = position(v);
        out.push(
          line(a - tick.overhang, b + tick.overhang, at, halo),
          line(a - tick.overhang, b + tick.overhang, at, ink),
        );
      }
      const pace = track.pace?.[i];
      if (isNumber(pace)) {
        const mid = (a + b) / 2;
        out.push(
          horizontal ? paceMarker(ctx, position(pace), mid) : paceMarker(ctx, mid, position(pace)),
        );
      }
    }
  }
  const w = goals.window;
  if (w && isNumber(w.value)) {
    const at = position(w.value);
    out.push(
      line(
        span[0],
        span[1],
        at,
        `${paint.attrs(undefined, theme.target.line.color, "hm-target")}${targetDash(ctx)}`,
      ),
    );
    if (isNumber(w.pace ?? null)) {
      const p = position(w.pace as number);
      out.push(horizontal ? paceMarker(ctx, p, span[1]) : paceMarker(ctx, span[1] - 4, p));
    }
  }
  return out;
}
