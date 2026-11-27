// Adopted from the HAT-36 adversarial review of hatchmark#14 (time ranges, anchored grains and shift
// comparisons): executor.mjs, plan.mjs, boundary.mjs and asof.mjs, run through the DuckDB executor.
// HM_SWEEP=full runs the review's executor sweep: every quarter and year anchor, 1995 to 2044.
import { afterAll, describe, expect, it } from "vitest";
import {
  bucketStart,
  type KpiData,
  type PlannedQuery,
  planDashboard,
  planHash,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import {
  checkReferences,
  DEFAULT_ANCHORS,
  PROJECT_DEFAULTS,
  parseDiagnostics,
  type ResolvedGrain,
  WEEKDAYS,
} from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const SWEEP = { timeout: FULL ? 600_000 : 60_000 };

afterAll(removeProjects);

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const daysBetween = (fromYear: number, toYear: number) => {
  const out: string[] = [];
  for (let t = Date.UTC(fromYear, 0, 1); t < Date.UTC(toYear, 0, 1); t += 86_400_000)
    out.push(iso(t));
  return out;
};
const config = (extra: Record<string, unknown> = {}) => ({
  ...PROJECT_DEFAULTS,
  name: "Windows",
  sources: { days: { type: "csv", path: "days.csv" } },
  ...extra,
});
const errorsOf = (loaded: Awaited<ReturnType<typeof writeProject>>): string[] =>
  [...loaded.diagnostics, ...parseDiagnostics(loaded.project), ...checkReferences(loaded.project)]
    .filter((d) => d.severity === "error")
    .map((d) => d.code);

describe("DuckDB buckets agree with the core's bucketStart (HAT-36 executor.mjs)", SWEEP, () => {
  it("buckets DATE, naive, -05:00 and +13:00 columns on the core's anchored bucket starts", async () => {
    const days = FULL ? daysBetween(1995, 2045) : daysBetween(2027, 2029);
    const zones = { early: "America/New_York", late: "Pacific/Auckland" } as const;
    const localDate = (instant: string, timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(instant));
    const csv = [
      "d,noon,early,late,label",
      ...days.map((d) =>
        [d, `${d} 12:00:00`, `${d}T00:30:00-05:00`, `${d}T23:30:00+13:00`, `x${d}`].join(","),
      ),
    ].join("\n");
    const { root, project } = await writeProject({
      "hatchmark.json": config(),
      "days.csv": `${csv}\n`,
    });
    const spec = project.config.spec;
    if (spec === undefined) throw new Error("invalid hatchmark.json");

    const monthDays: string[] = [];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 28; d++)
        monthDays.push(`${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    const sample = ["01-01", "02-15", "05-17", "07-01", "10-28", "12-28"];
    const base: ResolvedGrain[] = [
      { unit: "day" },
      { unit: "month" },
      ...WEEKDAYS.map((anchor) => ({ unit: "week", anchor }) as const),
    ];
    const anchored = (anchors: string[]): ResolvedGrain[] => [
      ...anchors.map((anchor) => ({ unit: "quarter", anchor }) as const),
      ...anchors.map((anchor) => ({ unit: "year", anchor }) as const),
    ];
    const wide = [...base, ...anchored(FULL ? monthDays : sample)];
    const narrow = [...base, ...anchored(sample)];
    const columns: [string, string, (d: string) => string, ResolvedGrain[]][] = [
      ["d", "UTC", (d) => d, wide],
      ["noon", "UTC", (d) => d, wide],
      ["early", zones.early, (d) => localDate(`${d}T05:30:00Z`, zones.early), narrow],
      ["late", zones.late, (d) => localDate(`${d}T10:30:00Z`, zones.late), narrow],
    ];
    const query = (grain: ResolvedGrain, column: string): PlannedQuery => ({
      id: "q",
      source: "days",
      input: { type: "csv", path: "days.csv" },
      measures: [
        {
          metric: "n",
          components: [{ id: "n__count", aggregate: "count", filters: [], reaggregate: "sum" }],
          combine: { op: "identity", component: "n__count" },
        },
      ],
      dimensions: [
        { kind: "time", column, grain },
        { kind: "column", column: "label" },
      ],
      groupingSets: [[0, 1]],
      window: { range: "all_time", shift: "none", column },
      params: [],
    });

    const wrong: unknown[] = [];
    let checked = 0;
    const executor = await createDuckDbExecutor({ root, config: spec });
    try {
      for (const [column, timezone, toLocal, grains] of columns) {
        for (const grain of grains) {
          const { rows } = await executor.execute(query(grain, column), {
            asOf: days.at(-1) as string,
            timezone,
            anchors: DEFAULT_ANCHORS,
            bindings: {},
          });
          if (rows.length !== days.length) wrong.push({ column, grain, rows: rows.length });
          for (const [bucket, label] of rows) {
            checked++;
            const local = toLocal(String(label).slice(1));
            const want = bucketStart(local, grain);
            if (String(bucket).slice(0, 10) !== want) {
              wrong.push({ column, timezone, grain, local, executor: bucket, core: want });
              break;
            }
          }
        }
      }
    } finally {
      await executor.close();
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(days.length);
  });
});

describe("plans and KPIs for anchors and shifts (HAT-36 plan.mjs)", SWEEP, () => {
  let csv = "at,amount\n";
  for (const d of daysBetween(2022, 2027)) csv += `${d},1\n`;
  const dashboard = (period: Record<string, unknown>, grain: unknown = "week") => ({
    title: "D",
    period,
    blocks: [
      { type: "kpi", id: "k", metric: "days" },
      { type: "line", id: "l", metrics: ["days"], grain },
    ],
  });
  const project = (extra: Record<string, unknown>, d: unknown) =>
    writeProject({
      "hatchmark.json": config(extra),
      "days.csv": csv,
      "metrics/days.json": metric({
        type: "aggregate",
        table: "days",
        time: "at",
        aggregate: "sum",
        column: "amount",
      }),
      "dashboards/d.json": d,
    });
  const P = { asOf: "2026-03-28", range: "last_30_days", compare: "previous_period" };
  const hash = async (extra: Record<string, unknown>, d: unknown) => {
    const loaded = await project(extra, d);
    expect(errorsOf(loaded)).toEqual([]);
    const { plan } = planDashboard(loaded.project, "d");
    if (plan === undefined) throw new Error("no plan");
    return planHash(plan);
  };

  it.each([
    [
      "weekStart sunday and anchors.week sunday",
      [
        [{ weekStart: "sunday" }, dashboard(P)],
        [{ anchors: { week: "sunday" } }, dashboard(P)],
      ],
    ],
    [
      "no anchors and the explicit default anchors",
      [
        [{}, dashboard(P)],
        [{ anchors: { week: "monday", quarter: "01-01", year: "01-01" } }, dashboard(P)],
      ],
    ],
    [
      "year 02-15 alone and year with quarter 02-15",
      [
        [{ anchors: { year: "02-15" } }, dashboard(P)],
        [{ anchors: { year: "02-15", quarter: "02-15" } }, dashboard(P)],
      ],
    ],
    [
      "grain week, {unit: week} and {unit: week, anchor: monday}",
      [
        [{}, dashboard(P, "week")],
        [{}, dashboard(P, { unit: "week" })],
        [{}, dashboard(P, { unit: "week", anchor: "monday" })],
      ],
    ],
    [
      "range shorthand keys in either order",
      [
        [{}, dashboard({ ...P, range: { last: 30, unit: "day" } })],
        [{}, dashboard({ ...P, range: { unit: "day", last: 30 } })],
      ],
    ],
  ] as [string, [Record<string, unknown>, unknown][]][])(
    "plan hash is the same for equivalent spellings: %s",
    async (_, spellings) => {
      const hashes = await Promise.all(spellings.map(([extra, d]) => hash(extra, d)));
      expect(new Set(hashes).size).toBe(1);
    },
  );

  it.each([
    ["anchors.year 02-29", { anchors: { year: "02-29" } }, dashboard(P), ["HM3005"]],
    [
      "anchors.week Sunday (capitalized)",
      { anchors: { week: "Sunday" } },
      dashboard(P),
      ["HM3004"],
    ],
    [
      "quarter 03-15 that does not divide year 02-15",
      { anchors: { year: "02-15", quarter: "03-15" } },
      dashboard(P),
      ["HM3007"],
    ],
    [
      "quarter 05-15 with year 02-15 is valid",
      { anchors: { year: "02-15", quarter: "05-15" } },
      dashboard(P),
      [],
    ],
    [
      "quarter 02-15 with the default year is valid",
      { anchors: { quarter: "02-15" } },
      dashboard(P),
      [],
    ],
    ["shift by 0", {}, dashboard({ ...P, compare: { shift: { unit: "day", by: 0 } } }), ["HM3005"]],
    [
      "shift by 1.5",
      {},
      dashboard({ ...P, compare: { shift: { unit: "month", by: 1.5 } } }),
      ["HM3004"],
    ],
    [
      "start 2025-02-29",
      {},
      dashboard({ ...P, range: { start: "2025-02-29", end: "2025-03-10" } }),
      ["HM3005"],
    ],
    [
      "start equal to end",
      {},
      dashboard({ ...P, range: { start: "2025-03-10", end: "2025-03-10" } }),
      ["HM3005"],
    ],
    [
      "month grain with an anchor",
      {},
      dashboard(P, { unit: "month", anchor: "01-01" }),
      ["HM3007"],
    ],
    [
      "quarter grain with a weekday anchor",
      {},
      dashboard(P, { unit: "quarter", anchor: "monday" }),
      ["HM3007"],
    ],
    ["grain Week (capitalized)", {}, dashboard(P, "Week"), ["HM3004"]],
  ] as [string, Record<string, unknown>, unknown, string[]][])(
    "check rejects invalid anchors, shifts, ranges and grains: %s",
    async (_, extra, d, codes) => {
      expect(errorsOf(await project(extra, d))).toEqual(codes);
    },
  );

  const kpi = async (period: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const loaded = await project(extra, dashboard(period));
    const { data, diagnostics } = await run(loaded.root, loaded.project, "d");
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const k = data?.blocks.find((b) => b.id === "k") as KpiData | undefined;
    return {
      current: k?.current,
      value: k?.value,
      previous: k?.previous,
      previousValue: k?.previousValue,
    };
  };

  it("one row a day: a shifted window's KPI counts every day the shifted window covers", async () => {
    expect(
      await kpi({
        asOf: "2026-03-28",
        range: "last_7_days",
        compare: { shift: { unit: "month", by: -1 } },
      }),
    ).toEqual({
      current: { start: "2026-03-22", end: "2026-03-29" },
      value: 7,
      previous: { start: "2026-02-22", end: "2026-03-01" },
      previousValue: 7,
    });
    expect(
      await kpi({
        asOf: "2026-03-28",
        range: { start: "2026-01-01", end: "2026-01-31" },
        compare: { shift: { unit: "month", by: 1 } },
      }),
    ).toEqual({
      current: { start: "2026-01-01", end: "2026-01-31" },
      value: 30,
      previous: { start: "2026-02-01", end: "2026-03-01" },
      previousValue: 28,
    });
    expect(
      await kpi({
        asOf: "2026-03-28",
        range: { start: "2026-01-30", end: "2026-01-31" },
        compare: { shift: { unit: "month", by: 1 } },
      }),
    ).toMatchObject({
      previous: { start: "2026-02-28", end: "2026-03-01" },
      previousValue: 1,
    });
    expect(
      await kpi({
        asOf: "2026-05-30",
        range: { last: 1, unit: "day" },
        compare: { shift: { unit: "month", by: -1 } },
      }),
    ).toMatchObject({
      previous: { start: "2026-04-30", end: "2026-05-01" },
      previousValue: 1,
    });
    expect(
      await kpi({
        asOf: "2026-03-28",
        range: { start: "2024-02-01", end: "2024-02-29" },
        compare: "previous_year",
      }),
    ).toMatchObject({
      value: 28,
      previous: { start: "2023-02-01", end: "2023-03-01" },
      previousValue: 28,
    });
  });

  it("quarter_to_date at a 02-15 year anchor compares with the previous quarter through the clamped last day", async () => {
    expect(
      await kpi(
        { asOf: "2026-05-31", range: "quarter_to_date", compare: "previous_period" },
        { anchors: { year: "02-15" } },
      ),
    ).toEqual({
      current: { start: "2026-05-15", end: "2026-06-01" },
      value: 17,
      previous: { start: "2026-02-15", end: "2026-03-01" },
      previousValue: 14,
    });
  });
});

describe(
  "dates outside 0001-01-01 to 9998-12-31 fail with HM2015 (HAT-36 boundary.mjs and asof.mjs)",
  SWEEP,
  () => {
    const runWith = async (csv: string, period: Record<string, unknown>, grain = "day") => {
      const loaded = await writeProject({
        "hatchmark.json": config(),
        "days.csv": csv,
        "metrics/n.json": metric({
          type: "aggregate",
          table: "days",
          time: "at",
          aggregate: "count",
        }),
        "dashboards/d.json": {
          title: "D",
          period,
          blocks: [
            { type: "kpi", id: "k", metric: "n" },
            { type: "line", id: "l", metrics: ["n"], grain },
          ],
        },
      });
      const { data, diagnostics } = await run(loaded.root, loaded.project, "d");
      return {
        data: data !== undefined,
        errors: diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
      };
    };
    const failed = { data: false, errors: ["HM2015"] };
    const ran = { data: true, errors: [] };

    it("an all_time day chart over rows on 9999-12-30 and 9999-12-31", async () => {
      expect(
        await runWith("at\n2026-01-01\n9999-12-30\n9999-12-31\n", {
          asOf: "2026-03-01",
          range: "all_time",
          compare: "none",
        }),
      ).toEqual(failed);
    });

    it("an all_time week chart over a row on 0000-01-01", async () => {
      expect(
        await runWith(
          "at\n0000-01-01\n2026-01-01\n",
          { asOf: "2026-03-01", range: "all_time", compare: "none" },
          "week",
        ),
      ).toEqual(failed);
    });

    it("last_7_days shifted back 2026 years", async () => {
      expect(
        await runWith("at\n2026-01-01\n", {
          asOf: "2026-03-01",
          range: "last_7_days",
          compare: { shift: { unit: "year", by: -2026 } },
        }),
      ).toEqual(failed);
    });

    it.each(["9999-12-31", "0000-12-31"])("as-of %s", async (asOf) => {
      expect(
        await runWith("at\n2026-01-01\n9998-12-31\n", { asOf, range: "all_time", compare: "none" }),
      ).toEqual(failed);
    });

    it.each(["9998-12-31", "latest_data"])(
      "as-of %s, inside the supported dates, runs",
      async (asOf) => {
        expect(
          await runWith("at\n2026-01-01\n9998-12-31\n", {
            asOf,
            range: "all_time",
            compare: "none",
          }),
        ).toEqual(ran);
      },
    );

    it("a normal previous_year run next to them still runs", async () => {
      expect(
        await runWith("at\n2026-01-01\n2026-02-27\n", {
          asOf: "2026-03-01",
          range: "last_7_days",
          compare: "previous_year",
        }),
      ).toEqual(ran);
    });
  },
);
