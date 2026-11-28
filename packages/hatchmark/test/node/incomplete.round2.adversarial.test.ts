import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KpiData, LineData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

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
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "incomplete",
      timezone: options.timezone ?? "UTC",
      sources: Object.fromEntries(
        Object.keys(options.sources).map((n) => [n, { type: "csv", path: `${n}.csv` }]),
      ),
    },
    ...Object.fromEntries(Object.entries(options.sources).map(([n, text]) => [`${n}.csv`, text])),
    ...Object.fromEntries(
      Object.keys(options.sources).map((n) => [
        `metrics/${n}.yaml`,
        metric({ type: "aggregate", table: n, aggregate: "sum", column: "v", time: "at" }),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(options.metrics ?? {}).map(([n, m]) => [`metrics/${n}.yaml`, m]),
    ),
    "dashboards/d.yaml": { title: "D", period: options.period, blocks: options.blocks },
  });
  const { data, diagnostics } = await run(fixture.root, fixture.project, "d");
  const block = <T>(id: string) => data?.blocks.find((b) => b.id === id) as T;
  return { data, diagnostics, block, root: fixture.root };
}

const csv = (pairs: [string, number][]) =>
  `at,v\n${pairs.map(([at, v]) => `${at},${v}`).join("\n")}\n`;

function hourly(from: string, to: string): [string, number][] {
  const out: [string, number][] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 3_600_000) {
    out.push([new Date(t).toISOString(), 1]);
  }
  return out;
}

async function sumInstants(root: string, source: string, from: string, to: string) {
  const [r] = await oracle.rows(`
    SELECT coalesce(sum(v), 0) AS v FROM read_csv('${path.join(root, `${source}.csv`)}')
    WHERE CAST("at" AS TIMESTAMPTZ) >= TIMESTAMPTZ '${from}'
      AND CAST("at" AS TIMESTAMPTZ) < TIMESTAMPTZ '${to}'`);
  return Number(r?.v);
}

async function sumDays(root: string, source: string, tz: string, from: string, to: string) {
  const [r] = await oracle.rows(`
    SELECT coalesce(sum(v), 0) AS v FROM read_csv('${path.join(root, `${source}.csv`)}')
    WHERE CAST(timezone('${tz}', CAST("at" AS TIMESTAMPTZ)) AS DATE) >= DATE '${from}'
      AND CAST(timezone('${tz}', CAST("at" AS TIMESTAMPTZ)) AS DATE) < DATE '${to}'`);
  return Number(r?.v);
}
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

async function toDateOracle(
  root: string,
  tz: string,
  horizon: string,
  start: string,
  shiftedStart: string,
  shiftedEnd: string,
) {
  const [r] = await oracle.rows(`
    WITH src AS (SELECT CAST("at" AS TIMESTAMPTZ) AS t, v FROM read_csv('${path.join(root, "orders.csv")}')),
    bounds AS (
      SELECT
        timezone('${tz}', TIMESTAMP '${start}') AS cur_from,
        TIMESTAMPTZ '${horizon}' AS cur_to,
        timezone('${tz}', TIMESTAMPTZ '${horizon}') AS h_wall,
        timezone('${tz}', TIMESTAMP '${shiftedStart}') AS prev_from,
        least(
          TIMESTAMP '${shiftedStart}' + (timezone('${tz}', TIMESTAMPTZ '${horizon}') - TIMESTAMP '${start}'),
          TIMESTAMP '${shiftedEnd}') AS prev_wall
    )
    SELECT
      (SELECT coalesce(sum(v), 0) FROM src WHERE t >= cur_from AND t < cur_to) AS value,
      (SELECT coalesce(sum(v), 0) FROM src
        WHERE t >= prev_from AND t < timezone('${tz}', prev_wall)) AS previous,
      strftime(h_wall, '%Y-%m-%dT%H:%M:%S.%f') AS h_wall,
      strftime(prev_wall, '%Y-%m-%dT%H:%M:%S.%f') AS prev_wall
    FROM bounds`);
  return {
    value: Number(r?.value),
    previous: Number(r?.previous),
    hWall: String(r?.h_wall),
    prevWall: String(r?.prev_wall),
  };
}

const TO_DATE_MONTHS: Record<string, number> = {
  month_to_date: 1,
  quarter_to_date: 3,
  year_to_date: 12,
};

describe("a slid last N months or weeks keeps its length (RFC 6.4)", () => {
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

describe("R2 invariants: last N, complete and explicit ranges read whole local days to the last complete day over the same number of days; to-date ranges read through the horizon and compare the same elapsed time", () => {
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
          const months = typeof range === "string" ? TO_DATE_MONTHS[range] : undefined;
          if (months !== undefined) {
            const [y, m] = hDay.split("-").map(Number) as [number, number];
            const start =
              months === 1
                ? `${hDay.slice(0, 7)}-01`
                : months === 3
                  ? `${y}-${String(m - ((m - 1) % 3)).padStart(2, "0")}-01`
                  : `${y}-01-01`;
            const back = compare === "previous_year" ? 12 : months;
            const nextDay = new Date(Date.parse(`${hDay}T00:00:00Z`) + 86_400_000)
              .toISOString()
              .slice(0, 10);
            const shiftedEnd = addMonths(nextDay, -back);
            const newest = hourly("2025-01-01T00:00:00Z", last).at(-1)?.[0] ?? "";
            const horizon = newest.replace(/\.(\d{3})Z$/, ".$1001Z");
            const o = await toDateOracle(
              root,
              tz,
              horizon,
              start,
              addMonths(start, -back),
              shiftedEnd,
            );
            expect(cur).toEqual({ start, end: nextDay, endAt: o.hWall });
            const clamped = o.prevWall >= `${shiftedEnd}T00:00:00.000000`;
            expect(prev).toEqual(
              clamped
                ? { start: addMonths(start, -back), end: shiftedEnd }
                : {
                    start: addMonths(start, -back),
                    end: addMonths(nextDay, -back),
                    endAt: o.prevWall,
                  },
            );
            expect(k.value).toBe(o.value);
            expect(k.value).toBeGreaterThan(0);
            expect(k.previousValue).toBe(o.previous);
            return;
          }
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
          if (cut || !(typeof range === "string" && range.startsWith("last_complete"))) {
            expect(dp).toBe(dc);
          }
        });
      }
    }
  }
});

describe("R2 note: to-date comparisons cover the same elapsed time, cut by the RFC day clamp", () => {
  it("R2-4 year_to_date vs previous_year through 2 p.m. on Mar 15, 2028 covers 74 days and 15 hours against 74 days, clamped to the same date last year", async () => {
    const { block } = await dashboard({
      sources: { orders: csv(hourly("2027-01-01T00:00:00Z", "2028-03-15T14:00:00Z")) },
      period: { asOf: "latest_data", range: "year_to_date", compare: "previous_year" },
      blocks: [{ type: "kpi", id: "k", metric: "orders" }],
    });
    const k = block<KpiData>("k");
    expect(k.current).toEqual({
      start: "2028-01-01",
      end: "2028-03-16",
      endAt: "2028-03-15T14:00:00.000001",
    });
    expect(k.previous).toEqual({ start: "2027-01-01", end: "2027-03-16" });
    expect([k.value, k.previousValue]).toEqual([74 * 24 + 15, 74 * 24]);
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
