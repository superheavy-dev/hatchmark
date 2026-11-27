import { scaleLinear } from "d3-scale";
import type { TimeAxis } from "../compiler/dashboard-data.js";
import { formatBucketTick, formatDay, parseDate } from "./format.js";
import { type TickCandidate, thinTicks } from "./labels.js";
import { textWidth } from "./measure.js";

export const TICK_STYLE = { size: 12 } as const;
const MIN_LABEL_GAP = 8;

/**
 * A nice linear domain that always includes zero, with 3 to 6 ticks: one per 48 px of plot
 * height, as the Default theme's axis tokens ask. An all-zero or empty domain becomes [0, 1].
 */
export function yTicks(
  values: readonly number[],
  plotHeight: number,
): { domain: [number, number]; ticks: number[] } {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max = 1;
  if (!Number.isFinite(min) || !Number.isFinite(max)) [min, max] = [0, 1];
  const wanted = Math.max(3, Math.min(6, Math.floor(plotHeight / 48)));
  const half = Number.isFinite(max - min) ? 1 : 2;
  let best: { domain: [number, number]; ticks: number[] } | undefined;
  for (const count of [wanted, wanted - 1, wanted + 1, wanted - 2, wanted + 2, 3, 4, 5, 6]) {
    if (count < 2) continue;
    const scale = scaleLinear()
      .domain([min / half, max / half])
      .nice(count);
    const ticks = scale.ticks(count).map((t) => t * half);
    const domain = scale.domain().map((d) => d * half) as [number, number];
    if (!domain.every(Number.isFinite)) continue;
    const candidate = { domain, ticks };
    if (ticks.length >= 3 && ticks.length <= 6) return candidate;
    if (best === undefined || Math.abs(ticks.length - 4.5) < Math.abs(best.ticks.length - 4.5)) {
      best = candidate;
    }
  }
  return best as { domain: [number, number]; ticks: number[] };
}

export interface AxisLabel {
  index: number;
  x: number;
  text: string;
}

/**
 * Labels for a time axis. Months (or quarters, or years) are the label units: month and coarser
 * grains label buckets, day and week grains label the first bucket of each month. The smallest
 * step that fits is kept, aligned on January, and the year appears on January and on the first
 * label.
 */
export function timeLabels(
  axis: TimeAxis,
  x: (index: number) => number,
  locale: string,
  minX: number,
  maxX: number,
): AxisLabel[] {
  const dates = axis.buckets.map(parseDate);
  const units: { index: number; unit: number }[] = [];
  dates.forEach((date, i) => {
    const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (axis.grain === "day" || axis.grain === "week") {
      const previous = dates[i - 1];
      const starts =
        previous === undefined
          ? date.getUTCDate() <= (axis.grain === "week" ? 7 : 1)
          : previous.getUTCMonth() !== date.getUTCMonth();
      if (starts) units.push({ index: i, unit: month });
    } else if (axis.grain === "quarter") {
      units.push({ index: i, unit: month / 3 });
    } else if (axis.grain === "year") {
      units.push({ index: i, unit: date.getUTCFullYear() });
    } else {
      units.push({ index: i, unit: month });
    }
  });
  const byDay = (axis.grain === "day" || axis.grain === "week") && units.length < 2;
  if (byDay) {
    units.length = 0;
    dates.forEach((_, i) => {
      units.push({ index: i, unit: i });
    });
  }
  const steps = byDay
    ? [1, 2, 7, 14, 28]
    : axis.grain === "year"
      ? [1, 2, 5, 10, 20, 50]
      : axis.grain === "quarter"
        ? [1, 2, 4, 8, 20]
        : [1, 2, 3, 4, 6, 12, 24, 60];
  const text = (k: number, kept: number[]) => {
    const bucket = axis.buckets[units[k]?.index ?? 0] as string;
    return byDay
      ? formatDay(parseDate(bucket), locale, kept[0] === k)
      : formatBucketTick(bucket, axis.grain, locale, kept[0] === k);
  };
  const candidates: TickCandidate[] = units.map((u) => ({
    pos: x(u.index),
    width: 0,
    phase: u.unit,
  }));
  const placed = thinTicks(candidates, steps, MIN_LABEL_GAP, minX, maxX, (k, kept) =>
    textWidth(text(k, kept), TICK_STYLE),
  );
  const kept = placed.map((p) => p.index);
  return placed.map((p) => ({
    index: units[p.index]?.index ?? 0,
    x: p.centre,
    text: text(p.index, kept),
  }));
}
