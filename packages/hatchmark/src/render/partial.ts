import type { BarData, LineData } from "../compiler/dashboard-data.js";
import type { RenderContext } from "./chart.js";
import { formatBucket, formatDay, parseDate } from "./format.js";
import { r } from "./svg.js";
import type { ColorKey, Paint } from "./theme.js";

type ChartBlock = LineData | BarData;

/** A partial bucket as the renderer reads it (RFC 0001 section 6.6). */
export interface PartialPosition {
  /** "start" for the first bucket of a clipped window; otherwise the data ends inside the bucket. */
  edge?: "start";
  /** The days of the bucket the data covers, as a span (end exclusive), and their count of the bucket's. */
  from: string;
  to: string;
  days: number;
  of: number;
  /** Every series partial here is point-in-time: its value is the state at the horizon, not low. */
  point: boolean;
}

const DAY_MS = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const plusDays = (date: string, days: number) =>
  iso(new Date(parseDate(date).getTime() + days * DAY_MS));
const MONTHS = { month: 1, quarter: 3, year: 12 } as const;

/**
 * The partial buckets of a time-series block by position: the hook line and bar read for the partial
 * treatment, and the source of every text that names a partial bucket (tooltip, readout, data
 * table, description). Where series disagree, the one with the least data elapsed wins.
 */
export function partialPositions(
  block: ChartBlock,
  ctx: RenderContext,
): Map<number, PartialPosition> {
  const out = new Map<number, PartialPosition>();
  if (block.axis.kind !== "time") return out;
  const { buckets, grain, window } = block.axis;
  for (const [i, bucket] of buckets.entries()) {
    const here = block.series.flatMap((s) =>
      (s.partial ?? []).filter((p) => p.index === i).map((p) => ({ p, metric: s.metric })),
    );
    const least = here.reduce<(typeof here)[number] | undefined>(
      (a, b) => (a === undefined || b.p.elapsed < a.p.elapsed ? b : a),
      undefined,
    );
    if (least === undefined) continue;
    const start = parseDate(bucket);
    const end =
      grain === "day" || grain === "week"
        ? new Date(start.getTime() + (grain === "day" ? 1 : 7) * DAY_MS)
        : new Date(
            Date.UTC(
              start.getUTCFullYear(),
              start.getUTCMonth() + MONTHS[grain],
              start.getUTCDate(),
            ),
          );
    const of = Math.round((end.getTime() - start.getTime()) / DAY_MS);
    const days = Math.min(of, Math.max(1, Math.ceil(least.p.elapsed * of - 1e-4)));
    const from = least.p.edge === "start" && window.start > bucket ? window.start : bucket;
    out.set(i, {
      ...(least.p.edge ? { edge: least.p.edge } : {}),
      from,
      to: plusDays(from, days),
      days,
      of,
      point: here.every(({ metric }) => ctx.data.metrics[metric]?.nature === "point"),
    });
  }
  return out;
}

/**
 * The days a partial bucket covers, as the partial wording names them (HAT-29's tokens): "Nov 26",
 * "Nov 1–26", "Oct 30 – Nov 2", "Dec 29, 2025 – Jan 2, 2026"; a one-year label adds its year only
 * when it isn't the dashboard's as-of year.
 */
function coveredLabel(from: string, to: string, asOf: string, locale: string): string {
  const start = parseDate(from);
  const end = parseDate(plusDays(to, -1));
  const year = (d: Date) => d.getUTCFullYear();
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", timeZone: "UTC" });
  if (year(start) !== year(end)) {
    return `${formatDay(start, locale)} \u2013 ${formatDay(end, locale)}`;
  }
  const suffix = year(start) === Number(asOf.slice(0, 4)) ? "" : `, ${year(start)}`;
  if (from === iso(end)) return `${formatDay(start, locale, false)}${suffix}`;
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${formatDay(start, locale, false)}\u2013${day.format(end)}${suffix}`;
  }
  return `${formatDay(start, locale, false)} \u2013 ${formatDay(end, locale, false)}${suffix}`;
}

const timeOf = (endAt: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    new Date(`${endAt.slice(0, 19)}Z`),
  );

/**
 * A bucket as text, from HAT-29's partial wording: the tooltip's two lines (date, and for a partial
 * bucket its status) and the one-line form for the readout, the data table and the description.
 * In progress: "Nov 1–26", "In progress · 26 of 30 days" (day grain: "In progress · through
 * 2:03 PM"); a clipped first bucket: "Aug 29–30", "Partial week · 2 of 7 days". A point-in-time
 * metric keeps the bucket's own name and reads "As of Nov 26, 2:03 PM".
 */
export function bucketLines(
  block: ChartBlock,
  i: number,
  ctx: RenderContext,
  partial = partialPositions(block, ctx),
): { date: string; status?: string; note?: string; line: string } {
  if (block.axis.kind !== "time") return { date: "", line: "" };
  const { locale, asOf } = ctx.data;
  const { grain, window } = block.axis;
  const name = formatBucket(block.axis.buckets[i] ?? "", grain, locale);
  const p = partial.get(i);
  if (p === undefined) return { date: name, line: name };
  if (p.point && p.edge === undefined) {
    const when = window.endAt
      ? `${formatDay(new Date(`${window.endAt.slice(0, 10)}T00:00:00Z`), locale)}, ${timeOf(window.endAt, locale)}`
      : formatDay(parseDate(plusDays(p.to, -1)), locale);
    return {
      date: name,
      status: `As of ${when}`,
      note: `as of ${when}`,
      line: `${name} \u00B7 as of ${when}`,
    };
  }
  const date = coveredLabel(p.from, p.to, asOf, locale);
  const count = `${p.days} of ${p.of} days`;
  if (p.edge === "start") {
    return {
      date,
      status: `Partial ${grain} \u00B7 ${count}`,
      note: `partial ${grain} (${count})`,
      line: `${date} \u00B7 partial ${grain} (${count})`,
    };
  }
  if (grain === "day") {
    const through = window.endAt ? `through ${timeOf(window.endAt, locale)}` : undefined;
    return {
      date,
      status: through ? `In progress \u00B7 ${through}` : "In progress",
      note: through ? `in progress (${through})` : "in progress",
      line: through ? `${date} \u00B7 in progress (${through})` : `${date} \u00B7 in progress`,
    };
  }
  return {
    date,
    status: `In progress \u00B7 ${count}`,
    note: `in progress (${count})`,
    line: `${date} \u00B7 in progress (${count})`,
  };
}

/** The one-line form: the readout, the data table and the description. */
export function bucketName(
  block: ChartBlock,
  i: number,
  ctx: RenderContext,
  partial = partialPositions(block, ctx),
): string {
  return bucketLines(block, i, ctx, partial).line;
}

/** An id for the partial treatment's defs, unique per rendered SVG (grain panels and layouts included). */
export function partialId(block: ChartBlock, width: number): string {
  const first =
    block.axis.kind === "time" ? `${block.axis.grain}-${block.axis.buckets[0] ?? ""}` : "c";
  return `hm-p-${block.id}-${first}-${Math.round(width)}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Hatch patterns, one per colour: 1 px lines at 45° (lower left to upper right), spacing px apart
 * along x + y, anchored at the plot origin so neighbouring hatched shapes line up.
 */
export function hatchDefs(
  paint: Paint,
  id: string,
  colors: ColorKey[],
  spacing: number,
  originX: number,
  originY: number,
  clips: Record<string, [number, number, number, number][]> = {},
): string {
  const s = spacing;
  const patterns = [...new Set(colors)].map(
    (c) =>
      `<pattern id="${id}-${c}" patternUnits="userSpaceOnUse" x="${r(originX)}" y="${r(originY)}" width="${s}" height="${s}"><path d="M0,${s}L${s},0M-1,1L1,-1M${s - 1},${s + 1}L${s + 1},${s - 1}"${paint.attrs("none", c)} stroke-width="1"/></pattern>`,
  );
  const clipPaths = Object.entries(clips).map(
    ([name, rects]) =>
      `<clipPath id="${id}-${name}">${rects.map(([x, y, w, h]) => `<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(0, w))}" height="${r(h)}"/>`).join("")}</clipPath>`,
  );
  return `<defs>${patterns.join("")}${clipPaths.join("")}</defs>`;
}

/** The hatched slot behind a partial bucket on a line or area chart: card-alt ground, subtle hatch. */
export function partialRegion(
  ctx: RenderContext,
  id: string,
  x0: number,
  x1: number,
  top: number,
  bottom: number,
): string {
  const { paint, theme } = ctx;
  const box = `x="${r(x0)}" y="${r(top)}" width="${r(x1 - x0)}" height="${r(bottom - top)}"`;
  const opacity = paint.mode
    ? ` opacity="${theme.partial.regionOpacity[paint.mode]}"`
    : ' class="hm-pr"';
  return `<rect ${box}${paint.attrs("cardAlt")}/><rect ${box} fill="url(#${id}-textSubtle)"${opacity}/>`;
}

/** A bar part in the partial treatment: series tint, series hatch (dropped below barHatchMin), 1 px outline. */
export function partialBar(
  ctx: RenderContext,
  id: string,
  color: ColorKey,
  x: number,
  y: number,
  w: number,
  h: number,
  length: number,
): string {
  const { paint, theme } = ctx;
  const rx = ` rx="${theme.radius.bar}"`;
  const box = `x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"${rx}`;
  const hatch =
    length >= theme.partial.barHatchMin
      ? `<rect ${box} fill="url(#${id}-${color})" opacity="${theme.partial.barHatchOpacity}"/>`
      : "";
  return `<rect ${box}${paint.attrs(color)} fill-opacity="${theme.partial.barTint}"/>${hatch}<rect x="${r(x + 0.5)}" y="${r(y + 0.5)}" width="${r(Math.max(0, w - 1))}" height="${r(Math.max(0, h - 1))}"${rx}${paint.attrs("none", color)} stroke-width="1"/>`;
}

/** The hollow point on a partial bucket's value: card fill, series ring. */
export function hollowPoint(ctx: RenderContext, color: ColorKey, x: number, y: number): string {
  const { paint, theme } = ctx;
  return `<circle cx="${r(x)}" cy="${r(y)}" r="${theme.partial.pointRadius}"${paint.attrs("card", color)} stroke-width="${theme.partial.pointRing}"/>`;
}
