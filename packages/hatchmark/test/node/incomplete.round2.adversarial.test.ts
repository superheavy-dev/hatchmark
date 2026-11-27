import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KpiData, LineData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

// Ported from HAT-51's round-2 adversarial harness on hatchmark#20 (whole-day ruling B, RFC 0001
// sections 6.1, 6.4, 6.5). An empty window shows no value, never 0. The oracle never calls the planner, windows.ts or the
// executor: windows come from the RFC's wording, sums are plain SQL over the CSV compared as
// instants, and partial shares are wall-clock arithmetic done with Intl.

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

async function dashboard(options: {
  sources: Record<string, string>;
  period: Record<string, unknown>;
  blocks: unknown[];
  metrics?: Record<string, unknown>;
  timezone?: string;
}) {
  const fixture = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "HAT-51",
      timezone: options.timezone ?? "UTC",
      sources: Object.fromEntries(
        Object.keys(options.sources).map((n) => [n, { type: "csv", path: `${n}.csv` }]),
      ),
    },
    ...Object.fromEntries(Object.entries(options.sources).map(([n, text]) => [`${n}.csv`, text])),
    ...Object.fromEntries(
      Object.keys(options.sources).map((n) => [
        `metrics/${n}.json`,
        metric({ type: "aggregate", table: n, aggregate: "sum", column: "v", time: "at" }),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(options.metrics ?? {}).map(([n, m]) => [`metrics/${n}.json`, m]),
    ),
    "dashboards/d.json": { title: "D", period: options.period, blocks: options.blocks },
  });
  const { data, diagnostics } = await run(fixture.root, fixture.project, "d");
  const block = <T>(id: string) => data?.blocks.find((b) => b.id === id) as T;
  return { data, diagnostics, block, root: fixture.root };
}

const csv = (pairs: [string, number][]) =>
  `at,v\n${pairs.map(([at, v]) => `${at},${v}`).join("\n")}\n`;

/** One row of value 1 every hour in [from, to] (UTC ISO, inclusive), so a sum counts hours. */
function hourly(from: string, to: string): [string, number][] {
  const out: [string, number][] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 3_600_000) {
    out.push([new Date(t).toISOString(), 1]);
  }
  return out;
}

/** Oracle sum over [from, to) compared as instants (TIMESTAMPTZ), never as local wall time. */
async function sumInstants(root: string, source: string, from: string, to: string) {
  const [r] = await oracle.rows(`
    SELECT coalesce(sum(v), 0) AS v FROM read_csv('${path.join(root, `${source}.csv`)}')
    WHERE CAST("at" AS TIMESTAMPTZ) >= TIMESTAMPTZ '${from}'
      AND CAST("at" AS TIMESTAMPTZ) < TIMESTAMPTZ '${to}'`);
  return Number(r?.v);
}

/** Oracle sum over local dates [from, to) in a zone, by the row's instant converted with DuckDB. */
async function sumDays(root: string, source: string, tz: string, from: string, to: string) {
  const [r] = await oracle.rows(`
    SELECT coalesce(sum(v), 0) AS v FROM read_csv('${path.join(root, `${source}.csv`)}')
    WHERE CAST(timezone('${tz}', CAST("at" AS TIMESTAMPTZ)) AS DATE) >= DATE '${from}'
      AND CAST(timezone('${tz}', CAST("at" AS TIMESTAMPTZ)) AS DATE) < DATE '${to}'`);
  return Number(r?.v);
}
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

describe("R2 blockers: a slid last N months or weeks keeps its length (RFC 6.4)", () => {
  // Fixed as-of Feb 15, 2026, UTC. Run a has one row after the as-of, so its horizon is past T and
  // the window is resolveRange's: Mar 1, 2025 to Feb 16, 2026 (352 days). Run b ends 11 p.m. Feb 15,
  // so the window slides to end at Feb 15 (exclusive) "keeping its length": 352 days, Feb 28, 2025
  // to Feb 15, 2026. One hour less data must not add 13 days to the window.
  for (const [range, label, asOf] of [
    ["last_12_months", "12 months", "2026-02-15"],
    [{ last: 4, unit: "week" }, "4 weeks", "2026-02-11"],
  ] as const) {
    it(`R2-1 ${label}: one hour less data must not lengthen the window`, async () => {
      const next = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString();
      const base = hourly("2024-01-01T00:00:00Z", `${asOf}T23:00:00Z`);
      const out: KpiData[] = [];
      for (const extra of [[[next, 1] as [string, number]], []]) {
        const { block } = await dashboard({
          sources: { orders: csv([...base, ...extra]) },
          period: { asOf, range, compare: "previous_period" },
          blocks: [{ type: "kpi", id: "k", metric: "orders" }],
        });
        out.push(block<KpiData>("k"));
      }
      const [a, b] = out as [KpiData, KpiData];
      const len = (k: KpiData) => days(k.current?.start ?? "", k.current?.end ?? "");
      expect(b.current?.end).toBe(asOf);
      console.log(label, "complete:", a.current, a.value, "one hour less:", b.current, b.value);
      expect(len(b)).toBe(len(a));
    });
  }
});

describe("R2 invariants (a) whole local days ending at the last complete day, (b) same number of days", () => {
  // America/New_York, horizon in the repeated fall-back hour (05:30Z = 01:30 EDT on Nov 1, 2026)
  // and at 14:03 on Nov 26. Every KPI bound must be a date, the window must end at the horizon's
  // local date (exclusive) or earlier, the value and previous value must equal SQL over those local
  // dates, and previous must cover as many days as current (to-date: day clamp, reported apart).
  const tz = "America/New_York";
  const ranges: unknown[] = [
    "last_7_days",
    "last_30_days",
    "last_12_months",
    { last: 3, unit: "month" },
    { last: 2, unit: "quarter" },
    "month_to_date",
    "quarter_to_date",
    "year_to_date",
    "last_complete_month",
    { start: "2026-10-20", end: "2026-12-10" },
    "all_time",
  ];
  const clamp: string[] = [];
  for (const last of ["2026-11-01T05:30:00Z", "2026-11-26T19:03:00Z", "2026-11-26T05:00:00Z"]) {
    for (const range of ranges) {
      for (const compare of ["previous_period", "previous_year"]) {
        if (range === "all_time" && compare !== "previous_period") continue;
        it(`R2-2 ${last} ${JSON.stringify(range)} ${compare}`, async () => {
          const { block, root } = await dashboard({
            timezone: tz,
            sources: { orders: csv(hourly("2025-01-01T00:00:00Z", last)) },
            period: {
              asOf: "latest_data",
              range,
              compare: range === "all_time" ? "none" : compare,
            },
            blocks: [{ type: "kpi", id: "k", metric: "orders" }],
          });
          const k = block<KpiData>("k");
          const hDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(last));
          if (range === "all_time") {
            expect(k.value).toBe(await sumDays(root, "orders", tz, "2000-01-01", hDay));
            return;
          }
          const cur = k.current;
          const prev = k.previous;
          expect(cur?.endAt).toBeUndefined();
          expect(cur?.startAt).toBeUndefined();
          expect(prev?.endAt).toBeUndefined();
          expect((cur?.end ?? "") <= hDay).toBe(true);
          const cut = cur?.end === hDay && !hDay.endsWith("-01");
          if (cur?.start === cur?.end) {
            expect(k).toMatchObject({ value: null, empty: "no_complete_day", previousValue: null });
            return;
          }
          expect(k.value).toBe(await sumDays(root, "orders", tz, cur?.start ?? "", cur?.end ?? ""));
          expect(k.previousValue).toBe(
            await sumDays(root, "orders", tz, prev?.start ?? "", prev?.end ?? ""),
          );
          const dc = days(cur?.start ?? "", cur?.end ?? "");
          const dp = days(prev?.start ?? "", prev?.end ?? "");
          if (typeof range === "string" && range.endsWith("_to_date")) {
            if (dc !== dp) clamp.push(`${range} ${compare} ${hDay}: ${dc} vs ${dp}`);
          } else if (cut || !(typeof range === "string" && range.startsWith("last_complete"))) {
            expect(dp).toBe(dc);
          }
        });
      }
    }
  }
  afterAll(() => {
    if (clamp.length > 0)
      console.log(`to-date day counts differ (RFC day clamp):\n${clamp.join("\n")}`);
  });
});

describe("R2 note: to-date comparisons map the date with the RFC day clamp, not the day count", () => {
  it("R2-4 year_to_date vs previous_year through Mar 14, 2028 covers 74 days against 73", async () => {
    const { block } = await dashboard({
      sources: { orders: csv(hourly("2027-01-01T00:00:00Z", "2028-03-15T14:00:00Z")) },
      period: { asOf: "latest_data", range: "year_to_date", compare: "previous_year" },
      blocks: [{ type: "kpi", id: "k", metric: "orders" }],
    });
    const k = block<KpiData>("k");
    expect(k.current).toEqual({ start: "2028-01-01", end: "2028-03-15" });
    expect(k.previous).toEqual({ start: "2027-01-01", end: "2027-03-15" });
    expect([k.value, k.previousValue]).toEqual([74 * 24, 73 * 24]);
  });
});

describe("R2 controls: time series cut by instant", () => {
  it("R2-3 a line in the repeated hour counts rows strictly before the horizon instant", async () => {
    const tz = "America/New_York";
    const { block, root } = await dashboard({
      timezone: tz,
      sources: {
        den: csv([
          ["2026-10-31T12:00:00Z", 1],
          ["2026-11-01T06:30:00Z", 1],
        ]),
        num: csv([
          ["2026-11-01T05:15:00Z", 1],
          ["2026-11-01T05:45:00Z", 10],
          ["2026-11-01T06:10:00Z", 100],
          ["2026-11-01T06:40:00Z", 1000],
        ]),
      },
      period: { asOf: "latest_data", range: "month_to_date", compare: "none" },
      blocks: [{ type: "line", id: "l", metrics: ["num", "den"], grain: "day" }],
    });
    const line = block<LineData>("l");
    const den = line.series.find((s) => s.key === "den");
    expect(den?.values[0]).toBe(
      await sumInstants(root, "den", "2026-11-01 04:00:00Z", "2026-11-01 06:30:00.000001Z"),
    );
    expect(den?.partial?.[0]?.elapsed).toBeCloseTo(1.5 / 24, 5);
  });
});
