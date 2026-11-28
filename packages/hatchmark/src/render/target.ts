import type {
  BarData,
  KpiTarget,
  LineData,
  MetricInfo,
  TargetHidden,
  Value,
} from "../compiler/dashboard-data.js";
import { CAPTION, isNumber, LABEL_LINE, type RenderContext, SHARE } from "./chart.js";
import { formatValue } from "./format.js";
import { textWidth, truncateEnd } from "./measure.js";
import { r, svgText } from "./svg.js";

/** A target drawn along a chart's axis: one value per position, null where there is none. */
export interface TargetTrack {
  label: string;
  /** The series the track belongs to, or undefined for the total over every split value. */
  series?: number;
  values: Value[];
  pace?: Value[];
  /** The values the track is compared with, for attainment: the series' or the stack total. */
  actual: Value[];
  /** Whether the chart draws the track; a total on an unstacked split chart is only listed. */
  drawn: boolean;
}

export interface ChartTargets {
  label: string;
  metric: MetricInfo;
  hidden?: TargetHidden;
  tracks: TargetTrack[];
  window?: { value: Value; pace?: number; actual: Value };
}

const HIDDEN: Record<TargetHidden, { state: string; reason: string }> = {
  filter: { state: "hidden", reason: "a filter is on that the target can't follow" },
  segment: { state: "hidden", reason: "a segment is on that the target can't follow" },
  grain: { state: "not shown at this grain", reason: "it would split the target's buckets" },
};

/**
 * Why a target shows no values, in two parts: the label with its state ("Plan hidden") and the
 * reason ("a filter is on that the target can't follow").
 */
export function hiddenParts(label: string, hidden: TargetHidden): { lead: string; reason: string } {
  return { lead: `${label} ${HIDDEN[hidden].state}`, reason: HIDDEN[hidden].reason };
}

/** Why a target shows no values, after its label: "Plan hidden: a filter is on …". */
export function hiddenText(label: string, hidden: TargetHidden): string {
  const { lead, reason } = hiddenParts(label, hidden);
  return `${lead}: ${reason}`;
}

function stackTotals(block: LineData | BarData): Value[] {
  if (block.totals) return block.totals;
  const n = block.series[0]?.values.length ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const vals = block.series.map((s) => s.values[i]).filter(isNumber);
    return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
  });
}

/**
 * The targets a chart shows (RFC 0001 section 7): a track on each series that carries one (drawn
 * unless the chart stacks), the total over every split value (drawn only where the chart shows a
 * total: a stacked area or bar), and the window target of a category bar whose target has no by
 * column. Nothing is drawn on a chart stacked to 100%, whose axis is a share.
 */
export function chartTargets(
  block: LineData | BarData,
  ctx: RenderContext,
): ChartTargets | undefined {
  const target = block.target;
  if (target === undefined) return undefined;
  const metric: MetricInfo = ctx.data.metrics[target.metric] ?? {
    name: target.metric,
    label: target.metric,
    format: { type: "number" },
    better: "neutral",
  };
  const head = { label: target.label, metric };
  if (target.hidden !== undefined) return { ...head, hidden: target.hidden, tracks: [] };
  const stacked =
    block.type === "area" ? block.stack === true : block.stack === true && block.series.length > 1;
  const own = block.series
    .map((s, k) => ({ s, k }))
    .filter(({ s }) => s.target !== undefined && s.metric === target.metric);
  const tracks: TargetTrack[] = own.map(({ s, k }) => ({
    label: own.length > 1 ? `${s.label} ${target.label}` : target.label,
    series: k,
    values: s.target?.values ?? [],
    ...(s.target?.pace ? { pace: s.target.pace } : {}),
    actual: s.values,
    drawn: block.percent !== true && !stacked,
  }));
  if (target.values) {
    tracks.push({
      label: own.length > 0 ? `Total ${target.label}` : target.label,
      values: target.values,
      ...(target.pace ? { pace: target.pace } : {}),
      actual: stackTotals(block),
      drawn: stacked && block.percent !== true,
    });
  }
  if (target.window === undefined) return { ...head, tracks };
  const actual = stackTotals(block).reduce<Value>(
    (sum, v) => (isNumber(v) ? (sum ?? 0) + v : sum),
    null,
  );
  return {
    ...head,
    tracks,
    window: {
      value: target.window.value,
      ...(target.window.pace === undefined ? {} : { pace: target.window.pace }),
      actual,
    },
  };
}

/** The values a chart's value axis must hold so every drawn target fits. */
export function targetExtent(targets: ChartTargets | undefined): number[] {
  if (targets === undefined) return [];
  const drawn = targets.tracks.filter((t) => t.drawn);
  const window = targets.window ? [targets.window.value, targets.window.pace ?? null] : [];
  return [...drawn.flatMap((t) => [...t.values, ...(t.pace ?? [])]), ...window].filter(isNumber);
}

/** value / target, null unless both are numbers and the target is above zero. */
export function attainment(value: Value | undefined, target: Value | undefined): Value {
  if (!isNumber(value) || !isNumber(target) || target <= 0) return null;
  return value / target;
}

export function percentText(share: number, locale: string): string {
  return formatValue(share, { format: { ...SHARE.format, decimals: 0 } }, locale, "full");
}

/** A hollow diamond: the pace a partial bucket is compared with. */
export function paceMarker(ctx: RenderContext, x: number, y: number): string {
  const h = ctx.theme.target.pace.size / 2;
  return `<path d="M${r(x)},${r(y - h)}L${r(x + h)},${r(y)}L${r(x)},${r(y + h)}L${r(x - h)},${r(y)}Z"${ctx.paint.attrs("card", ctx.theme.target.line.color)} stroke-width="${ctx.theme.target.pace.ring}"/>`;
}

export function targetDash(ctx: RenderContext): string {
  const line = ctx.theme.target.line;
  return ` stroke-width="${line.width}" stroke-dasharray="${line.dash}"`;
}

/**
 * The key row above a chart that names its target: a dashed swatch (or a tick for bars) and the
 * target's label, the pace marker when a position has a pace, or why a hidden target shows nothing.
 */
export function targetKey(
  ctx: RenderContext,
  targets: ChartTargets,
  width: number,
  marker: "line" | "tick",
): { svg: string; height: number } {
  const { paint } = ctx;
  const style = { size: CAPTION } as const;
  const cy = LABEL_LINE / 2;
  if (targets.hidden !== undefined) {
    const full = hiddenText(targets.label, targets.hidden);
    const text = truncateEnd(full, width, style);
    return {
      svg: `<g class="hm-tkey">${svgText(paint, 0, cy, text, { ...style, color: "textSubtle", ...(text === full ? {} : { title: full }) })}</g>`,
      height: LABEL_LINE + 8,
    };
  }
  const shown = targets.tracks.filter((t) => t.drawn);
  if (shown.length === 0 && targets.window === undefined) return { svg: "", height: 0 };
  const tick = ctx.theme.target.tick;
  const swatch =
    marker === "tick" && targets.window === undefined
      ? `<line x1="0" y1="${r(cy)}" x2="14" y2="${r(cy)}"${paint.attrs(undefined, tick.color)} stroke-width="${tick.width}"/>`
      : `<line x1="0" y1="${r(cy)}" x2="14" y2="${r(cy)}"${paint.attrs(undefined, ctx.theme.target.line.color)}${targetDash(ctx)}/>`;
  const label = targets.window ? `${targets.label} for the period` : targets.label;
  const name = truncateEnd(label, width - 20, style);
  const parts = [
    swatch,
    svgText(paint, 20, cy, name, {
      ...style,
      color: "textMuted",
      ...(name === label ? {} : { title: label }),
    }),
  ];
  const paced = shown.some((t) => t.pace?.some(isNumber)) || isNumber(targets.window?.pace ?? null);
  const after = 20 + textWidth(name, style) + 16;
  if (paced && after + 14 + textWidth("Pace to date", style) <= width) {
    parts.push(
      paceMarker(ctx, after + 4, cy),
      svgText(paint, after + 14, cy, "Pace to date", { ...style, color: "textMuted" }),
    );
  }
  return { svg: `<g class="hm-tkey">${parts.join("")}</g>`, height: LABEL_LINE + 8 };
}

export interface TargetRuntime {
  label: string;
  text: string[];
  pace?: string[];
  att?: string[];
}

/** Tooltip rows for a chart's targets: the target, its pace and the attainment at each position. */
export function targetRuntime(
  targets: ChartTargets | undefined,
  positions: number,
  ctx: RenderContext,
): TargetRuntime[] | undefined {
  if (targets === undefined || targets.hidden !== undefined) return undefined;
  const locale = ctx.data.locale;
  const value = (v: Value | undefined) =>
    isNumber(v) ? formatValue(v, targets.metric, locale, "full") : "";
  const each = <T>(f: (i: number) => T) => Array.from({ length: positions }, (_, i) => f(i));
  const share = (a: Value) => (isNumber(a) ? percentText(a, locale) : "");
  const rows: TargetRuntime[] = targets.tracks.map((t) => ({
    label: t.label,
    text: each((i) => value(t.values[i])),
    ...(t.pace?.some(isNumber) ? { pace: each((i) => value(t.pace?.[i])) } : {}),
    att: each((i) =>
      share(attainment(t.actual[i], isNumber(t.pace?.[i]) ? t.pace?.[i] : t.values[i])),
    ),
  }));
  const w = targets.window;
  if (w) {
    const a = share(attainment(w.actual, w.pace ?? w.value));
    rows.push({
      label: `${targets.label} for the period`,
      text: each(() => value(w.value)),
      ...(isNumber(w.pace ?? null) ? { pace: each(() => value(w.pace)) } : {}),
      att: each(() => a),
    });
  }
  return rows.some((row) => row.text.some((t) => t !== "")) ? rows : undefined;
}

/** A sentence for a chart's text alternative about its targets, at the last position with one. */
export function describeTargets(
  targets: ChartTargets | undefined,
  names: readonly string[],
  ctx: RenderContext,
): string {
  if (targets === undefined) return "";
  if (targets.hidden !== undefined) return `${hiddenText(targets.label, targets.hidden)}.`;
  const locale = ctx.data.locale;
  const value = (v: Value | undefined) => formatValue(v ?? null, targets.metric, locale, "full");
  const attained = (a: Value) => (isNumber(a) ? `, ${percentText(a, locale)} attained` : "");
  const parts = targets.tracks
    .filter((t) => t.values.some(isNumber))
    .map((t) => {
      const i = t.values.findLastIndex(isNumber);
      const pace = t.pace?.[i];
      const a = attainment(t.actual[i], isNumber(pace) ? pace : t.values[i]);
      return `${t.label} ${value(t.values[i])} in ${names[i] ?? ""}${isNumber(pace) ? `, pace ${value(pace)}` : ""}${attained(a)}`;
    });
  const w = targets.window;
  if (w && isNumber(w.value)) {
    const a = attainment(w.actual, w.pace ?? w.value);
    parts.push(
      `${targets.label} for the period ${value(w.value)}${isNumber(w.pace ?? null) ? `, pace ${value(w.pace)}` : ""}${attained(a)}`,
    );
  }
  return parts.length > 0 ? `${parts.join("; ")}.` : `${targets.label}: no target in this period.`;
}

/** A KPI's attainment judged by the metric's better direction; undefined without attainment. */
export function kpiJudgement(
  target: KpiTarget,
  better: MetricInfo["better"],
): "ahead" | "behind" | "neutral" | undefined {
  if (!isNumber(target.attainment)) return undefined;
  if (better === "neutral") return "neutral";
  return (better === "up") === target.attainment >= 1 ? "ahead" : "behind";
}
