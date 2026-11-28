import type { Anchors, Grain, RangeSpec, ResolvedGrain, TimeGrain, Weekday } from "./common.js";
import type { Block } from "./dashboard.js";

export const GROUP_MAX_SIZE = 3;
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

export function grainUnit(grain: Grain): TimeGrain {
  return typeof grain === "string" ? grain : grain.unit;
}

export function resolveGrain(grain: Grain, anchors: Anchors): ResolvedGrain {
  const unit = grainUnit(grain);
  const own = typeof grain === "string" ? undefined : grain.anchor;
  if (unit === "day" || unit === "month") return { unit };
  if (unit === "week") return { unit, anchor: (own as Weekday | undefined) ?? anchors.week };
  return { unit, anchor: own ?? anchors[unit] };
}

export function grainKey(grain: Grain): string {
  const anchor = typeof grain === "string" ? undefined : grain.anchor;
  return anchor === undefined ? grainUnit(grain) : `${grainUnit(grain)}:${anchor}`;
}

export function blockId(block: Block, index: number): string {
  return block.id ?? `${block.type}_${index}`;
}

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

export const PIE_DEFAULT_LIMIT = 5;
