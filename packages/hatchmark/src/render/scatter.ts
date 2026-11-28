import type { MetricInfo, ScatterData, ScatterPoint } from "../compiler/dashboard-data.js";
import { scatterTicks } from "./axis.js";
import {
  BODY,
  CAPTION,
  type ChartSize,
  drawYAxis,
  fraction,
  isNumber,
  LABEL_LINE,
  metricOf,
  type RenderContext,
  svgRoot,
  TICK_PADDING,
  type YAxis,
} from "./chart.js";
import { formatTicks } from "./format.js";
import { textWidth } from "./measure.js";
import { r, svgLine, svgText } from "./svg.js";

const MIN_RADIUS = 3;
const DOT_RADIUS = 4;
const MAX_RADIUS = 14;
const NARROW_MAX_RADIUS = 10;
const NARROW_PLOT = 400;
const LABEL_GAP = 6;
const MIN_LABEL_GAP = 8;
const HEADER_GAP = 16;

type Placeable = ScatterPoint & { x: number; y: number };

export function scatterPoints(block: ScatterData): Placeable[] {
  return block.points.filter((p): p is Placeable => isNumber(p.x) && isNumber(p.y));
}

export function scatterOrder(block: ScatterData): number[] {
  const points = scatterPoints(block);
  return points
    .map((_, i) => i)
    .sort((a, b) => {
      const pa = points[a] as Placeable;
      const pb = points[b] as Placeable;
      return pa.x - pb.x || pa.y - pb.y || (pa.label < pb.label ? -1 : pa.label > pb.label ? 1 : 0);
    });
}

function axisFor(
  values: readonly number[],
  length: number,
  spacing: number,
  metric: MetricInfo,
  locale: string,
): YAxis {
  const { domain, ticks } = scatterTicks(values, length, spacing);
  const labels = formatTicks(ticks, metric, locale);
  const labelWidth = Math.max(0, ...labels.map((l) => textWidth(l, { size: CAPTION })));
  return { domain, ticks, labels, labelWidth, locale };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function hitsCircle(box: Box, cx: number, cy: number, radius: number): boolean {
  const nx = Math.max(box.x0, Math.min(cx, box.x1));
  const ny = Math.max(box.y0, Math.min(cy, box.y1));
  return (nx - cx) ** 2 + (ny - cy) ** 2 < radius ** 2;
}

interface Placed {
  p: Placeable;
  cx: number;
  cy: number;
  r: number;
}

export function renderScatter(
  block: ScatterData,
  ctx: RenderContext,
  size: ChartSize,
  standalone?: { font: string; background: string },
): string {
  const { paint, data } = ctx;
  const locale = data.locale;
  const mx = metricOf(ctx, block.x);
  const my = metricOf(ctx, block.y);
  const ms = block.size === undefined ? undefined : metricOf(ctx, block.size);
  const points = scatterPoints(block);
  const empty = points.length === 0;
  const caption = { size: CAPTION } as const;

  const sizeKey = ms ? `Bubble size: ${ms.label}` : "";
  const keyOnRow =
    sizeKey !== "" &&
    textWidth(my.label, caption) + HEADER_GAP + textWidth(sizeKey, caption) <= size.width;
  const top = (sizeKey === "" || keyOnRow ? 1 : 2) * LABEL_LINE + 8;
  const plotHeight = Math.max(40, size.height - 32);
  const plotBottom = top + plotHeight;
  const height = plotBottom + 40;

  const yAxis = axisFor(
    points.map((p) => p.y),
    plotHeight,
    48,
    my,
    locale,
  );
  const plotLeft = empty ? 0 : yAxis.labelWidth + TICK_PADDING;
  const plotRight = size.width - 4;
  const plotWidth = plotRight - plotLeft;
  const maxRadius = ms ? (plotWidth < NARROW_PLOT ? NARROW_MAX_RADIUS : MAX_RADIUS) : DOT_RADIUS;
  const inset = maxRadius + 2;
  const [y0, y1] = yAxis.domain;
  const y = (v: number) => plotBottom - inset - fraction(v, y0, y1) * (plotHeight - 2 * inset);
  const xAt = (axis: YAxis) => (v: number) =>
    plotLeft + inset + fraction(v, axis.domain[0], axis.domain[1]) * (plotWidth - 2 * inset);
  const tickCentre = (label: string, at: number) => {
    const w = textWidth(label, caption);
    return Math.max(w / 2, Math.min(size.width - w / 2, at));
  };
  const fits = (axis: YAxis) => {
    const at = xAt(axis);
    const boxes = axis.labels.map((label, k) => {
      const w = textWidth(label, caption);
      const centre = tickCentre(label, at(axis.ticks[k] as number));
      return [centre - w / 2, centre + w / 2] as const;
    });
    return boxes.every((b, k) => k === 0 || (boxes[k - 1]?.[1] ?? 0) + MIN_LABEL_GAP <= b[0]);
  };
  const xs = points.map((p) => p.x);
  let xAxis = axisFor(xs, plotWidth, 96, mx, locale);
  for (let spacing = 144; !fits(xAxis) && spacing <= 480; spacing += 48) {
    xAxis = axisFor(xs, plotWidth, spacing, mx, locale);
  }
  if (!fits(xAxis)) {
    const ticks = xAxis.ticks.filter((_, k) => k % 2 === 0);
    xAxis = { ...xAxis, ticks, labels: formatTicks(ticks, mx, locale) };
  }
  const x = xAt(xAxis);

  const maxSize = Math.max(0, ...points.map((p) => (isNumber(p.size) ? p.size : 0)));
  const radius = (p: ScatterPoint) => {
    if (!ms) return DOT_RADIUS;
    if (!isNumber(p.size) || p.size <= 0 || maxSize <= 0) return MIN_RADIUS;
    return Math.max(MIN_RADIUS, maxRadius * Math.sqrt(p.size / maxSize));
  };
  const placed: Placed[] = points.map((p) => ({ p, cx: x(p.x), cy: y(p.y), r: radius(p) }));

  const parts: string[] = [
    svgText(paint, 0, LABEL_LINE / 2, my.label, { ...caption, color: "textSubtle" }),
  ];
  if (sizeKey !== "") {
    parts.push(
      keyOnRow
        ? svgText(paint, size.width, LABEL_LINE / 2, sizeKey, {
            ...caption,
            anchor: "end",
            color: "textSubtle",
          })
        : svgText(paint, 0, LABEL_LINE * 1.5, sizeKey, { ...caption, color: "textSubtle" }),
    );
  }

  if (empty) {
    parts.push(
      svgLine(paint, plotLeft, plotBottom, plotRight, plotBottom, "baseline"),
      svgText(
        paint,
        plotLeft + plotWidth / 2,
        (top + plotBottom) / 2,
        block.empty === "no_complete_day" ? "No complete day yet" : "No data in this period",
        {
          size: BODY,
          anchor: "middle",
          color: "textMuted",
        },
      ),
    );
  } else {
    parts.push(drawYAxis(paint, yAxis, y, plotLeft, plotRight));
    const [x0, x1] = xAxis.domain;
    if (x0 < 0 && x1 > 0) parts.push(svgLine(paint, x(0), top, x(0), plotBottom, "baseline"));
    xAxis.ticks.forEach((t, k) => {
      const label = xAxis.labels[k] as string;
      parts.push(
        svgText(paint, tickCentre(label, x(t)), plotBottom + 16, label, {
          ...caption,
          anchor: "middle",
          color: "textSubtle",
          lang: xAxis.locale,
        }),
      );
    });
    for (const c of placed) {
      parts.push(
        '<circle cx="' +
          r(c.cx) +
          '" cy="' +
          r(c.cy) +
          '" r="' +
          r(c.r) +
          '"' +
          paint.attrs("c1", "card") +
          ' fill-opacity="0.7"/>',
      );
    }
    parts.push(
      ...directLabels(ctx, placed, block.size !== undefined, plotWidth, {
        left: plotLeft,
        top,
        bottom: plotBottom,
        width: size.width,
      }),
    );
  }
  parts.push(
    svgText(paint, plotRight, plotBottom + 34, mx.label, {
      ...caption,
      anchor: "end",
      color: "textSubtle",
    }),
  );

  const pts = scatterOrder(block)
    .map((i) => {
      const c = placed[i] as Placed;
      return `${r(c.cx)} ${r(c.cy)} ${r(c.r)} ${i}`;
    })
    .join(",");
  return svgRoot(
    { width: size.width, height },
    block.title ?? `${my.label} against ${mx.label}`,
    {
      kind: "scatter",
      plot: [plotLeft, top, plotRight, plotBottom].map(r).join(","),
      pts,
    },
    parts.join(""),
    standalone,
  );
}

function directLabels(
  ctx: RenderContext,
  placed: Placed[],
  sized: boolean,
  plotWidth: number,
  bounds: { left: number; top: number; bottom: number; width: number },
): string[] {
  const wanted = plotWidth < NARROW_PLOT ? 3 : 5;
  const indices = placed.map((_, i) => i);
  const most = (f: (c: Placed) => number) =>
    indices.reduce((best, i) => (f(placed[i] as Placed) > f(placed[best] as Placed) ? i : best));
  const candidates = sized
    ? indices
    : [
        most((c) => c.p.y),
        most((c) => c.p.x),
        most((c) => -c.p.y),
        most((c) => -c.p.x),
        ...indices,
      ];
  const style = { size: CAPTION } as const;
  const taken: Box[] = [];
  const out: string[] = [];
  const tried = new Set<number>();
  for (const i of candidates) {
    if (out.length >= wanted || tried.size >= wanted * 3) break;
    if (tried.has(i)) continue;
    tried.add(i);
    const c = placed[i] as Placed;
    const w = textWidth(c.p.label, style);
    const h = LABEL_LINE;
    const options: [number, number, "start" | "end" | "middle"][] = [
      [c.cx + c.r + LABEL_GAP, c.cy, "start"],
      [c.cx - c.r - LABEL_GAP, c.cy, "end"],
      [c.cx, c.cy - c.r - LABEL_GAP / 2 - h / 2, "middle"],
      [c.cx, c.cy + c.r + LABEL_GAP / 2 + h / 2, "middle"],
    ];
    for (const [lx, ly, anchor] of options) {
      const x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
      const box = { x0, y0: ly - h / 2 + 2, x1: x0 + w, y1: ly + h / 2 - 2 };
      if (box.x0 < bounds.left || box.x1 > bounds.width) continue;
      if (box.y0 < bounds.top || box.y1 > bounds.bottom) continue;
      if (taken.some((t) => overlaps(t, box))) continue;
      if (placed.some((o, k) => k !== i && hitsCircle(box, o.cx, o.cy, o.r + 1))) continue;
      taken.push(box);
      out.push(svgText(ctx.paint, lx, ly, c.p.label, { ...style, anchor, color: "textMuted" }));
      break;
    }
  }
  return out;
}
