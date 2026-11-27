import { describe, expect, it } from "vitest";
import { bucketStart, resolveRange, type WindowBounds } from "../../src/compiler/index.js";
import type {
  Anchors,
  Comparison,
  RangeSpec,
  ResolvedGrain,
  TimeGrain,
} from "../../src/spec/index.js";

const FULL = process.env.HM_SWEEP === "full";
const SWEEP = { timeout: FULL ? 600_000 : 60_000 };
const [FROM, TO] = FULL ? ["2023-01-01", "2029-01-01"] : ["2027-01-01", "2029-01-01"];

const DEFAULT: Anchors = { week: "monday", quarter: "01-01", year: "01-01" };
const UNITS: TimeGrain[] = ["day", "week", "month", "quarter", "year"];
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000);

function* days(): Generator<string> {
  for (let d = FROM; d < TO; d = addDays(d, 1)) yield d;
}

function bounded(w: WindowBounds | undefined): { start: string; end: string } {
  if (w?.kind !== "bounded") throw new Error(`expected a bounded window, got ${JSON.stringify(w)}`);
  return w;
}

const shift = (unit: TimeGrain, by: number): Comparison => ({ shift: { unit, by } });

function shiftDay(d: string, unit: TimeGrain, by: number): string {
  if (unit === "day") return addDays(d, by);
  if (unit === "week") return addDays(d, 7 * by);
  const months = { month: 1, quarter: 3, year: 12 }[unit] * by;
  const [y = 0, m = 1, day = 1] = d.split("-").map(Number);
  const index = y * 12 + m - 1 + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return [
    String(ny).padStart(4, "0"),
    String(nm).padStart(2, "0"),
    String(Math.min(day, dim)).padStart(2, "0"),
  ].join("-");
}

function oracle(w: { start: string; end: string }, unit: TimeGrain, by: number) {
  const whole = w.start.endsWith("-01") && w.end.endsWith("-01");
  if (whole && unit !== "day" && unit !== "week") {
    return { start: shiftDay(w.start, unit, by), end: shiftDay(w.end, unit, by) };
  }
  return {
    start: shiftDay(w.start, unit, by),
    end: addDays(shiftDay(addDays(w.end, -1), unit, by), 1),
  };
}

const RANGES: RangeSpec[] = [
  ...[1, 7, 30, 90].map((last) => ({ last, unit: "day" as const })),
  { last: 2, unit: "month" },
  { last: 12, unit: "month" },
  { last: 3, unit: "week" },
  { last: 2, unit: "quarter" },
  { last: 1, unit: "year" },
  ...UNITS.map((u) => ({ to_date: u })),
  ...UNITS.map((u) => ({ last_complete: u })),
  "last_7_days",
  "last_30_days",
  "last_12_months",
  "month_to_date",
  "quarter_to_date",
  "year_to_date",
  "last_complete_month",
];

describe("resolveRange shifts (HAT-36 core.mjs and invariant.mjs)", SWEEP, () => {
  it("never resolves a range and comparison to an empty window", () => {
    const comparisons: Comparison[] = [
      "previous_period",
      "previous_year",
      ...UNITS.flatMap((u) => [-12, -3, -1, 1].map((by) => shift(u, by))),
    ];
    const empty: unknown[] = [];
    let checked = 0;
    for (const asOf of days()) {
      for (const range of RANGES) {
        for (const c of comparisons) {
          const w = bounded(resolveRange(range, c, asOf, DEFAULT));
          checked++;
          if (w.start >= w.end) empty.push({ asOf, range, c, w });
        }
      }
    }
    expect(empty.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  it("moves every window to exactly the oracle's shifted bounds, at two anchor sets", () => {
    const anchorSets: Anchors[] = [DEFAULT, { week: "sunday", quarter: "02-15", year: "02-15" }];
    const bad: unknown[] = [];
    for (const anchors of anchorSets) {
      for (const asOf of days()) {
        for (const range of RANGES) {
          const current = bounded(resolveRange(range, "none", asOf, anchors));
          for (const unit of UNITS) {
            for (const by of [-12, -3, -1, 1, 2]) {
              const w = bounded(resolveRange(range, shift(unit, by), asOf, anchors));
              const want = oracle(current, unit, by);
              if (w.start !== want.start || w.end !== want.end) {
                bad.push({ range, unit, by, asOf, anchors, current, w, want });
              }
            }
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("keeps whole-month windows whole when shifted by months, quarters or years", () => {
    const bad: unknown[] = [];
    for (const asOf of days()) {
      for (const range of RANGES) {
        const current = bounded(resolveRange(range, "none", asOf, DEFAULT));
        if (!(current.start.endsWith("-01") && current.end.endsWith("-01"))) continue;
        for (const unit of ["month", "quarter", "year"] as const) {
          for (const by of [-12, -3, -1, 1, 2]) {
            const w = bounded(resolveRange(range, shift(unit, by), asOf, DEFAULT));
            if (!(w.start.endsWith("-01") && w.end.endsWith("-01"))) bad.push({ range, asOf, w });
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("resolves previous_year exactly like a shift of one year back", () => {
    const bad: unknown[] = [];
    for (const asOf of days()) {
      const explicit = [1, 2, 29, 30, 31, 40].map((n) => ({ start: asOf, end: addDays(asOf, n) }));
      for (const range of [...RANGES, ...explicit]) {
        const py = resolveRange(range, "previous_year", asOf, DEFAULT);
        const sy = resolveRange(range, shift("year", -1), asOf, DEFAULT);
        if (JSON.stringify(py) !== JSON.stringify(sy)) bad.push({ range, asOf, py, sy });
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("shifts explicit {start, end} spans of 1 to 40 days and aligned months to the oracle's bounds", () => {
    const shifts: [TimeGrain, number][] = [
      ["month", -1],
      ["month", 1],
      ["quarter", -1],
      ["year", -1],
      ["year", 1],
    ];
    const bad: unknown[] = [];
    for (const asOf of days()) {
      const aligned = asOf.endsWith("-01")
        ? [1, 2, 3, 12].map((k) => ({ start: asOf, end: shiftDay(asOf, "month", k) }))
        : [];
      const spans = [1, 2, 29, 30, 31, 40].map((n) => ({ start: asOf, end: addDays(asOf, n) }));
      for (const r of [...spans, ...aligned]) {
        for (const [unit, by] of shifts) {
          const w = bounded(resolveRange(r, shift(unit, by), asOf, DEFAULT));
          const o = oracle(r, unit, by);
          if (w.start >= w.end || w.start !== o.start || w.end !== o.end) {
            bad.push({ r, unit, by, w, o });
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("keeps the shifted last included day of a span, and the shifted as-of of the last N days, inside the window", () => {
    const comparisons: Comparison[] = [
      shift("month", -1),
      shift("month", 1),
      "previous_year",
      shift("year", 1),
    ];
    const dropped: unknown[] = [];
    for (const s of days()) {
      for (const n of [1, 30]) {
        const r = { start: s, end: addDays(s, n) };
        for (const c of comparisons) {
          const w = bounded(resolveRange(r, c, s, DEFAULT));
          const lastDay = bounded(
            resolveRange({ start: addDays(r.end, -1), end: r.end }, c, s, DEFAULT),
          );
          if (lastDay.start < w.start || lastDay.start >= w.end) {
            dropped.push({ r, c, w, lastDay });
          }
        }
      }
      for (const last of [1, 7, 30]) {
        for (const c of ["previous_year", shift("month", -1)] as Comparison[]) {
          const w = bounded(resolveRange({ last, unit: "day" }, c, s, DEFAULT));
          const movedAsOf = bounded(resolveRange({ start: s, end: addDays(s, 1) }, c, s, DEFAULT));
          if (movedAsOf.start >= w.end) dropped.push({ last, asOf: s, c, w, movedAsOf });
        }
      }
    }
    expect(dropped.slice(0, 5)).toEqual([]);
  });
});

describe("last_complete and to_date at anchored edges (HAT-36 edges.mjs)", SWEEP, () => {
  const anchorSets: Anchors[] = [
    { week: "sunday", quarter: "02-15", year: "02-15" },
    { week: "wednesday", quarter: "01-28", year: "10-28" },
    { week: "monday", quarter: "03-01", year: "12-01" },
  ];
  const UNITS3 = ["week", "quarter", "year"] as const;
  const grainOf = (unit: (typeof UNITS3)[number], anchors: Anchors): ResolvedGrain =>
    unit === "week" ? { unit, anchor: anchors.week } : { unit, anchor: anchors[unit] };

  it("last_complete is the latest whole bucket ending by as-of + 1, and its previous_period the bucket before", () => {
    const bad: unknown[] = [];
    for (const anchors of anchorSets) {
      for (const asOf of days()) {
        const next = addDays(asOf, 1);
        for (const unit of UNITS3) {
          const grain = grainOf(unit, anchors);
          const lc = bounded(resolveRange({ last_complete: unit }, "none", asOf, anchors));
          if (
            lc.start !== bucketStart(addDays(lc.end, -1), grain) ||
            lc.end !== bucketStart(next, grain)
          ) {
            bad.push({ kind: "last_complete", anchors, unit, asOf, lc });
          }
          const lcp = bounded(
            resolveRange({ last_complete: unit }, "previous_period", asOf, anchors),
          );
          if (lcp.end !== lc.start || lcp.start !== bucketStart(addDays(lc.start, -1), grain)) {
            bad.push({ kind: "last_complete previous_period", anchors, unit, asOf, lc, lcp });
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("to_date runs from the anchored bucket start through as-of, and its previous_period starts one bucket earlier", () => {
    const bad: unknown[] = [];
    for (const anchors of anchorSets) {
      for (const asOf of days()) {
        const next = addDays(asOf, 1);
        for (const unit of UNITS3) {
          const grain = grainOf(unit, anchors);
          const td = bounded(resolveRange({ to_date: unit }, "none", asOf, anchors));
          if (td.start !== bucketStart(asOf, grain) || td.end !== next) {
            bad.push({ kind: "to_date", anchors, unit, asOf, td });
          }
          const tdp = bounded(resolveRange({ to_date: unit }, "previous_period", asOf, anchors));
          if (tdp.start !== bucketStart(addDays(td.start, -1), grain) || tdp.end > td.start) {
            bad.push({ kind: "to_date previous_period", anchors, unit, asOf, td, tdp });
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe("whole months stay whole months when shifted (HAT-36 months.mjs)", SWEEP, () => {
  const R = (r: RangeSpec, c: Comparison, asOf: string) => resolveRange(r, c, asOf, DEFAULT);
  const window = (start: string, end: string) => ({ kind: "bounded", start, end });

  it("compares February with the whole February before it, whatever its length", () => {
    expect(R("last_complete_month", "previous_year", "2021-03-15")).toEqual(
      window("2020-02-01", "2020-03-01"),
    );
  });

  it("shifts April back one month to all of March", () => {
    expect(R({ last_complete: "month" }, shift("month", -1), "2026-05-15")).toEqual(
      window("2026-03-01", "2026-04-01"),
    );
    expect(R({ start: "2026-04-01", end: "2026-05-01" }, shift("month", -1), "2026-05-15")).toEqual(
      window("2026-03-01", "2026-04-01"),
    );
  });

  it("shifts the last complete quarter (Q2) back one month to March through May", () => {
    expect(R({ last_complete: "quarter" }, shift("month", -1), "2026-07-15")).toEqual(
      window("2026-03-01", "2026-06-01"),
    );
  });

  it("never shifts the last complete month to a partial month", () => {
    const comparisons: Comparison[] = [
      "previous_year",
      shift("month", -1),
      shift("month", 1),
      shift("year", -1),
      shift("quarter", -1),
    ];
    const partial: unknown[] = [];
    for (const asOf of days()) {
      for (const c of comparisons) {
        const w = bounded(R({ last_complete: "month" }, c, asOf));
        if (!w.start.endsWith("-01") || w.end !== shiftDay(w.start, "month", 1)) {
          partial.push({ asOf, c, w });
        }
      }
    }
    expect(partial.slice(0, 5)).toEqual([]);
  });
});
