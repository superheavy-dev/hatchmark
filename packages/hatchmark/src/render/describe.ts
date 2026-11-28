import type { BarData, LineData, PieData, ScatterData, Value } from "../compiler/dashboard-data.js";
import { barCategories } from "./bar.js";
import {
  groupHeading,
  isNumber,
  lowerFirst,
  metricOf,
  type RenderContext,
  SHARE,
  seriesName,
} from "./chart.js";
import { formatBucket, formatSpan, formatValue } from "./format.js";
import { plottedValues, readoutHead, readoutValue } from "./line.js";
import { bucketLines, bucketName, partialPositions } from "./partial.js";
import { isPie, pieCuts, pieEmptyText, pieItems, pieNote } from "./pie.js";
import { scatterOrder, scatterPoints } from "./scatter.js";
import { esc, langAttr } from "./svg.js";
import { type SeriesPaint, seriesPaints } from "./theme.js";

type ChartBlock = LineData | BarData;

/** A scatter block's metrics in display order: x, y, then size when set. */
function scatterMetrics(block: ScatterData): string[] {
  return [block.x, block.y, ...(block.size === undefined ? [] : [block.size])];
}

function describeScatter(block: ScatterData, ctx: RenderContext): string {
  const points = scatterPoints(block);
  const label = (m: string) => metricOf(ctx, m).label;
  const column = block.column.replaceAll("_", " ");
  const count = `${points.length} ${points.length === 1 ? "point" : "points"}`;
  const sized = block.size === undefined ? "" : `, sized by ${lowerFirst(label(block.size))}`;
  const parts = [
    `Scatter plot of ${label(block.y)} against ${label(block.x)} by ${column}${sized}, ${count}.`,
  ];
  if (points.length === 0) return `${parts[0]} No data in this period.`;
  for (const axis of ["y", "x"] as const) {
    const metric = axis === "y" ? block.y : block.x;
    const max = points.reduce((a, b) => (b[axis] > a[axis] ? b : a));
    const min = points.reduce((a, b) => (b[axis] < a[axis] ? b : a));
    parts.push(
      `Highest ${lowerFirst(label(metric))} ${max.label} at ${full(ctx, metric, max[axis])}, lowest ${min.label} at ${full(ctx, metric, min[axis])}.`,
    );
  }
  if (block.omittedPoints) {
    parts.push(`${block.omittedPoints} more without a value are not shown.`);
  }
  return parts.join(" ");
}

function scatterTable(block: ScatterData, ctx: RenderContext, caption: string): string {
  const metrics = scatterMetrics(block);
  const head = `<tr><th scope="col">${esc(block.column.replaceAll("_", " "))}</th>${metrics.map((m) => `<th scope="col">${esc(metricOf(ctx, m).label)}</th>`).join("")}</tr>`;
  const rows = block.points
    .map((p) => {
      const values = [p.x, p.y, ...(block.size === undefined ? [] : [p.size ?? null])];
      return `<tr><th scope="row">${esc(p.label)}</th>${values.map((v, k) => `<td${langAttr(ctx.data.locale)}>${esc(full(ctx, metrics[k] as string, v))}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<div class="hm-sr"><table><caption>${esc(caption)}</caption><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function scatterRuntimeData(block: ScatterData, ctx: RenderContext): ChartRuntimeData {
  const points = scatterPoints(block);
  const ordered = scatterOrder(block).map((i) => points[i] as (typeof points)[number]);
  const locale = ctx.data.locale;
  return {
    kind: "scatter",
    swatch: "square",
    headers: ordered.map((p) => p.label),
    series: scatterMetrics(block).map((m, k) => {
      const v = ordered.map((p) => (k === 0 ? p.x : k === 1 ? p.y : (p.size ?? null)));
      return {
        label: metricOf(ctx, m).label,
        color: 1,
        v,
        text: v.map((value) => full(ctx, m, value)),
        short: v.map((value) => formatValue(value, metricOf(ctx, m), locale, "compact")),
      };
    }),
  };
}

function positions(block: ChartBlock, ctx: RenderContext): string[] {
  if (block.axis.kind !== "time") return barCategories(block as BarData, ctx.data.locale);
  const partial = partialPositions(block, ctx);
  return block.axis.buckets.map((_, i) => bucketName(block, i, ctx, partial));
}

const full = (ctx: RenderContext, metric: string, v: Value | undefined) =>
  formatValue(v ?? null, metricOf(ctx, metric), ctx.data.locale, "full");

/**
 * A generated text alternative for a chart (Datawrapper-style): chart type, what it shows, and per
 * series (up to three) the first and last values and the extremes.
 */
export function describeChart(
  input: ChartBlock | PieData | ScatterData,
  ctx: RenderContext,
): string {
  if (isPie(input)) return describePie(input, ctx);
  if (input.type === "scatter") return describeScatter(input, ctx);
  const block = input;
  const axis = block.axis;
  const names =
    axis.kind === "time"
      ? axis.buckets.map((b) => formatBucket(b, axis.grain, ctx.data.locale))
      : positions(block, ctx);
  const series = block.series;
  const kind =
    block.type === "bar"
      ? `${block.orientation === "horizontal" ? "Horizontal bar" : "Bar"} chart${block.percent ? ", stacked to 100%" : series.length > 1 ? (block.stack ? ", stacked" : ", grouped") : ""}`
      : `${block.type === "area" ? "Area" : "Line"} chart${block.percent ? ", stacked to 100%" : block.stack ? ", stacked" : ""}`;
  const over =
    block.axis.kind === "time"
      ? `by ${block.axis.grain}, ${formatSpan(block.axis.window, ctx.data.locale)}`
      : `by ${block.axis.column.replaceAll("_", " ")}, ${names.length} ${names.length === 1 ? "category" : "categories"}${block.type === "bar" && block.omittedCategories ? ` of ${names.length + block.omittedCategories}` : ""}`;
  const parts = [`${kind} of ${seriesNames(block)} ${over}.`];
  for (const s of series.slice(0, 3)) {
    const defined = s.values.map((v, i) => ({ v, i })).filter((p) => isNumber(p.v)) as {
      v: number;
      i: number;
    }[];
    if (defined.length === 0) {
      parts.push(`${s.label}: no data.`);
      continue;
    }
    const max = defined.reduce((a, b) => (b.v > a.v ? b : a));
    const min = defined.reduce((a, b) => (b.v < a.v ? b : a));
    const first = defined[0] as { v: number; i: number };
    const last = defined[defined.length - 1] as { v: number; i: number };
    const prefix = series.length > 1 ? `${s.label}: ` : "";
    parts.push(
      block.axis.kind === "time"
        ? `${prefix}from ${full(ctx, s.metric, first.v)} in ${names[first.i]} to ${full(ctx, s.metric, last.v)} in ${names[last.i]}; highest ${full(ctx, s.metric, max.v)} in ${names[max.i]}, lowest ${full(ctx, s.metric, min.v)} in ${names[min.i]}.`
        : `${prefix}highest ${names[max.i]} at ${full(ctx, s.metric, max.v)}, lowest ${names[min.i]} at ${full(ctx, s.metric, min.v)}.`,
    );
  }
  if (series.length > 3) parts.push(`${series.length - 3} more series in the data table.`);
  const partial = partialPositions(block, ctx);
  for (const i of partial.keys()) parts.push(`${bucketLines(block, i, ctx, partial).line}.`);
  return parts.join(" ");
}

/** The series a chart shows, in words: a group reads as its name with its members in brackets. */
function seriesNames(block: ChartBlock): string {
  const names: string[] = [];
  block.series.forEach((s, k) => {
    if (s.group === undefined) {
      names.push(s.label);
      return;
    }
    const heading = groupHeading(block, k);
    if (heading === undefined) return;
    const members = block.series.filter((t) => t.group?.index === s.group?.index);
    names.push(`${heading} (${members.map((t) => t.label).join(", ")})`);
  });
  return names.join(", ");
}

const share = (ctx: RenderContext, v: Value | undefined) =>
  formatValue(v ?? null, SHARE, ctx.data.locale, "full");

/**
 * The chart's numbers as a visually hidden table, so screen readers get every value. Stacked charts
 * add each value's share and a Total column.
 */
export function chartTable(
  input: ChartBlock | PieData | ScatterData,
  ctx: RenderContext,
  caption: string,
): string {
  if (isPie(input)) return pieTable(input, ctx, caption);
  if (input.type === "scatter") return scatterTable(input, ctx, caption);
  const block = input;
  const names = positions(block, ctx);
  const totals = block.totals;
  const metric = block.series[0]?.metric ?? "";
  const partial = partialPositions(block, ctx);
  const lang = langAttr(ctx.data.locale);
  const total = (i: number) => {
    const text = full(ctx, metric, totals?.[i] ?? null);
    const { note } = totalPartial(block, i) ? bucketLines(block, i, ctx, partial) : {};
    return note ? `<td>${esc(`${text} \u00B7 ${note}`)}</td>` : `<td${lang}>${esc(text)}</td>`;
  };
  const cell = (s: ChartBlock["series"][number], i: number) =>
    s.share
      ? `${full(ctx, s.metric, s.values[i])} (${share(ctx, s.share[i])})`
      : full(ctx, s.metric, s.values[i]);
  const corner =
    block.axis.kind === "time" ? "Period" : esc(block.axis.column.replaceAll("_", " "));
  const head = block.groups
    ? groupedHead(block, corner, totals !== undefined)
    : `<tr><th scope="col">${corner}</th>${block.series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join("")}${totals ? '<th scope="col">Total</th>' : ""}</tr>`;
  const rows = names
    .map(
      (name, i) =>
        `<tr><th scope="row">${esc(name)}</th>${block.series.map((s) => `<td${lang}>${esc(cell(s, i))}</td>`).join("")}${totals ? total(i) : ""}</tr>`,
    )
    .join("");
  const cols = block.groups ? groupedCols(block, totals !== undefined) : "";
  return `<div class="hm-sr"><table><caption>${esc(caption)}</caption>${cols}<thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function groupedHead(block: ChartBlock, corner: string, total: boolean): string {
  const top: string[] = [`<th scope="col" rowspan="2">${corner}</th>`];
  const members: string[] = [];
  block.series.forEach((s, k) => {
    if (s.group === undefined) {
      top.push(`<th scope="col" rowspan="2">${esc(s.label)}</th>`);
      return;
    }
    members.push(`<th scope="col">${esc(s.label)}</th>`);
    const heading = groupHeading(block, k);
    if (heading === undefined) return;
    const size = block.series.filter((t) => t.group?.index === s.group?.index).length;
    top.push(`<th scope="colgroup" colspan="${size}">${esc(heading)}</th>`);
  });
  if (total) top.push('<th scope="col" rowspan="2">Total</th>');
  return `<tr>${top.join("")}</tr><tr>${members.join("")}</tr>`;
}

function groupedCols(block: ChartBlock, total: boolean): string {
  const cols = ["<colgroup><col></colgroup>"];
  block.series.forEach((s, k) => {
    if (s.group === undefined) {
      cols.push("<colgroup><col></colgroup>");
      return;
    }
    if (groupHeading(block, k) === undefined) return;
    const size = block.series.filter((t) => t.group?.index === s.group?.index).length;
    cols.push(`<colgroup span="${size}"></colgroup>`);
  });
  if (total) cols.push("<colgroup><col></colgroup>");
  return cols.join("");
}

function totalPartial(block: ChartBlock, i: number): boolean {
  return (
    (block.totals === undefined || isNumber(block.totals[i])) &&
    block.series.some((s) => isNumber(s.values[i]) && (s.partial ?? []).some((p) => p.index === i))
  );
}

/** What the browser runtime needs for tooltips and the readout: labels and formatted values. */
export interface ChartRuntimeData {
  kind: "line" | "bar" | "pie" | "scatter";
  /** The tooltip swatch's shape, matching the mark: a line for lines, a square for filled marks. */
  swatch: "line" | "square";
  /** Pie only: each slice's categorical slot (0 for Other, which is neutral). */
  colors?: number[];
  /** Pie only: each slice's cumulative end as a fraction of a turn from 12 o'clock. */
  cuts?: number[];
  /** Group names; a chart with groups lists its tooltip rows in series order under these. */
  groups?: string[];
  /** scatter: headers name the points from left to right, and series are its metrics' rows. */
  headers: string[];
  series: {
    label: string;
    /** Categorical slot, 1 to 8, or a group colour such as "g1-2" (family 1, step 2). */
    color: number | string;
    /** Index into groups. */
    group?: number;
    /** The label with its group's name, when another series shares the label: for announcements. */
    name?: string;
    /** Raw values, for sorting tooltip rows. */
    v: Value[];
    /** Full-format text per position. */
    text: string[];
    /** Compact text per position, for the pinned readout. */
    short: string[];
    /** Plotted values when they differ from v (stacked areas). */
    y?: Value[];
    /** Share of the position's total, as text, for stacked charts. */
    pct?: string[];
    /** Positions where this flow series is partial: its tooltip row takes the hatched swatch. */
    partial?: number[];
  }[];
  /** Total text per position, for stacked charts. */
  total?: string[];
  /** The pinned readout's first line per position, when it differs from headers. */
  heads?: string[];
  /** The tooltip's second line per position: a partial bucket's status, else "". */
  status?: string[];
  /** A partial Total's status per position (any summed part is partial), else "". */
  totalStatus?: string[];
}

export function chartRuntimeData(
  input: ChartBlock | PieData | ScatterData,
  ctx: RenderContext,
): ChartRuntimeData {
  if (isPie(input)) return pieRuntimeData(input, ctx);
  if (input.type === "scatter") return scatterRuntimeData(input, ctx);
  const block = input;
  const locale = ctx.data.locale;
  const stacked =
    block.percent === true ||
    (block.stack === true && (block.series.length > 1 || block.totals !== undefined));
  const plotted = block.type === "bar" ? undefined : plottedValues(block);
  const metric = metricOf(ctx, block.series[0]?.metric ?? "");
  const partial = partialPositions(block, ctx);
  const lines =
    block.axis.kind === "time"
      ? block.axis.buckets.map((_, i) => bucketLines(block, i, ctx, partial))
      : undefined;
  const paints = seriesPaints(ctx.theme, block.series, block.groups?.length);
  const color = (k: number) => {
    const slot = (paints[k] as SeriesPaint).stroke.slice(1);
    return /^\d+$/.test(slot) ? Number(slot) : slot;
  };
  return {
    kind: block.type === "bar" ? "bar" : "line",
    swatch: block.type === "line" ? "line" : "square",
    headers: lines ? lines.map((l) => l.date) : positions(block, ctx),
    ...(lines && partial.size > 0 ? { status: lines.map((l) => l.status ?? "") } : {}),
    ...(block.groups ? { groups: block.groups.map((g) => g.label) } : {}),
    series: block.series.map((s, k) => ({
      label: s.label,
      color: color(k),
      ...(s.group === undefined ? {} : { group: s.group.index }),
      ...(seriesName(block, k) === s.label ? {} : { name: seriesName(block, k) }),
      v: s.values,
      text: s.values.map((v) => full(ctx, s.metric, v)),
      short:
        block.type === "bar"
          ? s.values.map((v) => formatValue(v, metricOf(ctx, s.metric), locale, "compact"))
          : s.values.map((_, i) => readoutValue(block, k, i, ctx)),
      ...(plotted && stacked ? { y: plotted[k] as Value[] } : {}),
      ...(stacked && s.share ? { pct: s.share.map((v) => share(ctx, v)) } : {}),
      ...(s.partial?.length && ctx.data.metrics[s.metric]?.nature !== "point"
        ? { partial: s.partial.map((p) => p.index) }
        : {}),
    })),
    ...(stacked && block.totals
      ? { total: block.totals.map((v) => full(ctx, block.series[0]?.metric ?? "", v)) }
      : stacked
        ? {
            total: (block.series[0]?.values ?? []).map((_, i) => {
              const vals = block.series.map((s) => s.values[i]).filter(isNumber);
              return vals.length === 0
                ? "\u2014"
                : formatValue(
                    vals.reduce((a, b) => a + b, 0),
                    metric,
                    locale,
                    "full",
                  );
            }),
          }
        : {}),
    ...(block.type !== "bar" && block.stack && block.totals
      ? { heads: block.axis.buckets.map((_, i) => readoutHead(block, i, ctx)) }
      : {}),
    ...(lines && stacked && partial.size > 0
      ? {
          totalStatus: lines.map((l, i) => (totalPartial(block, i) ? (l.status ?? "") : "")),
        }
      : {}),
  };
}

/** A pie or donut in words: what it shows, the total, and every slice's share and value. */
function describePie(block: PieData, ctx: RenderContext): string {
  const metric = metricOf(ctx, block.metric);
  const items = pieItems(block);
  const kind = block.type === "donut" ? "Donut chart" : "Pie chart";
  const by = block.column.replaceAll("_", " ");
  if (items.length === 0 || block.whole === 0) {
    const note = pieNote(block, ctx);
    const total = isNumber(block.total) ? `, total ${full(ctx, block.metric, block.total)}` : "";
    return [
      `${kind} of ${metric.label} by ${by}: ${pieEmptyText(block, ctx).toLowerCase()}${total}.`,
      ...(note ? [note] : []),
    ].join(" ");
  }
  const slices = items
    .map((i) => `${i.label} ${share(ctx, i.share)} (${full(ctx, block.metric, i.value)})`)
    .join(", ");
  const note = pieNote(block, ctx);
  return [
    `${kind} of ${metric.label} by ${by}, ${items.length} ${items.length === 1 ? "slice" : "slices"}, total ${full(ctx, block.metric, block.total)}.`,
    `${slices}.`,
    ...(note ? [note] : []),
  ].join(" ");
}

function pieTable(block: PieData, ctx: RenderContext, caption: string): string {
  const metric = metricOf(ctx, block.metric);
  const lang = langAttr(ctx.data.locale);
  const rows = pieItems(block)
    .map(
      (i) =>
        `<tr><th scope="row">${esc(i.label)}</th><td${lang}>${esc(full(ctx, block.metric, i.value))}</td><td${lang}>${esc(share(ctx, i.share))}</td></tr>`,
    )
    .join("");
  return `<div class="hm-sr"><table><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(block.column.replaceAll("_", " "))}</th><th scope="col">${esc(metric.label)}</th><th scope="col">Share</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th scope="row">Total</th><td${lang}>${esc(full(ctx, block.metric, block.total))}</td><td></td></tr></tfoot></table></div>`;
}

function pieRuntimeData(block: PieData, ctx: RenderContext): ChartRuntimeData {
  const metric = metricOf(ctx, block.metric);
  const items = pieItems(block);
  return {
    kind: "pie",
    swatch: "square",
    headers: items.map((i) => i.label),
    colors: items.map((i) => (i.color === "context" ? 0 : Number(i.color.slice(1)))),
    cuts: pieCuts(block),
    series: [
      {
        label: metric.label,
        color: 1,
        v: items.map((i) => i.value),
        text: items.map((i) => full(ctx, block.metric, i.value)),
        short: items.map((i) => formatValue(i.value, metric, ctx.data.locale, "compact")),
        pct: items.map((i) => share(ctx, i.share)),
      },
    ],
  };
}
