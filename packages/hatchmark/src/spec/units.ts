import type { Anchors, Grain, RangeSpec, ResolvedGrain, TimeGrain, Weekday } from "./common.js";
import type { Block } from "./dashboard.js";

/**
 * Spec constants and helpers without the schemas, so code that runs in the browser (assembly and
 * windows, for the period engine) can import them without the validation library.
 */

/** Most series one group holds: the lightness steps of a hue family in the Default theme. */
export const GROUP_MAX_SIZE = 3;
/** Most groups one chart holds: the hue families of the Default theme that host a group. */
export const GROUP_MAX_COUNT = 3;

export const TIME_GRAINS = ["day", "week", "month", "quarter", "year"] as const;

export const PERIOD_RANGES = [
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_12_months",
  "month_to_date",
  "quarter_to_date",
  "year_to_date",
  "last_complete_month",
  "last_complete_quarter",
  "last_complete_year",
  "all_time",
] as const;

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/** The unit of a grain as written. */
export function grainUnit(grain: Grain): TimeGrain {
  return typeof grain === "string" ? grain : grain.unit;
}

/** A grain with the anchor a bucket uses: its own, else the project's. */
export function resolveGrain(grain: Grain, anchors: Anchors): ResolvedGrain {
  const unit = grainUnit(grain);
  const own = typeof grain === "string" ? undefined : grain.anchor;
  if (unit === "day" || unit === "month") return { unit };
  if (unit === "week") return { unit, anchor: (own as Weekday | undefined) ?? anchors.week };
  return { unit, anchor: own ?? anchors[unit] };
}

/** A grain as one string, such as "month" or "week:sunday". Resolved grains with the same buckets share a key. */
export function grainKey(grain: Grain): string {
  const anchor = typeof grain === "string" ? undefined : grain.anchor;
  return anchor === undefined ? grainUnit(grain) : `${grainUnit(grain)}:${anchor}`;
}

/** The id a block is addressed by: its explicit id, else <type>_<index>. */
export function blockId(block: Block, index: number): string {
  return block.id ?? `${block.type}_${index}`;
}

/**
 * A period range as one string, equal for every spelling of the same span: "last_30_days" and
 * {"last": 30, "unit": "day"} are both "last_30_days", {"to_date": "month"} and {"last": 1, "unit":
 * "month"} are both "month_to_date", and a range of dates is "<first>..<last>", both days
 * included, the way a reader writes it in a link.
 */
export function rangeKey(range: RangeSpec): string {
  if (typeof range === "string") return range;
  if ("start" in range) {
    const [y = 1, m = 1, d = 1] = range.end.split("-").map(Number);
    const last = new Date(0);
    last.setUTCFullYear(y, m - 1, d - 1);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${range.start}..${pad(last.getUTCFullYear(), 4)}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
  }
  if ("last" in range) {
    return range.last === 1 ? `${range.unit}_to_date` : `last_${range.last}_${range.unit}s`;
  }
  if ("to_date" in range) return `${range.to_date}_to_date`;
  return `last_complete_${range.last_complete}`;
}

/** Slices a pie or donut shows before grouping the rest into "Other". */
export const PIE_DEFAULT_LIMIT = 5;
