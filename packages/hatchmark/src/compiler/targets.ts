import type { ResolvedGrain } from "../spec/index.js";
import { DAY_US, parseInstant } from "./instants.js";
import { bucketEnd, bucketStart, timeBuckets } from "./windows.js";

/** A target's values by bucket start (YYYY-MM-DD at the target's grain). */
export type TargetBuckets = ReadonlyMap<string, number>;

/**
 * A target's values by bucket start: each date counts for the bucket of the target's grain it falls
 * in, and values that fall in one bucket add up (a table with one row per region and month gives
 * the month's total).
 */
export function targetBuckets(
  rows: Iterable<{ date: string; value: number }>,
  grain: ResolvedGrain,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const { date, value } of rows) {
    const start = bucketStart(date, grain);
    out.set(start, (out.get(start) ?? 0) + value);
  }
  return out;
}

/**
 * The share of a period [start, end) that [from, to) covers, in local wall-clock microseconds: the
 * elapsed share of a partial bucket (RFC 0001 section 6.1), unrounded.
 */
export function elapsedShare(from: bigint, to: bigint, start: bigint, end: bigint): number {
  return Number(to - from) / Number(end - start);
}

const days = (from: string, to: string) => Number((parseInstant(to) - parseInstant(from)) / DAY_US);

/**
 * A flow target over the local dates [start, end) (RFC 0001 section 7). Every target bucket the
 * span overlaps counts: one wholly inside with its value, one partly inside with its value times
 * its days inside over its days. The value is null when the span is empty, when a bucket it
 * overlaps has no value, when it would split a bucket and the target's prorate is "none", or, for a
 * metric that doesn't add up over time, when it is anything but exactly one bucket. prorated is
 * true when a bucket was split.
 */
export function flowTarget(
  values: TargetBuckets,
  target: { grain: ResolvedGrain; additive?: boolean; prorate?: "days" | "none" },
  start: string,
  end: string,
): { value: number | null; prorated: boolean } {
  const none = { value: null, prorated: false };
  if (start >= end) return none;
  const buckets = timeBuckets(start, end, target.grain);
  if (target.additive !== true && buckets.length !== 1) return none;
  let value = 0;
  let prorated = false;
  for (const bucket of buckets) {
    const amount = values.get(bucket);
    if (amount === undefined) return none;
    const stop = bucketEnd(bucket, target.grain);
    const from = bucket > start ? bucket : start;
    const to = stop < end ? stop : end;
    if (from === bucket && to === stop) {
      value += amount;
      continue;
    }
    if (target.additive !== true || target.prorate !== "days") return none;
    value += (amount * days(from, to)) / days(bucket, stop);
    prorated = true;
  }
  return { value, prorated };
}

/**
 * A point-in-time target at a local wall-clock instant (microseconds since 1970-01-01T00:00 local,
 * instants.ts). Each value holds at the end of its bucket; between two of them the target follows
 * the path: "linear" moves by the same amount per microsecond, "compound" by the same factor, which
 * needs both values positive (null otherwise). Null before the first value's instant and after the
 * last one's.
 */
export function pointTarget(
  values: TargetBuckets,
  target: { grain: ResolvedGrain; path?: "linear" | "compound" },
  at: bigint,
): number | null {
  const points = [...values.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([start, value]) => ({ at: parseInstant(bucketEnd(start, target.grain)), value }));
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as { at: bigint; value: number };
    if (at === p.at) return p.value;
    const next = points[i + 1];
    if (next === undefined || at < p.at) return null;
    if (at > next.at) continue;
    const f = Number(at - p.at) / Number(next.at - p.at);
    if (target.path !== "compound") return p.value + (next.value - p.value) * f;
    return p.value > 0 && next.value > 0 ? p.value * (next.value / p.value) ** f : null;
  }
  return null;
}
