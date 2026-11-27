import type { BarData, LineData, Value } from "../compiler/dashboard-data.js";
import { barCategories } from "./bar.js";
import { isNumber, metricOf, type RenderContext } from "./chart.js";
import { formatBucket, formatSpan, formatValue } from "./format.js";
import { plottedValues } from "./line.js";
import { esc } from "./svg.js";

type ChartBlock = LineData | BarData;

function positions(block: ChartBlock, ctx: RenderContext): string[] {
  return block.type === "bar"
    ? barCategories(block, ctx.data.locale)
    : block.axis.buckets.map((b) => formatBucket(b, block.axis.grain, ctx.data.locale));
}

const full = (ctx: RenderContext, metric: string, v: Value | undefined) =>
  formatValue(v ?? null, metricOf(ctx, metric), ctx.data.locale, "full");

/**
 * A generated text alternative for a chart (Datawrapper-style): chart type, what it shows, and per
 * series (up to three) the first and last values and the extremes.
 */
export function describeChart(block: ChartBlock, ctx: RenderContext): string {
  const names = positions(block, ctx);
  const series = block.series;
  const kind =
    block.type === "bar"
      ? `${block.orientation === "horizontal" ? "Horizontal bar" : "Bar"} chart${series.length > 1 ? (block.stack ? ", stacked" : ", grouped") : ""}`
      : `${block.type === "area" ? "Area" : "Line"} chart${block.stack ? ", stacked" : ""}`;
  const over =
    block.axis.kind === "time"
      ? `by ${block.axis.grain}, ${formatSpan(block.axis.window, ctx.data.locale)}`
      : `by ${block.axis.column.replaceAll("_", " ")}, ${names.length} ${names.length === 1 ? "category" : "categories"}${block.type === "bar" && block.omittedCategories ? ` of ${names.length + block.omittedCategories}` : ""}`;
  const parts = [`${kind} of ${series.map((s) => s.label).join(", ")} ${over}.`];
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
  return parts.join(" ");
}

/** The chart's numbers as a visually hidden table, so screen readers get every value. */
export function chartTable(block: ChartBlock, ctx: RenderContext, caption: string): string {
  const names = positions(block, ctx);
  const head = `<tr><th scope="col">${block.axis.kind === "time" ? "Period" : esc(block.axis.column.replaceAll("_", " "))}</th>${block.series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join("")}</tr>`;
  const rows = names
    .map(
      (name, i) =>
        `<tr><th scope="row">${esc(name)}</th>${block.series.map((s) => `<td>${esc(full(ctx, s.metric, s.values[i]))}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="hm-sr"><table><caption>${esc(caption)}</caption><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

/** What the browser runtime needs for tooltips and the readout: labels and formatted values. */
export interface ChartRuntimeData {
  kind: "line" | "bar";
  headers: string[];
  series: {
    label: string;
    /** Categorical slot, 1 to 8. */
    color: number;
    /** Raw values, for sorting tooltip rows. */
    v: Value[];
    /** Full-format text per position. */
    text: string[];
    /** Compact text per position, for the pinned readout. */
    short: string[];
    /** Plotted values when they differ from v (stacked areas). */
    y?: Value[];
  }[];
  /** Total text per position, for stacked charts. */
  total?: string[];
}

export function chartRuntimeData(block: ChartBlock, ctx: RenderContext): ChartRuntimeData {
  const locale = ctx.data.locale;
  const stacked = block.stack === true && block.series.length > 1;
  const plotted = block.type === "bar" ? undefined : plottedValues(block);
  const metric = metricOf(ctx, block.series[0]?.metric ?? "");
  return {
    kind: block.type === "bar" ? "bar" : "line",
    headers: positions(block, ctx),
    series: block.series.map((s, k) => ({
      label: s.label,
      color: (k % 8) + 1,
      v: s.values,
      text: s.values.map((v) => full(ctx, s.metric, v)),
      short: s.values.map((v) => formatValue(v, metricOf(ctx, s.metric), locale, "compact")),
      ...(plotted && stacked ? { y: plotted[k] as Value[] } : {}),
    })),
    ...(stacked
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
  };
}
