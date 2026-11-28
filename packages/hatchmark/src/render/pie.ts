import type { PieData, Value } from "../compiler/dashboard-data.js";
import {
  BODY,
  CAPTION,
  type ChartSize,
  isNumber,
  LABEL_LINE,
  metricOf,
  type RenderContext,
  SHARE,
  svgRoot,
} from "./chart.js";
import { formatValue } from "./format.js";
import { textWidth, truncateEnd, wrapLines } from "./measure.js";
import { r, svgText } from "./svg.js";
import { type ColorKey, seriesFill } from "./theme.js";

/** Below this width the key goes under the pie instead of beside it. */
export const PIE_SIDE_KEY_MIN = 440;
const HOLE = 0.62;
const MAX_DIAMETER = 240;
const KEY_GAP = 32;
const ROW = 24;
const NAME_LINE = 17;
const DOT = 8;
const SHARE_WIDTH = 48;
const VALUE_GAP = 12;

/** One drawn slice: a category, or Other. */
export interface PieItem {
  label: string;
  value: number;
  share: number;
  color: ColorKey;
}

/** The slices as drawn, Other last in the neutral context colour. */
export function pieItems(block: PieData): PieItem[] {
  const items: PieItem[] = block.slices.map((s, k) => ({
    label: s.label,
    value: s.value,
    share: s.share,
    color: seriesFill(k),
  }));
  if (block.other) {
    items.push({
      label: `Other (${block.other.count} more)`,
      value: block.other.value,
      share: block.other.share,
      color: "context",
    });
  }
  return items;
}

/**
 * Why a pie has nothing to draw: its window has no complete day yet, every category is negative or
 * empty (the total is still stated), or there is no data.
 */
export function pieEmptyText(block: PieData, ctx: RenderContext): string {
  if (block.empty === "no_complete_day") return "No complete day yet";
  if (isNumber(block.total) && block.excluded !== undefined) return "No positive values to divide";
  const metric = metricOf(ctx, block.metric);
  return `No ${metric.label.replace(/^[A-Z][a-z]/, (s) => s.toLowerCase())} in this period`;
}

/** "Leaves out ..." under the key, when categories were negative, zero or undefined. */
export function pieNote(block: PieData, ctx: RenderContext): string | undefined {
  const excluded = block.excluded;
  if (excluded === undefined) return undefined;
  const metric = metricOf(ctx, block.metric);
  const parts: string[] = [];
  if (excluded.negative.length > 0) {
    const shown = excluded.negative
      .slice(0, 3)
      .map((n) => `${n.label} ${formatValue(n.value, metric, ctx.data.locale, "compact")}`);
    const more = excluded.negative.length - shown.length;
    parts.push(
      `${excluded.negative.length} negative ${excluded.negative.length === 1 ? "value" : "values"} (${shown.join(", ")}${more > 0 ? `, ${more} more` : ""})`,
    );
  }
  if (excluded.empty > 0) parts.push(`${excluded.empty} with no value`);
  return `Leaves out ${parts.join(" and ")}.`;
}

interface KeyLayout {
  rows: { lines: string[]; cut: boolean; y: number; height: number }[];
  total?: { y: number; height: number };
  note: string[];
  height: number;
}

const NAME_STYLE = { size: BODY } as const;
/** Key names wrap rather than shorten; only a name longer than this many lines is cut. */
const NAME_MAX_LINES = 4;
const VALUE_STYLE = { size: BODY, weight: 500 } as const;

function keyLayout(
  block: PieData,
  ctx: RenderContext,
  width: number,
  totalText: string | undefined,
): KeyLayout {
  const metric = metricOf(ctx, block.metric);
  const items = pieItems(block);
  const valueWidth = Math.max(
    0,
    ...items.map((i) =>
      textWidth(formatValue(i.value, metric, ctx.data.locale, "compact"), VALUE_STYLE),
    ),
    totalText === undefined ? 0 : textWidth(totalText, VALUE_STYLE),
  );
  const nameWidth = Math.max(40, width - DOT - 8 - VALUE_GAP - valueWidth - SHARE_WIDTH);
  let y = 0;
  const rows = items.map((item) => {
    const { lines, cut } = wrapLines(item.label, nameWidth, NAME_STYLE, NAME_MAX_LINES);
    const height = Math.max(ROW, lines.length * NAME_LINE + 7);
    const row = { lines, cut, y, height };
    y += height;
    return row;
  });
  const total = totalText === undefined ? undefined : { y, height: ROW };
  if (total) y += ROW;
  const text = pieNote(block, ctx);
  const note = text ? wrapLines(text, width, { size: CAPTION }, 4).lines : [];
  const height = y + (note.length > 0 ? 8 + note.length * LABEL_LINE : 0);
  return { rows, ...(total ? { total } : {}), note, height };
}

function donutTotal(block: PieData, ctx: RenderContext, diameter: number) {
  const text = formatValue(block.total, metricOf(ctx, block.metric), ctx.data.locale, "headline");
  const room = diameter * HOLE - 12;
  const size = textWidth(text, { size: 20 }) <= room ? 20 : 16;
  return { text, room, size, inHole: textWidth(text, { size }) <= room };
}

/** Where the pie and its key go at a width: the key beside the pie, or under it on narrow cards. */
function geometry(
  block: PieData,
  ctx: RenderContext,
  width: number,
  plotHeight: number,
  cap: number,
) {
  const side = width >= PIE_SIDE_KEY_MIN;
  const diameter = Math.min(cap, plotHeight - 24, Math.floor(width * (side ? 0.42 : 0.7)));
  const keyX = side ? diameter + KEY_GAP : 0;
  const keyWidth = side ? width - keyX : width;
  const empty = pieItems(block).length === 0 || block.whole === 0;
  const total =
    block.type === "donut" && (!empty || isNumber(block.total))
      ? donutTotal(block, ctx, diameter)
      : undefined;
  const key = keyLayout(block, ctx, keyWidth, total && !total.inHole ? total.text : undefined);
  const pieArea = side ? plotHeight : diameter + 8;
  const height = side ? Math.max(plotHeight, key.height) : pieArea + 16 + key.height;
  const keyY = side ? Math.max(0, (height - key.height) / 2) : pieArea + 16;
  const cy = side ? height / 2 : pieArea / 2;
  const cx = side ? diameter / 2 : width / 2;
  return { side, diameter, keyX, keyY, keyWidth, key, height, cx, cy, total };
}

/** The height a pie card's chart takes at a width: the plot height, or more for a long key. */
export function pieHeight(
  block: PieData,
  ctx: RenderContext,
  width: number,
  chartHeight: number,
  maxDiameter = MAX_DIAMETER,
): number {
  return geometry(block, ctx, width, chartHeight, maxDiameter).height;
}

/** A point on a circle, with angle 0 at the top and clockwise in fractions of a turn. */
function at(cx: number, cy: number, radius: number, turn: number): [number, number] {
  const a = turn * 2 * Math.PI;
  return [cx + radius * Math.sin(a), cy - radius * Math.cos(a)];
}

/** An annular sector from turn a0 to a1; a full turn is drawn as two halves. */
export function slicePath(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  a0: number,
  a1: number,
): string {
  if (a1 - a0 >= 1 - 1e-9) {
    return slicePath(cx, cy, inner, outer, 0, 0.5) + slicePath(cx, cy, inner, outer, 0.5, 1);
  }
  const large = a1 - a0 > 0.5 ? 1 : 0;
  const [x0, y0] = at(cx, cy, outer, a0);
  const [x1, y1] = at(cx, cy, outer, a1);
  if (inner <= 0) {
    return `M${r(cx)},${r(cy)}L${r(x0)},${r(y0)}A${r(outer)},${r(outer)} 0 ${large} 1 ${r(x1)},${r(y1)}Z`;
  }
  const [x2, y2] = at(cx, cy, inner, a1);
  const [x3, y3] = at(cx, cy, inner, a0);
  return `M${r(x0)},${r(y0)}A${r(outer)},${r(outer)} 0 ${large} 1 ${r(x1)},${r(y1)}L${r(x2)},${r(y2)}A${r(inner)},${r(inner)} 0 ${large} 0 ${r(x3)},${r(y3)}Z`;
}

/** Cumulative end of each slice as a fraction of a turn, for drawing and the runtime's hit test. */
export function pieCuts(block: PieData): number[] {
  let sum = 0;
  return pieItems(block).map((item) => {
    sum += item.share;
    return Math.min(1, sum);
  });
}

/**
 * A pie or donut with its key: slices from 12 o'clock clockwise, largest first and Other last in
 * the neutral context colour, separated by 1 px card-coloured lines. The key lists every slice's
 * name, value and share, beside the pie (under it on narrow cards); a donut states the total in its
 * hole. The plot keeps its height; a long key makes the chart taller.
 */
export function renderPie(
  block: PieData,
  ctx: RenderContext,
  size: ChartSize,
  standalone?: { font: string; background: string },
  maxDiameter = MAX_DIAMETER,
): string {
  const { paint, data } = ctx;
  const locale = data.locale;
  const metric = metricOf(ctx, block.metric);
  const g = geometry(block, ctx, size.width, size.height, maxDiameter);
  const outer = g.diameter / 2;
  const inner = block.type === "donut" ? outer * HOLE : 0;
  const items = pieItems(block);
  const cuts = pieCuts(block);
  const parts: string[] = [];
  const empty = items.length === 0 || block.whole === 0;

  if (empty) {
    const withTotal = isNumber(block.total) && (g.total === undefined || g.total.inHole);
    parts.push(
      `<path d="${slicePath(g.cx, g.cy, block.type === "donut" ? inner : outer - 1, outer, 0, 1)}"${paint.attrs("grid")}/>`,
      ...(withTotal
        ? [
            svgText(
              paint,
              g.cx,
              g.cy - 10,
              g.total?.text ?? formatValue(block.total, metric, locale, "headline"),
              {
                size: g.total?.size ?? 20,
                anchor: "middle",
                color: "text",
                lang: locale,
              },
            ),
          ]
        : []),
      svgText(paint, g.cx, withTotal ? g.cy + 12 : g.cy, pieEmptyText(block, ctx), {
        size: isNumber(block.total) ? CAPTION : BODY,
        anchor: "middle",
        color: "textMuted",
      }),
    );
  } else {
    items.forEach((item, k) => {
      const a0 = k === 0 ? 0 : (cuts[k - 1] as number);
      const a1 = cuts[k] as number;
      parts.push(
        `<path d="${slicePath(g.cx, g.cy, inner, outer, a0, a1)}"${paint.attrs(item.color, items.length > 1 ? "card" : undefined, "hm-slice")}${items.length > 1 ? ' stroke-width="1" stroke-linejoin="round"' : ""}/>`,
      );
    });
  }

  if (g.total && !empty) {
    const label = truncateEnd(metric.label, g.total.room, { size: CAPTION });
    if (g.total.inHole) {
      parts.push(
        svgText(paint, g.cx, g.cy - 6, g.total.text, {
          size: g.total.size,
          anchor: "middle",
          color: isNumber(block.total) ? "text" : "textSubtle",
          lang: locale,
        }),
      );
    }
    parts.push(
      svgText(paint, g.cx, g.total.inHole ? g.cy + 14 : g.cy, label, {
        size: CAPTION,
        anchor: "middle",
        color: "textMuted",
        ...(label === metric.label ? {} : { title: metric.label }),
      }),
    );
  }

  const valueRight = g.keyX + g.keyWidth - SHARE_WIDTH;
  items.forEach((item, k) => {
    const row = g.key.rows[k];
    if (!row) return;
    const cy = g.keyY + row.y + row.height / 2;
    parts.push(
      `<circle cx="${r(g.keyX + DOT / 2)}" cy="${r(cy)}" r="${DOT / 2}"${paint.attrs(item.color)}/>`,
    );
    row.lines.forEach((line, j) => {
      parts.push(
        svgText(paint, g.keyX + DOT + 8, cy + (j - (row.lines.length - 1) / 2) * NAME_LINE, line, {
          ...NAME_STYLE,
          color: "textMuted",
          ...(row.cut ? { title: item.label } : {}),
        }),
      );
    });
    parts.push(
      svgText(paint, valueRight, cy, formatValue(item.value, metric, locale, "compact"), {
        ...VALUE_STYLE,
        anchor: "end",
        color: "text",
        lang: locale,
      }),
      svgText(paint, g.keyX + g.keyWidth, cy, formatValue(item.share, SHARE, locale, "full"), {
        size: CAPTION,
        anchor: "end",
        color: "textMuted",
        lang: locale,
      }),
    );
  });
  const total = g.key.total;
  if (total && g.total) {
    const cy = g.keyY + total.y + total.height / 2;
    parts.push(
      svgText(paint, g.keyX + DOT + 8, cy, "Total", { ...NAME_STYLE, color: "text" }),
      svgText(paint, valueRight, cy, g.total.text, {
        ...VALUE_STYLE,
        anchor: "end",
        color: isNumber(block.total) ? "text" : "textSubtle",
        lang: locale,
      }),
    );
  }
  const last = total ?? g.key.rows.at(-1);
  const noteTop = g.keyY + (last?.y ?? 0) + (last?.height ?? 0) + 8;
  g.key.note.forEach((line, j) => {
    parts.push(
      svgText(paint, g.keyX, noteTop + j * LABEL_LINE + LABEL_LINE / 2, line, {
        size: CAPTION,
        color: "textSubtle",
      }),
    );
  });

  return svgRoot(
    { width: size.width, height: g.height },
    block.title ?? `${metric.label} by ${block.column.replaceAll("_", " ")}`,
    {
      kind: "pie",
      pie: `${r(g.cx)},${r(g.cy)},${r(inner)},${r(outer)}`,
      plot: `${r(g.cx - outer)},${r(g.cy - outer)},${r(g.cx + outer)},${r(g.cy + outer)}`,
    },
    parts.join(""),
    standalone,
  );
}

/** The value of a pie item, for describe and the runtime. */
export function pieValues(block: PieData): Value[] {
  return pieItems(block).map((i) => i.value);
}

/** Whether a chart block is a pie or a donut. */
export function isPie<T extends { type: string }>(block: T | PieData): block is PieData {
  return block.type === "pie" || block.type === "donut";
}
