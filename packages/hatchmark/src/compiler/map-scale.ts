import { quantileSorted } from "d3-array";
import { MAP_DEFAULT_CLASSES } from "../spec/units.js";
import type { MapScale } from "./dashboard-data.js";

/** A map block's scale as written: every field optional. */
export interface MapScaleSpec {
  type?: MapScale["type"] | undefined;
  classes?: number | undefined;
  breaks?: number[] | undefined;
  midpoint?: number | undefined;
}

/** The class a value falls in: how many breaks are at or below it. */
export function classOf(value: number, breaks: readonly number[]): number {
  let k = 0;
  while (k < breaks.length && value >= (breaks[k] as number)) k++;
  return k;
}

function quantileBreaks(sorted: number[], classes: number): number[] {
  if (sorted.length === 0) return [];
  return Array.from(
    { length: classes - 1 },
    (_, i) => quantileSorted(sorted, (i + 1) / classes) ?? 0,
  );
}

function equalBreaks(lo: number, hi: number, classes: number): number[] {
  const step = (hi - lo) / classes;
  return Array.from({ length: classes - 1 }, (_, i) => lo + step * (i + 1));
}

/**
 * The breaks of a map scale over the region values. quantile: classes holding about the same
 * number of regions (d3's R-7 quantiles); linear: classes of equal width from the lowest to the
 * highest value; threshold: the breaks as written. With a midpoint, linear classes are symmetric
 * around it (as wide as the farther side needs), and quantile classes split the regions below and
 * above it separately, half the classes each, with the midpoint as the middle break. Breaks that
 * coincide (few distinct values) collapse, so classes may be fewer than the spec asked for.
 */
export function mapScale(values: readonly number[], spec: MapScaleSpec = {}): MapScale {
  const type = spec.type ?? "quantile";
  const classes = spec.breaks ? spec.breaks.length + 1 : (spec.classes ?? MAP_DEFAULT_CLASSES);
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted.at(-1);
  const domain: [number, number] | undefined =
    lo === undefined || hi === undefined ? undefined : [lo, hi];
  const mid = spec.midpoint;
  let breaks: number[];
  if (type === "threshold") {
    breaks = [...(spec.breaks ?? [])];
  } else if (domain === undefined) {
    breaks = [];
  } else if (type === "linear") {
    if (mid === undefined) {
      breaks = domain[0] === domain[1] ? [] : equalBreaks(domain[0], domain[1], classes);
    } else {
      const reach = Math.max(Math.abs(domain[0] - mid), Math.abs(domain[1] - mid));
      breaks = reach === 0 ? [] : equalBreaks(mid - reach, mid + reach, classes);
    }
  } else if (mid === undefined) {
    breaks = quantileBreaks(sorted, classes);
  } else {
    const half = classes / 2;
    const below = sorted.filter((v) => v < mid);
    const above = sorted.filter((v) => v >= mid);
    breaks = [
      ...(below.length > 0 ? quantileBreaks(below, half) : []),
      mid,
      ...(above.length > 0 ? quantileBreaks(above, half) : []),
    ];
  }
  const unique = breaks.filter((b, i) => i === 0 || b > (breaks[i - 1] as number));
  return {
    type,
    classes: unique.length + 1,
    breaks: unique,
    ...(mid === undefined ? {} : { midpoint: mid }),
    ...(domain ? { domain } : {}),
  };
}
