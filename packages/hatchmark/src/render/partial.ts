import type { BarData, LineData } from "../compiler/dashboard-data.js";
import { isNumber, type RenderContext } from "./chart.js";
import { formatBucket, formatDay, formatRange, parseDate } from "./format.js";
import { r } from "./svg.js";
import type { ColorKey, Paint } from "./theme.js";

type ChartBlock = LineData | BarData;

/** RFC 0001 section 6.6. */
export interface PartialPosition {
  edge?: "start";
  from: string;
  to: string;
  days: number;
  of: number;
  through?: string;
  point: boolean;
  complete: boolean;
}

const DAY_MS = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const plusDays = (date: string, days: number) =>
  iso(new Date(parseDate(date).getTime() + days * DAY_MS));
const MONTHS = { month: 1, quarter: 3, year: 12 } as const;

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
    const covered = ({ p }: (typeof here)[number]) => [p.days ?? 0, p.through ?? "", p.elapsed];
    const least = here.reduce<(typeof here)[number] | undefined>((a, b) => {
      if (a === undefined) return b;
      const [x, y] = [covered(a), covered(b)];
      for (let j = 0; j < x.length; j++) {
        if (y[j] !== x[j]) return (y[j] as number | string) < (x[j] as number | string) ? b : a;
      }
      return a;
    }, undefined);
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
    const days = least.p.days ?? Math.min(of, Math.max(1, Math.ceil(least.p.elapsed * of - 1e-4)));
    const from = least.p.edge === "start" && window.start > bucket ? window.start : bucket;
    out.set(i, {
      ...(least.p.edge ? { edge: least.p.edge } : {}),
      from,
      to: plusDays(from, days),
      days,
      of,
      ...(least.p.through ? { through: least.p.through } : {}),
      point: here.every(({ metric }) => ctx.data.metrics[metric]?.nature === "point"),
      complete: block.series.some(
        (s) => isNumber(s.values[i]) && !(s.partial ?? []).some((p) => p.index === i),
      ),
    });
  }
  return out;
}

function coveredLabel(from: string, to: string, asOf: string, locale: string): string {
  const start = parseDate(from);
  const end = parseDate(plusDays(to, -1));
  const asOfYear = Number(asOf.slice(0, 4));
  const year = start.getUTCFullYear() !== asOfYear || end.getUTCFullYear() !== asOfYear;
  return formatRange(start, end, locale, { day: true, year });
}

export const timeOf = (endAt: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    new Date(`${endAt.slice(0, 19)}Z`),
  );

export function bucketLines(
  block: ChartBlock,
  i: number,
  ctx: RenderContext,
  partial = partialPositions(block, ctx),
): { date: string; status?: string; note?: string; line: string } {
  if (block.axis.kind !== "time") return { date: "", line: "" };
  const { locale, asOf } = ctx.data;
  const { grain } = block.axis;
  const name = formatBucket(block.axis.buckets[i] ?? "", grain, locale);
  const p = partial.get(i);
  if (p === undefined) return { date: name, line: name };
  if (p.point && p.edge === undefined) {
    const when = p.through
      ? `${formatDay(parseDate(p.through.slice(0, 10)), locale)}, ${timeOf(p.through, locale)}`
      : formatDay(parseDate(plusDays(p.to, -1)), locale);
    return {
      date: name,
      status: `As of ${when}`,
      note: `as of ${when}`,
      line: `${name} \u00B7 as of ${when}`,
    };
  }
  const date = p.complete ? name : coveredLabel(p.from, p.to, asOf, locale);
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
    const through = p.through ? `through ${timeOf(p.through, locale)}` : undefined;
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

export function bucketName(
  block: ChartBlock,
  i: number,
  ctx: RenderContext,
  partial = partialPositions(block, ctx),
): string {
  return bucketLines(block, i, ctx, partial).line;
}

export function partialId(block: ChartBlock, width: number): string {
  const first =
    block.axis.kind === "time" ? `${block.axis.grain}-${block.axis.buckets[0] ?? ""}` : "c";
  return `hm-p-${block.id}-${first}-${Math.round(width)}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

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
  const box = `x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"`;
  const hatch =
    length >= theme.partial.barHatchMin
      ? `<rect ${box} fill="url(#${id}-${color})" opacity="${theme.partial.barHatchOpacity}"/>`
      : "";
  const outline =
    w < 2 || h < 2
      ? `<rect ${box}${paint.attrs(color)}/>`
      : `<rect x="${r(x + 0.5)}" y="${r(y + 0.5)}" width="${r(w - 1)}" height="${r(h - 1)}"${paint.attrs("none", color)} stroke-width="1"/>`;
  return `<rect ${box}${paint.attrs(color)} fill-opacity="${theme.partial.barTint}"/>${hatch}${outline}`;
}

export function hollowPoint(ctx: RenderContext, color: ColorKey, x: number, y: number): string {
  const { paint, theme } = ctx;
  return `<circle cx="${r(x)}" cy="${r(y)}" r="${theme.partial.pointRadius}"${paint.attrs("card", color)} stroke-width="${theme.partial.pointRing}"/>`;
}
