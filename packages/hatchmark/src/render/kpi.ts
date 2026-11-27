import type { KpiData, LineData } from "../compiler/dashboard-data.js";
import { fraction, isNumber, metricOf, type RenderContext } from "./chart.js";
import {
  formatBucket,
  formatChange,
  formatPreviousSpan,
  formatSpan,
  formatValue,
} from "./format.js";
import { bucketLines, partialPositions } from "./partial.js";
import { esc, r, scriptJson } from "./svg.js";

/**
 * One KPI cell for a KPI strip: label, headline figure in regular weight, the change with an arrow,
 * a sign and a good or bad colour by the metric's better direction, and a note naming the
 * comparison. null shows as an em dash with a reason; 0 shows as a real zero. A sparkline is a
 * small line chart the runtime drives like any other: crosshair, dot and tooltip on hover, touch and
 * the arrow keys.
 */
export function renderKpi(block: KpiData, ctx: RenderContext): string {
  const locale = ctx.data.locale;
  const metric = metricOf(ctx, block.metric);
  const label = block.title ?? metric.label;
  const value = formatValue(block.value, metric, locale, "headline");
  const kind = block.changeKind ?? (metric.format.type === "percent" ? "points" : "relative");
  const raw = kind === "points" ? (block.changePct ?? block.change) : block.changePct;
  const changeText =
    block.value === null || block.previousValue === undefined || block.previousValue === null
      ? undefined
      : formatChange(raw, kind, locale);
  let delta = "";
  if (changeText !== undefined && isNumber(raw)) {
    const direction = raw > 0 ? "up" : raw < 0 ? "down" : "flat";
    const judged =
      direction === "flat" || metric.better === "neutral"
        ? "neutral"
        : (direction === "up") === (metric.better === "up")
          ? "good"
          : "bad";
    const arrow = direction === "up" ? "\u25B2" : direction === "down" ? "\u25BC" : "";
    const spoken =
      direction === "flat"
        ? "no change"
        : `${direction}${judged === "neutral" ? "" : `, ${judged === "good" ? "better" : "worse"}`}`;
    delta = `<span class="hm-delta hm-${judged}">${arrow ? `<span aria-hidden="true">${arrow}</span>\u2009` : ""}${esc(changeText)}<span class="hm-sr"> (${spoken})</span></span>`;
  }
  const shown = ctx.data.period.current;
  const own =
    block.current !== undefined &&
    shown !== undefined &&
    (block.current.start !== shown.start || block.current.end !== shown.end)
      ? `${formatSpan(block.current, locale)} \u00B7 `
      : "";
  let note: string;
  if (block.presetOnly === true) note = "Pick a preset to see this";
  else if (block.value === null) note = "No data in this period";
  else if (block.previous === undefined || block.previousValue === undefined) {
    note = block.current ? formatSpan(block.current, locale) : "All time";
  } else {
    const span = formatPreviousSpan(block.previous, block.current, locale);
    note =
      block.previousValue === null
        ? `${own}No ${span} data to compare`
        : `${own}vs ${formatValue(block.previousValue, metric, locale, "headline")} in ${span}`;
  }
  if (metric.better === "down") note += " \u00B7 lower is better";
  let spark = "";
  let runtime = "";
  let table = "";
  const values = block.sparkline?.values ?? [];
  const defined = values.filter(isNumber);
  if (defined.length > 1) {
    const lo = Math.min(...defined);
    const hi = Math.max(...defined);
    const x = (i: number) => (i / (values.length - 1)) * 100;
    const y = (v: number) => (hi === lo ? 12 : 22 - fraction(v, lo, hi) * 20);
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (!isNumber(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${r(x(i))},${r(y(v))}`;
      pen = true;
    });
    const sparkline = block.sparkline as NonNullable<KpiData["sparkline"]>;
    const end = values.findLastIndex(isNumber);
    const last = values[end];
    const { pointRadius, pointRing } = ctx.theme.partial;
    const dot = (color: "c1" | "card", width: number) =>
      `<path d="M${r(x(end))},${r(y(last as number))}h0"${ctx.paint.attrs("none", color)} stroke-width="${width}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    const sparkEnd =
      isNumber(last) && sparkline.partial?.some((p) => p.index === end)
        ? dot("c1", 2 * pointRadius + pointRing) + dot("card", 2 * pointRadius - pointRing)
        : "";
    const asLine: LineData = {
      type: "line",
      id: block.id,
      span: block.span,
      axis: {
        kind: "time",
        grain: sparkline.grain,
        buckets: sparkline.buckets,
        window: { start: sparkline.buckets[0] ?? "", end: sparkline.buckets.at(-1) ?? "" },
      },
      series: [
        {
          key: block.metric,
          metric: block.metric,
          label,
          values,
          ...(sparkline.partial ? { partial: sparkline.partial } : {}),
        },
      ],
    };
    const partial = partialPositions(asLine, ctx);
    const lines = sparkline.buckets.map((_, i) => bucketLines(asLine, i, ctx, partial));
    const headers = lines.map((l) => l.date);
    const named = sparkline.buckets.map((b) => formatBucket(b, sparkline.grain, locale));
    const partialLine = [...partial.keys()].map((i) => lines[i]?.line).at(-1);
    const text = values.map((v) => formatValue(v, metric, locale, "full"));
    table = `<div class="hm-sr"><table><caption>${esc(`${label} by ${sparkline.grain}`)}</caption><thead><tr><th scope="col">Period</th><th scope="col">${esc(label)}</th></tr></thead><tbody>${lines.map((l, i) => `<tr><th scope="row">${esc(l.line)}</th><td>${esc(text[i] as string)}</td></tr>`).join("")}</tbody></table></div>`;
    const geometry = `data-hm-kind="line" data-hm-x="0,100,${values.length}" data-hm-y="${hi === lo ? `${lo},${lo + 1},12,12` : `${lo},${hi},22,2`}" data-hm-plot="0,0,100,24"`;
    spark = `<svg class="hm-spark" viewBox="0 0 100 24" preserveAspectRatio="none" overflow="visible" tabindex="0" role="img" aria-label="${esc(`${label} by ${sparkline.grain}, ${named[0]} to ${named.at(-1)}${partialLine ? `; ${partialLine}` : ""}`)}" ${geometry}><path d="${d}"${ctx.paint.attrs("none", "c1")} stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>${sparkEnd}</svg>`;
    runtime = `<script type="application/json">${scriptJson({
      kind: "line",
      headers,
      ...(partial.size > 0 ? { status: lines.map((l) => l.status ?? "") } : {}),
      series: [
        {
          label,
          color: 1,
          v: values,
          text,
          short: values.map((v) => formatValue(v, metric, locale, "compact")),
        },
      ],
    })}</script>`;
  }
  return [
    `<div class="hm-kpi" style="--span:${block.span}"${runtime ? ` data-hm-chart="${esc(block.id)}"` : ""}>`,
    runtime,
    `<div class="hm-kpi-label">${esc(label)}</div>`,
    `<div class="hm-kpi-figure"><span class="hm-kpi-value${block.value === null ? " hm-null" : ""}">${esc(value)}</span>${delta}</div>`,
    `<div class="hm-kpi-note">${esc(note)}</div>`,
    spark,
    table,
    "</div>",
  ].join("");
}
