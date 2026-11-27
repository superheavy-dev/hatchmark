// Independent oracle for the period filter (GUN-1823): every preset the build embeds, and custom ranges
// through customRangeDashboard on that same embedded payload (the browser path), checked against
// periods.oracle.ts; custom ranges are also checked against runDashboard's SQL path with the same binding.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DashboardData } from "../../src/compiler/dashboard-data.js";
import { runDashboard } from "../../src/compiler/index.js";
import { customRangeDashboard, type PeriodData } from "../../src/compiler/period-data.js";
import { parseDaysKey } from "../../src/compiler/periods.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import type { RangeSpec } from "../../src/spec/index.js";
import { buildProject, EXAMPLE, loadAt, removeProjects, writeExample } from "./fixture.js";
import {
  type Anchors,
  checkDashboard,
  compareData,
  Diff,
  type Horizon,
  horizonOf,
  periodsOf,
  type Range,
  type Row,
  randomRanges,
  readRows,
  type SpecBlock,
  type Window,
} from "./periods.oracle.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ANCHORS: Anchors = { week: "sunday", quarter: "01-01", year: "01-01" };
type Explorer = {
  filters: { type: string; options: Range[]; default: unknown }[];
  blocks: SpecBlock[];
};
let explorer: Explorer;
let root: string;
let payload: PeriodData;
let rows: Row[];
let asOf: string;
let horizon: Horizon;
const tally = { cells: 0, mismatches: 0 };

beforeAll(async () => {
  explorer = JSON.parse(await readFile(path.join(EXAMPLE, "dashboards/explorer.json"), "utf8"));
  root = await writeExample({}, { explorer });
  expect((await buildProject(root)).code).toBe(0);
  payload = periodsOf(
    await readFile(path.join(root, "dist/explorer/index.html"), "utf8"),
  ) as PeriodData;
  rows = await readRows(root);
  asOf = rows.reduce((m, r) => (r.d !== null && r.d > m ? r.d : m), "");
  horizon = horizonOf(rows, "latest_data");
});
afterAll(async () => {
  console.log(`periods.adversarial: ${tally.cells} cells compared, ${tally.mismatches} mismatches`);
  await removeProjects();
});

const periodFilter = () =>
  explorer.filters.find((f) => f.type === "period") as Explorer["filters"][number];
const grainDefault = () => explorer.filters.find((f) => f.type === "grain")?.default as string;
const record = (d: Diff) => {
  tally.cells += d.cells;
  tally.mismatches += d.problems.length;
  return d;
};
const custom = (w: Window) =>
  customRangeDashboard(payload.custom as NonNullable<PeriodData["custom"]>, payload.filter, {
    start: w[0],
    end: w[1],
  });
const checkCustom = (w: Window, diff: Diff) => {
  const data = custom(w);
  diff.same(`${w} periodFilter.custom`, data.periodFilter?.custom, payload.custom?.span);
  return checkDashboard(
    data,
    explorer.blocks,
    {
      rows,
      range: { start: w[0], end: w[1] },
      horizon,
      anchors: ANCHORS,
      grainDefault: grainDefault(),
      presetOnly: new Set(["customers"]),
    },
    diff,
  );
};

const EDGES: Record<string, Window> = {
  "a single day": ["2025-06-15", "2025-06-16"],
  "the first day with data (comparison before the data)": ["2024-11-01", "2024-11-02"],
  "the first month (comparison entirely before the data)": ["2024-11-01", "2024-12-01"],
  "a comparison window half before the data": ["2024-11-10", "2024-11-20"],
  "the as-of day": ["2026-10-31", "2026-11-01"],
  "the whole span": ["2024-11-01", "2026-11-01"],
  "US DST start 2025-03-09": ["2025-03-08", "2025-03-11"],
  "US DST end 2025-11-02": ["2025-11-01", "2025-11-04"],
  "US DST start 2026-03-08": ["2026-03-07", "2026-03-10"],
  "US DST end 2024-11-03": ["2024-11-02", "2024-11-05"],
  "two DST changes in one range": ["2025-03-01", "2025-11-15"],
  "a month boundary": ["2025-01-31", "2025-02-02"],
  "February of a non-leap year": ["2025-02-01", "2025-03-01"],
  "a quarter boundary": ["2025-03-31", "2025-04-02"],
  "a year boundary": ["2025-12-31", "2026-01-02"],
  "one week, Wednesday to Wednesday (partial first and last week buckets)": [
    "2025-06-11",
    "2025-06-18",
  ],
  "one week, exactly a Sunday week": ["2025-06-15", "2025-06-22"],
  "a range ending on the as-of day": ["2026-09-15", "2026-11-01"],
};

describe("period filter presets match the oracle (from the embedded data-hm-periods payload)", () => {
  it("the payload has every preset, the span from the first day with data, and no preset-only metric", () => {
    expect(asOf).toBe("2026-10-31");
    expect(payload.filter).toBe("period");
    expect(Object.keys(payload.presets)).toEqual([
      "last_7_days",
      "last_30_days",
      "month_to_date",
      "last_complete_month",
      "quarter_to_date",
      "last_complete_quarter",
      "year_to_date",
      "last_12_months",
    ]);
    expect(payload.custom?.span).toEqual({ start: "2024-11-01", end: "2026-11-01" });
    expect(payload.custom?.presetOnly ?? []).toEqual([]);
  });

  it("every preset: KPIs with previous, change and change_pct, every grain of the region lines, the channel bar and the country table", () => {
    const diff = new Diff();
    for (const option of periodFilter().options) {
      const data = Object.values(payload.presets).find(
        (d) => JSON.stringify(d.period.range) === JSON.stringify(option),
      ) as DashboardData;
      expect(data, JSON.stringify(option)).toBeDefined();
      checkDashboard(
        data,
        explorer.blocks,
        { rows, range: option, horizon, anchors: ANCHORS, grainDefault: grainDefault() },
        diff,
      );
    }
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
    expect(diff.cells).toBeGreaterThan(3000);
  });
});

describe("custom ranges through customRangeDashboard match the oracle", () => {
  it.each(Object.entries(EDGES))("%s", (_, w) => {
    const diff = record(checkCustom(w, new Diff()));
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });

  it("200 seeded random ranges", () => {
    const diff = new Diff();
    for (const w of randomRanges(200, payload.custom?.span as { start: string; end: string }, 1823))
      checkCustom(w, diff);
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
    expect(diff.cells).toBeGreaterThan(20_000);
  });

  it("a custom range equal to a preset's dates draws the same series, and the same KPIs and tables when their ended windows agree", () => {
    const diff = new Diff();
    for (const [key, preset] of Object.entries(payload.presets)) {
      const span = preset.period.current as { start: string; end: string };
      const data = custom([span.start, span.end]);
      // KPI and table windows end at the horizon by range kind (RFC 0001 section 6.4): a sliding
      // last N or a calendar comparison can differ from the explicit range of the same dates. The
      // runtime shows the preset itself for those dates, so only the series always have to agree.
      const windowsOf = (d: DashboardData) =>
        JSON.stringify(
          d.blocks.filter((b) => b.type === "kpi").map((b) => [b.current, b.previous]),
        );
      const same = windowsOf(data) === windowsOf(preset);
      const strip = (d: DashboardData): unknown => ({
        ...d,
        period: { ...d.period, range: undefined, previous: undefined },
        blocks: same
          ? d.blocks
          : d.blocks.flatMap((b) =>
              b.type === "kpi"
                ? [{ id: b.id, sparkline: b.sparkline } as unknown]
                : b.type === "line"
                  ? [b as unknown]
                  : [],
            ),
      });
      compareData(
        strip(data),
        strip(preset),
        new Set(["periodFilter", "presetOnly"]),
        new Set(),
        diff,
        key,
      );
    }
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });

  it("a URL key round-trips to the same range (last day included)", () => {
    expect(parseDaysKey("2026-03-01..2026-05-15")).toEqual({
      start: "2026-03-01",
      end: "2026-05-16",
    });
    expect(parseDaysKey("2026-10-31..2026-10-31")).toEqual({
      start: "2026-10-31",
      end: "2026-11-01",
    });
  });
});

describe("custom ranges: the browser path equals runDashboard's SQL path with the same binding", () => {
  it("edges and 25 random ranges: every block but count_distinct is equal, and SQL's count_distinct matches the oracle", async () => {
    const { project } = await loadAt(root);
    const config = project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.json");
    const executor = await createDuckDbExecutor({ root, config });
    const diff = new Diff();
    try {
      const ranges = [
        ...Object.values(EDGES),
        ...randomRanges(25, payload.custom?.span as { start: string; end: string }, 46),
      ];
      for (const w of ranges) {
        const binding = { start: w[0], end: w[1] } as unknown as RangeSpec;
        const sql = await runDashboard(project, "explorer", executor, undefined, {
          period: binding,
        });
        expect(sql.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        const browser = custom(w);
        compareData(
          browser,
          sql.data,
          new Set(["periodFilter", "presetOnly"]),
          new Set(["customers"]),
          diff,
          `${w}`,
        );
        checkDashboard(
          sql.data as DashboardData,
          explorer.blocks,
          {
            rows,
            range: { start: w[0], end: w[1] },
            horizon,
            anchors: ANCHORS,
            grainDefault: grainDefault(),
          },
          diff,
        );
      }
    } finally {
      await executor.close();
    }
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });
});
