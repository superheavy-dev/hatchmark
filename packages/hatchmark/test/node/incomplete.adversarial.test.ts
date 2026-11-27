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

function wall(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instantMs))
      .map((p) => [p.type, p.value]),
  );
  const n = (key: string) => Number(parts[key]);
  return (
    Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) +
    (instantMs % 1000)
  );
}

function bucketEnd(start: string, unit: string): number {
  const d = new Date(`${start}T00:00:00Z`);
  if (unit === "day") d.setUTCDate(d.getUTCDate() + 1);
  if (unit === "week") d.setUTCDate(d.getUTCDate() + 7);
  if (unit === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  if (unit === "quarter") d.setUTCMonth(d.getUTCMonth() + 3);
  if (unit === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
}

describe("B: comparisons over the same span (RFC 6.4, day clamp as today)", () => {
  it("B1 quarter_to_date: the as-of day counts up to the horizon, and a row after the as-of completes it", async () => {
    const base = hourly("2026-01-01T00:00:00Z", "2026-05-15T23:00:00Z");
    const out: KpiData[] = [];
    for (const extra of [[], [["2026-05-16T00:00:00Z", 1] as [string, number]]]) {
      const { block } = await dashboard({
        sources: { orders: csv([...base, ...extra]) },
        period: { asOf: "2026-05-15", range: "quarter_to_date", compare: "previous_period" },
        blocks: [{ type: "kpi", id: "k", metric: "orders" }],
      });
      out.push(block<KpiData>("k"));
    }
    const [a, b] = out as [KpiData, KpiData];
    expect([a.value, b.value]).toEqual([44 * 24 + 24, 45 * 24]);
    expect(a.current).toEqual({
      start: "2026-04-01",
      end: "2026-05-16",
      endAt: "2026-05-15T23:00:00.000001",
    });
    expect(a.previous).toEqual({
      start: "2026-01-01",
      end: "2026-02-15",
      endAt: "2026-02-14T23:00:00.000001",
    });
    expect(a.previousValue).toBe(44 * 24 + 24);
    expect(b.current).toEqual({ start: "2026-04-01", end: "2026-05-16" });
    expect(b.previousValue).toBe(46 * 24);
  });

  it("B2 year_to_date vs previous_year in a leap year: the same elapsed time, clamped to the same date last year", async () => {
    const { block, root } = await dashboard({
      sources: { orders: csv(hourly("2027-01-01T00:00:00Z", "2028-03-15T14:00:00Z")) },
      period: { asOf: "latest_data", range: "year_to_date", compare: "previous_year" },
      blocks: [{ type: "kpi", id: "k", metric: "orders" }],
    });
    const horizon = "2028-03-15 14:00:00.000001Z";
    const [bound] = await oracle.rows(`
      SELECT strftime(least(
        TIMESTAMPTZ '2027-01-01 00:00:00Z' + (TIMESTAMPTZ '${horizon}' - TIMESTAMPTZ '2028-01-01 00:00:00Z'),
        TIMESTAMPTZ '2027-03-16 00:00:00Z'), '%Y-%m-%d %H:%M:%S.%fZ') AS end`);
    expect(bound?.end).toBe("2027-03-16 00:00:00.000000Z");
    const kpi = block<KpiData>("k");
    expect(kpi.value).toBe(await sumInstants(root, "orders", "2028-01-01 00:00:00Z", horizon));
    expect(kpi.value).toBe(74 * 24 + 15);
    expect(kpi.previousValue).toBe(
      await sumInstants(root, "orders", "2027-01-01 00:00:00Z", String(bound?.end)),
    );
    expect(kpi.previous).toEqual({ start: "2027-01-01", end: "2027-03-16" });
  });

  it("B2b last_12_months slides to the last complete day, keeping its 362 days; previous_year moves its first and last day", async () => {
    const { block, root } = await dashboard({
      sources: { orders: csv(hourly("2026-11-01T00:00:00Z", "2028-11-26T14:00:00Z")) },
      period: { asOf: "latest_data", range: "last_12_months", compare: "previous_year" },
      blocks: [{ type: "kpi", id: "k", metric: "orders" }],
    });
    const kpi = block<KpiData>("k");
    expect(kpi.value).toBe(
      await sumInstants(root, "orders", "2027-11-30 00:00:00Z", "2028-11-26 00:00:00Z"),
    );
    expect(kpi.previousValue).toBe(
      await sumInstants(root, "orders", "2026-11-30 00:00:00Z", "2027-11-26 00:00:00Z"),
    );
  });
});

describe("B3: a sub-day horizon inside the repeated DST hour (RFC 6.1 measure horizon)", () => {
  const ratio = { share: metric({ type: "ratio", numerator: "num", denominator: "den" }) };
  const cases: [string, string, [string, number][]][] = [
    [
      "horizon in the first 1:30 a.m. (EDT): a num row 40 minutes later is counted",
      "2026-11-01T05:30:00Z",
      [
        ["2026-11-01T05:15:00Z", 1],
        ["2026-11-01T05:50:00Z", 10],
        ["2026-11-01T06:10:00Z", 100],
        ["2026-11-01T12:00:00Z", 1000],
      ],
    ],
    [
      "horizon in the second 1:30 a.m. (EST): a num row 45 minutes earlier is dropped",
      "2026-11-01T06:30:00Z",
      [
        ["2026-11-01T05:15:00Z", 1],
        ["2026-11-01T05:45:00Z", 10],
        ["2026-11-01T06:10:00Z", 100],
        ["2026-11-01T12:00:00Z", 1000],
      ],
    ],
  ];
  for (const [name, denLast, numRows] of cases) {
    it(`B3 ${name}`, async () => {
      const { block, root } = await dashboard({
        timezone: "America/New_York",
        sources: {
          den: csv([
            ["2026-10-31T12:00:00Z", 1],
            [denLast, 1],
          ]),
          num: csv(numRows),
        },
        metrics: ratio,
        period: { asOf: "latest_data", range: "month_to_date", compare: "none" },
        blocks: [
          { type: "kpi", id: "k", metric: "share" },
          { type: "line", id: "l", metrics: ["share"], grain: "day" },
        ],
      });
      const horizon = `${denLast.slice(0, 10)} ${denLast.slice(11, 19)}.000001Z`;
      const from = "2026-11-01 04:00:00Z";
      const num = await sumInstants(root, "num", from, horizon);
      const den = await sumInstants(root, "den", from, horizon);
      expect(block<LineData>("l").series[0]?.values[0]).toBe(num / den);
      expect(block<KpiData>("k")).toMatchObject({
        value: num / den,
        current: { start: "2026-11-01", end: "2026-11-02", endAt: "2026-11-01T01:30:00.000001" },
      });
    });
  }
});

describe("C: controls (expected to hold)", () => {
  it("C1 a ratio ends at its laggiest operand, value and comparison", async () => {
    const { block, root } = await dashboard({
      sources: {
        num: csv(
          hourly("2026-09-01T00:00:00Z", "2026-11-26T14:00:00Z").map(([t], i) => [t, (i % 5) + 1]),
        ),
        den: csv(hourly("2026-09-01T00:00:00Z", "2026-11-20T09:00:00Z")),
      },
      metrics: { share: metric({ type: "ratio", numerator: "num", denominator: "den" }) },
      period: { asOf: "latest_data", range: "month_to_date", compare: "previous_period" },
      blocks: [{ type: "kpi", id: "k", metric: "share" }],
    });
    const h = "2026-11-20 09:00:00.000001Z";
    const ph = "2026-10-20 09:00:00.000001Z";
    const kpi = block<KpiData>("k");
    expect(kpi.value).toBeCloseTo(
      (await sumInstants(root, "num", "2026-11-01 00:00:00Z", h)) /
        (await sumInstants(root, "den", "2026-11-01 00:00:00Z", h)),
      12,
    );
    expect(kpi.previousValue).toBeCloseTo(
      (await sumInstants(root, "num", "2026-10-01 00:00:00Z", ph)) /
        (await sumInstants(root, "den", "2026-10-01 00:00:00Z", ph)),
      12,
    );
  });

  it("C2 a last_12_months KPI slides to whole days while its sparkline marks the partial month", async () => {
    const { block, root } = await dashboard({
      sources: {
        fresh: csv([["2026-11-26T10:00:00Z", 1]]),
        stale: csv(hourly("2025-10-01T00:00:00Z", "2026-11-03T05:00:00Z")),
      },
      period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
      blocks: [{ type: "kpi", id: "k", metric: "stale", sparkline: true }],
    });
    const kpi = block<KpiData>("k");
    expect(kpi.value).toBe(
      await sumInstants(root, "stale", "2025-11-30 00:00:00Z", "2026-11-03 00:00:00Z"),
    );
    const spark = kpi.sparkline?.values ?? [];
    expect(spark.reduce<number>((s, v) => s + (v ?? 0), 0)).toBe(
      await sumInstants(root, "stale", "2025-12-01 00:00:00Z", "2026-11-03 05:00:00.000001Z"),
    );
    expect(kpi.sparkline?.partial?.map((p) => p.index)).toEqual([11]);
    expect(kpi.sparkline?.partial?.[0]?.elapsed).toBeCloseTo((2 * 24 + 5) / (30 * 24), 5);
  });

  for (const tz of ["UTC", "America/New_York", "Australia/Lord_Howe"]) {
    for (const grain of [
      { unit: "week", anchor: "sunday" },
      "month",
      { unit: "quarter", anchor: "02-01" },
      { unit: "year", anchor: "07-01" },
    ]) {
      it(`C3 partial share by wall clock, ${tz}, ${JSON.stringify(grain)}, across its grain switch`, async () => {
        const last = "2026-11-01T06:00:00Z";
        const { block } = await dashboard({
          timezone: tz,
          sources: {
            fresh: csv([["2026-11-25T10:00:00Z", 1]]),
            stale: csv(hourly("2026-10-25T00:00:00Z", last)),
          },
          period: {
            asOf: "latest_data",
            range: { start: "2026-07-01", end: "2027-07-01" },
            compare: "none",
          },
          blocks: [
            { type: "line", id: "l", metrics: ["stale", "fresh"], grain, grains: [grain, "day"] },
          ],
        });
        const line = block<LineData>("l");
        const views = [
          { axis: line.axis, series: line.series },
          ...(line.grains?.options ?? []).map((o) => ({ axis: o.axis, series: o.series })),
        ];
        expect(views.length).toBe(3);
        const hWall = wall(Date.parse(last), tz) + 0.001;
        for (const view of views) {
          const axis = view.axis as { buckets: string[]; grain: string };
          const starts = axis.buckets.map((b) => Date.parse(`${b}T00:00:00Z`));
          const i = starts.findLastIndex((s) => s <= hWall);
          const start = starts[i] ?? 0;
          const share = (hWall - start) / (bucketEnd(axis.buckets[i] ?? "", axis.grain) - start);
          const stale = view.series.find((s) => s.key === "stale");
          expect(stale?.partial?.map((p) => p.index)).toEqual([i]);
          expect(stale?.partial?.[0]?.elapsed).toBeCloseTo(share, 5);
          expect(stale?.values.slice(i + 1).every((v) => v === null)).toBe(true);
          expect(stale?.values[i]).not.toBeNull();
        }
      });
    }
  }

  it("C4 last 7 days vs previous_year slides to Feb 29 and moves its first and last day", async () => {
    const { block, root } = await dashboard({
      sources: {
        fresh: csv([["2028-03-04T10:00:00Z", 1]]),
        stale: csv(hourly("2027-02-01T00:00:00Z", "2028-02-29T14:00:00Z")),
      },
      period: { asOf: "latest_data", range: { last: 7, unit: "day" }, compare: "previous_year" },
      blocks: [{ type: "kpi", id: "k", metric: "stale" }],
    });
    const kpi = block<KpiData>("k");
    expect(kpi.value).toBe(7 * 24);
    expect(kpi.value).toBe(
      await sumInstants(root, "stale", "2028-02-22 00:00:00Z", "2028-02-29 00:00:00Z"),
    );
    expect(kpi.previousValue).toBe(
      await sumInstants(root, "stale", "2027-02-22 00:00:00Z", "2027-03-01 00:00:00Z"),
    );
  });
});
