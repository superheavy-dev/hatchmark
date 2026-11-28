import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DashboardData,
  GrainSwitch,
  KpiData,
  Series,
} from "../../src/compiler/dashboard-data.js";
import { planDashboard, planHash } from "../../src/compiler/index.js";
import { checkReferences, parseDiagnostics } from "../../src/spec/index.js";
import { fromYaml } from "../yaml.js";
import {
  buildProject,
  EXAMPLE,
  loadAt,
  Oracle,
  removeProjects,
  run,
  writeExample,
} from "./fixture.js";

type Row = {
  d: string;
  region: string;
  channel: string;
  country: string;
  status: string;
  c: string;
  a: number;
};
type GrainSpec = string | { unit: string; anchor?: string };
type Resolved = { unit: string; anchor?: string };
type Anchors = { week: string; quarter: string; year: string };
type Where = (r: Row) => boolean;
type SpecBlock = {
  type: string;
  id: string;
  metric?: string;
  metrics?: string[];
  grain?: GrainSpec;
  grains?: GrainSpec[];
  split?: string;
  [key: string]: unknown;
};
type SwitchBlock = {
  id: string;
  type: string;
  axis?: unknown;
  series?: Series[];
  grains?: GrainSwitch;
};

let raw: Row[] = [];

beforeAll(async () => {
  const oracle = await Oracle.open();
  try {
    const file = path.join(EXAMPLE, "data/orders.csv").replaceAll("'", "''");
    raw = (await oracle.rows(
      `SELECT strftime(CAST(ordered_at AT TIME ZONE 'America/New_York' AS DATE), '%Y-%m-%d') AS d, region, channel, country, status, customer_id AS c, CAST(amount AS DOUBLE) AS a FROM read_csv('${file}')`,
    )) as Row[];
  } finally {
    oracle.close();
  }
});
afterAll(removeProjects);

const DAYS_FROM_SUNDAY = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
function addMonths(y: number, m: number, dd: number): number {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(y, m, 1);
  const last = new Date(Date.UTC(2000, 0, 1));
  last.setUTCFullYear(y, m + 1, 0);
  t.setUTCDate(Math.min(dd, last.getUTCDate()));
  return t.getTime();
}
function bucket(d: string, g: Resolved): string {
  const t = ms(d);
  if (g.unit === "day") return d;
  if (g.unit === "week") {
    const back = (new Date(t).getUTCDay() - DAYS_FROM_SUNDAY.indexOf(g.anchor as string) + 7) % 7;
    return iso(t - back * 86_400_000);
  }
  if (g.unit === "month") return `${d.slice(0, 8)}01`;
  const step = g.unit === "quarter" ? 3 : 12;
  const [am = 1, ad = 1] = (g.anchor as string).split("-").map(Number);
  const y = Number(d.slice(0, 4));
  let best = -Infinity;
  for (let yy = y - 1; yy <= y; yy++) {
    for (let k = 0; k < 12; k += step) {
      const s = addMonths(yy, am - 1 + k, ad);
      if (s <= t && s > best) best = s;
    }
  }
  return iso(best);
}
const paid = (rs: Row[]) => rs.filter((r) => r.status === "paid");
const METRICS: Record<string, (rs: Row[]) => number | null> = {
  revenue: (rs) => paid(rs).reduce((s, r) => s + r.a, 0),
  orders: (rs) => paid(rs).length,
  customers: (rs) => new Set(paid(rs).map((r) => r.c)).size,
  avg_order_value: (rs) => {
    const p = paid(rs);
    return p.length ? p.reduce((s, r) => s + r.a, 0) / p.length : null;
  },
  refund_rate: (rs) =>
    rs.length ? rs.filter((r) => r.status === "refunded").length / rs.length : null,
};
const inWindow = (w: [string, string], where: Where) =>
  raw.filter((r) => r.d >= w[0] && r.d < w[1] && where(r));
const oracleTotal = (metric: string, w: [string, string], where: Where) =>
  (METRICS[metric] as (rs: Row[]) => number | null)(inWindow(w, where));
const num = (v: number | null | undefined) => v ?? 0;
const resolve = (g: GrainSpec | undefined, anchors: Anchors): Resolved => {
  const unit = typeof g === "string" ? g : (g?.unit ?? "month");
  const anchor = typeof g === "string" ? undefined : g?.anchor;
  return unit === "day" || unit === "month"
    ? { unit }
    : { unit, anchor: anchor ?? anchors[unit as keyof Anchors] };
};
const key = (g: Resolved) => (g.anchor ? `${g.unit}:${g.anchor}` : g.unit);

function compareBlocks(
  data: DashboardData,
  specBlocks: SpecBlock[],
  anchors: Anchors,
  window: [string, string],
  where: Where,
  filterDefault: GrainSpec | undefined,
): { cells: number; problems: string[] } {
  const problems: string[] = [];
  let cells = 0;
  for (const sb of specBlocks.filter((b) => b.grains)) {
    const b = (data.blocks as unknown as SwitchBlock[]).find((x) => x.id === sb.id);
    const grains = sb.grains as GrainSpec[];
    if (b?.grains === undefined) {
      problems.push(`${sb.id}: no grains`);
      continue;
    }
    const wantKeys = grains.map((g) => key(resolve(g, anchors)));
    const gotKeys = b.grains.options.map((o) => o.key);
    if (JSON.stringify(gotKeys) !== JSON.stringify(wantKeys))
      problems.push(`${sb.id}: option keys ${gotKeys} != ${wantKeys}`);
    const own = key(resolve(sb.grain, anchors));
    const fd = filterDefault === undefined ? undefined : key(resolve(filterDefault, anchors));
    const wantSelected = fd !== undefined && wantKeys.includes(fd) ? fd : own;
    if (b.grains.selected !== wantSelected)
      problems.push(`${sb.id}: selected ${b.grains.selected} != ${wantSelected}`);
    const shown = b.grains.options.find((o) => o.key === b.grains?.selected);
    if (
      JSON.stringify(shown?.axis) !== JSON.stringify(b.axis) ||
      JSON.stringify(shown?.series) !== JSON.stringify(b.series)
    ) {
      problems.push(`${sb.id}: top-level axis or series differ from the selected option`);
    }
    for (const [i, o] of b.grains.options.entries()) {
      const g = resolve(grains[i], anchors);
      const snapped: [string, string] = [bucket(window[0], g), window[1]];
      const rows = inWindow(snapped, where);
      const buckets = (o.axis as { buckets: string[] }).buckets;
      const want = [...new Set(rows.map((r) => bucket(r.d, g)))].sort();
      const missing = want.filter((w) => !buckets.includes(w));
      const bogus = buckets.filter((x) => bucket(x, g) !== x);
      if (missing.length || bogus.length)
        problems.push(
          `${sb.id} ${o.key}: axis missing ${missing.slice(0, 3)} bogus ${bogus.slice(0, 3)}`,
        );
      const byBucket = new Map<string, Row[]>();
      for (const r of rows) {
        const k = bucket(r.d, g);
        byBucket.set(k, [...(byBucket.get(k) ?? []), r]);
      }
      for (const s of o.series) {
        const metric = s.metric ?? ((sb.metrics as string[])[0] as string);
        s.values.forEach((v, j) => {
          cells++;
          const inBucket = (byBucket.get(buckets[j] as string) ?? []).filter(
            (r) => sb.split === undefined || r[sb.split as keyof Row] === s.splitValue,
          );
          const w = (METRICS[metric] as (rs: Row[]) => number | null)(inBucket);
          if (Math.abs(num(v) - num(w)) > 1e-6)
            problems.push(`${sb.id} ${o.key} ${s.label} ${buckets[j]}: got ${v} want ${w}`);
        });
      }
      const metrics = sb.metrics as string[];
      if (metrics.length === 1 && (metrics[0] === "revenue" || metrics[0] === "orders")) {
        const total = o.series.flatMap((s) => s.values).reduce<number>((a, v) => a + num(v), 0);
        const w = num(oracleTotal(metrics[0], snapped, where));
        if (Math.abs(total - w) > 1e-6)
          problems.push(`${sb.id} ${o.key}: total ${total} want ${w}`);
      }
    }
  }
  return { cells, problems };
}

async function errorsAndData(root: string, name: string) {
  const { project, diagnostics } = await loadAt(root);
  const all = [...diagnostics, ...parseDiagnostics(project), ...checkReferences(project)];
  const errors = all.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.pointer}`);
  if (errors.length) return { errors };
  const { data, diagnostics: runDiagnostics } = await run(root, project, name);
  return { errors: runDiagnostics.filter((d) => d.severity === "error").map((d) => d.code), data };
}

const WINDOW: [string, string] = ["2025-01-01", "2026-10-01"];
const PREVIOUS: [string, string] = ["2024-01-01", "2025-10-01"];
const period = {
  asOf: "latest_data",
  range: { start: WINDOW[0], end: WINDOW[1] },
  compare: "previous_year",
};
const blocks = (c: { w2: string; q2: string; y2: string }): SpecBlock[] => [
  { type: "kpi", id: "k_rev", metric: "revenue", sparkline: true },
  { type: "kpi", id: "k_aov", metric: "avg_order_value" },
  { type: "kpi", id: "k_cust", metric: "customers" },
  {
    type: "line",
    id: "rev_region",
    metrics: ["revenue"],
    grain: "month",
    grains: ["week", "month", "quarter", "year"],
    split: "region",
  },
  {
    type: "line",
    id: "aov",
    metrics: ["avg_order_value"],
    grain: "week",
    grains: [
      "day",
      "week",
      { unit: "week", anchor: c.w2 },
      "month",
      "quarter",
      { unit: "quarter", anchor: c.q2 },
    ],
  },
  {
    type: "line",
    id: "cust",
    metrics: ["customers"],
    grain: "quarter",
    grains: ["week", "month", "quarter", "year", { unit: "year", anchor: c.y2 }],
  },
  {
    type: "line",
    id: "multi",
    metrics: ["revenue", "orders"],
    grain: "month",
    grains: ["month", "quarter"],
  },
  {
    type: "bar",
    id: "orders_ch",
    metrics: ["orders"],
    grain: "month",
    grains: ["month", "quarter", "year"],
    split: "channel",
    stack: true,
  },
  {
    type: "bar",
    id: "refund",
    metrics: ["refund_rate"],
    grain: "quarter",
    grains: ["month", "quarter"],
  },
  {
    type: "area",
    id: "rev_ch",
    metrics: ["revenue"],
    grain: "week",
    grains: ["week", "month"],
    split: "channel",
    stack: true,
  },
];
const CONFIGS = {
  "default anchors (week sunday)": {
    cfg: {},
    anchors: { week: "sunday", quarter: "01-01", year: "01-01" },
    w2: "monday",
    q2: "02-01",
    y2: "07-01",
  },
  "anchors week wednesday, quarter 02-15, year 08-15": {
    cfg: { weekStart: undefined, anchors: { week: "wednesday", quarter: "02-15", year: "08-15" } },
    anchors: { week: "wednesday", quarter: "02-15", year: "08-15" },
    w2: "sunday",
    q2: "01-01",
    y2: "01-01",
  },
};
const KPI_METRIC: Record<string, string> = {
  k_rev: "revenue",
  k_aov: "avg_order_value",
  k_cust: "customers",
};
const kpis = (d: DashboardData) =>
  (d.blocks.filter((b) => b.type === "kpi") as KpiData[]).map(
    ({ id, value, previousValue, change, changePct, sparkline }) => ({
      id,
      value,
      previousValue,
      change,
      changePct,
      sparkline,
    }),
  );

describe.each(Object.entries(CONFIGS))("grain switching numbers at %s", (_, c) => {
  const bl = blocks(c);
  let g: Awaited<ReturnType<typeof errorsAndData>>;
  let n: Awaited<ReturnType<typeof errorsAndData>>;
  beforeAll(async () => {
    const withFilter = {
      title: "G",
      period,
      filters: [
        { type: "grain", id: "g", options: ["week", "month", "quarter"], default: "quarter" },
      ],
      blocks: bl,
    };
    const noGrains = { title: "N", period, blocks: bl.map(({ grains: _g, ...b }) => b) };
    const root = await writeExample(c.cfg, { g: withFilter, n: noGrains });
    [g, n] = await Promise.all([errorsAndData(root, "g"), errorsAndData(root, "n")]);
  });

  it("every grain option's buckets and values match the oracle, for sums, ratios, count_distinct and splits", () => {
    expect(g.errors).toEqual([]);
    const { cells, problems } = compareBlocks(
      g.data as DashboardData,
      bl,
      c.anchors,
      WINDOW,
      () => true,
      "quarter",
    );
    expect(problems.slice(0, 5)).toEqual([]);
    expect(cells).toBeGreaterThan(2000);
  });

  it("KPIs are identical with and without grains, and equal the oracle for the period and the year before", () => {
    const withGrains = kpis(g.data as DashboardData);
    expect(withGrains).toEqual(kpis(n.data as DashboardData));
    for (const k of withGrains) {
      const metric = KPI_METRIC[k.id] as string;
      expect(num(k.value)).toBeCloseTo(num(oracleTotal(metric, WINDOW, () => true)), 6);
      expect(num(k.previousValue)).toBeCloseTo(num(oracleTotal(metric, PREVIOUS, () => true)), 6);
    }
  });

  it("each block's own-grain option equals the same block without grains", () => {
    for (const sb of bl.filter((b) => b.grains)) {
      const plain = (n.data as DashboardData).blocks.find(
        (b) => b.id === sb.id,
      ) as unknown as SwitchBlock;
      const switched = (g.data as DashboardData).blocks.find(
        (b) => b.id === sb.id,
      ) as unknown as SwitchBlock;
      const own = switched.grains?.options.find((o) => o.key === key(resolve(sb.grain, c.anchors)));
      expect({ id: sb.id, axis: own?.axis, series: own?.series }).toEqual({
        id: sb.id,
        axis: plain.axis,
        series: plain.series,
      });
    }
  });
});

describe("a select, a period and a grain filter combined", () => {
  it("every grain option and the KPI match the oracle over the period filter's default and the selected regions", async () => {
    const c = CONFIGS["default anchors (week sunday)"];
    const bl = blocks(c).filter((b) => b.type !== "kpi");
    const root = await writeExample(
      {},
      {
        f: {
          title: "F",
          period: {
            asOf: "latest_data",
            range: { start: "2025-01-01", end: "2025-07-01" },
            compare: "previous_period",
          },
          filters: [
            {
              type: "select",
              id: "region",
              column: "region",
              multiple: true,
              default: ["EMEA", "APAC"],
            },
            {
              type: "period",
              id: "p",
              options: ["last_30_days", "last_12_months"],
              default: "last_12_months",
            },
            {
              type: "grain",
              id: "g",
              options: ["week", "month", "quarter", "year"],
              default: "week",
            },
          ],
          blocks: [{ type: "kpi", id: "k_rev", metric: "revenue" }, ...bl],
        },
      },
    );
    const r = await errorsAndData(root, "f");
    expect(r.errors).toEqual([]);
    const data = r.data as DashboardData;
    const current = data.period.current as { start: string; end: string };
    expect(current).toEqual({ start: "2025-11-01", end: "2026-11-01" });
    const window: [string, string] = [current.start, current.end];
    const where: Where = (x) => x.region === "EMEA" || x.region === "APAC";
    const { cells, problems } = compareBlocks(data, bl, c.anchors, window, where, "week");
    expect(problems.slice(0, 5)).toEqual([]);
    expect(cells).toBeGreaterThan(1000);
    const k = data.blocks.find((b) => b.id === "k_rev") as KpiData;
    const days: [string, string] = ["2025-10-31", "2026-10-31"];
    expect(k.current).toEqual({ start: days[0], end: days[1] });
    expect(num(k.value)).toBeCloseTo(num(oracleTotal("revenue", days, where)), 6);
  });
});

const lineB = (extra: Record<string, unknown>) => ({
  type: "line",
  id: "l",
  metrics: ["revenue"],
  grain: "month",
  ...extra,
});
const dash = (blocksList: unknown[], filters?: unknown[]) => ({
  title: "V",
  period: { asOf: "latest_data", range: "last_12_months", compare: "none" },
  ...(filters ? { filters } : {}),
  blocks: blocksList,
});

function controls(html: string) {
  const groups = [...html.matchAll(/<div class="hm-seg"([^>]*)>(.*?)<\/div>/g)].map((m) =>
    [...(m[2] as string).matchAll(/data-hm-grain="([^"]+)">([^<]*)</g)].map(
      (x) => `${x[1]}=${x[2]}`,
    ),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const duplicateIds = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  const visible = [...html.matchAll(/class="hm-grain-panel" data-hm-grain="([^"]+)"( hidden)?/g)]
    .filter((m) => !m[2])
    .map((m) => m[1]);
  return { groups, duplicateIds, visiblePanelsAtLoad: visible };
}

describe("check rejects duplicate and misplaced grains, and builds the rest", () => {
  const sameAs = (pointer: string) => [`HM3007 ${pointer}`];
  it.each([
    [
      "grains [week, {week, anchor: sunday}] at week start sunday",
      {},
      dash([
        lineB({ grain: "week", grains: ["week", { unit: "week", anchor: "sunday" }, "month"] }),
      ]),
      sameAs("/blocks/0/grains/1"),
    ],
    [
      "grains [quarter, {quarter, anchor: 01-01}] at default anchors",
      {},
      dash([lineB({ grains: ["month", "quarter", { unit: "quarter", anchor: "01-01" }] })]),
      sameAs("/blocks/0/grains/2"),
    ],
    [
      "filter options [week, {week, anchor: sunday}]",
      {},
      dash(
        [lineB({ grains: ["week", "month"] })],
        [
          {
            type: "grain",
            id: "g",
            options: ["week", { unit: "week", anchor: "sunday" }, "month"],
            default: "month",
          },
        ],
      ),
      sameAs("/filters/0/options/1"),
    ],
    [
      "anchors.week monday with grains [week, {week, anchor: monday}]",
      { weekStart: undefined, anchors: { week: "monday" } },
      dash([lineB({ grains: ["week", { unit: "week", anchor: "monday" }, "month"] })]),
      sameAs("/blocks/0/grains/1"),
    ],
    [
      "anchors.year 07-01 (quarter follows) with grains [quarter, {quarter, anchor: 07-01}]",
      { anchors: { year: "07-01" } },
      dash([lineB({ grains: ["month", "quarter", { unit: "quarter", anchor: "07-01" }] })]),
      sameAs("/blocks/0/grains/2"),
    ],
    [
      "block ids a and a-month",
      {},
      dash([
        lineB({ id: "a", grains: ["month", "quarter"] }),
        { type: "line", id: "a-month", metrics: ["orders"], grain: "month" },
      ]),
      ["HM3005 /blocks/1/id"],
    ],
    [
      "grains with 7 entries",
      {},
      dash([
        lineB({
          grains: [
            "day",
            "week",
            "month",
            "quarter",
            "year",
            { unit: "week", anchor: "monday" },
            { unit: "year", anchor: "07-01" },
          ],
        }),
      ]),
      ["HM3005 /blocks/0/grains"],
    ],
    [
      "grains on a bar by a column",
      {},
      dash([
        { type: "bar", id: "b", metrics: ["revenue"], by: "region", grains: ["month", "quarter"] },
      ]),
      ["HM3007 /blocks/0/grains"],
    ],
    [
      "grains on a table",
      {},
      dash([
        {
          type: "table",
          id: "t",
          metrics: ["revenue"],
          by: ["region"],
          grains: ["month", "quarter"],
        },
      ]),
      ["HM3002 /blocks/0/grains"],
    ],
    [
      "grains on a kpi",
      {},
      dash([{ type: "kpi", id: "k", metric: "revenue", grains: ["month", "quarter"] }]),
      ["HM3002 /blocks/0/grains"],
    ],
    [
      "month with an anchor in grains",
      {},
      dash([lineB({ grains: ["month", { unit: "month", anchor: "01-15" }] })]),
      ["HM3007 /blocks/0/grains/1/anchor"],
    ],
  ] as [string, Record<string, unknown>, unknown, string[]][])("%s", async (_, cfg, d, errors) => {
    expect((await errorsAndData(await writeExample(cfg, { v: d }), "v")).errors).toEqual(errors);
  });

  it.each([
    [
      "grain week with grains [{week, anchor: sunday}, month] renders one Week",
      {},
      dash([lineB({ grain: "week", grains: [{ unit: "week", anchor: "sunday" }, "month"] })]),
      { groups: [["week:sunday=Week", "month=Month"]], visiblePanelsAtLoad: ["week:sunday"] },
    ],
    [
      "grain {week, anchor: sunday} with grains [week, month] renders one Week",
      {},
      dash([lineB({ grain: { unit: "week", anchor: "sunday" }, grains: ["week", "month"] })]),
      { groups: [["week:sunday=Week", "month=Month"]], visiblePanelsAtLoad: ["week:sunday"] },
    ],
    [
      "filter default {week, anchor: sunday} with options [week, month] selects Week",
      {},
      dash(
        [lineB({ grains: ["week", "month"] })],
        [
          {
            type: "grain",
            id: "g",
            options: ["week", "month"],
            default: { unit: "week", anchor: "sunday" },
          },
        ],
      ),
      {
        groups: [
          ["week:sunday=Week", "month=Month"],
          ["week:sunday=Week", "month=Month"],
        ],
        visiblePanelsAtLoad: ["week:sunday"],
      },
    ],
    [
      "a grain filter with no block listing grains renders the filter alone",
      {},
      dash([lineB({})], [{ type: "grain", id: "g", options: ["week", "month"], default: "week" }]),
      { groups: [["week:sunday=Week", "month=Month"]], visiblePanelsAtLoad: [] },
    ],
    [
      "filter options no block lists (day, year) leave the block at its own grain",
      {},
      dash(
        [lineB({ grains: ["month", "quarter"] })],
        [{ type: "grain", id: "g", options: ["day", "year"], default: "day" }],
      ),
      {
        groups: [
          ["day=Day", "year:01-01=Year"],
          ["month=Month", "quarter:01-01=Quarter"],
        ],
        visiblePanelsAtLoad: ["month"],
      },
    ],
    [
      "anchors.year 07-01 with grains [quarter, {quarter, anchor: 01-01}] names both quarters",
      { anchors: { year: "07-01" } },
      dash([lineB({ grains: ["month", "quarter", { unit: "quarter", anchor: "01-01" }] })]),
      {
        groups: [
          ["month=Month", "quarter:07-01=Quarter from Jul 1", "quarter:01-01=Quarter from Jan 1"],
        ],
        visiblePanelsAtLoad: ["month"],
      },
    ],
    [
      "grains [month, quarter] (control)",
      {},
      dash([lineB({ grains: ["month", "quarter"] })]),
      { groups: [["month=Month", "quarter:01-01=Quarter"]], visiblePanelsAtLoad: ["month"] },
    ],
  ] as [string, Record<string, unknown>, unknown, ReturnType<typeof controls>][])(
    "%s, with unique ids",
    async (_, cfg, d, want) => {
      const root = await writeExample(cfg, { v: d });
      expect((await errorsAndData(root, "v")).errors).toEqual([]);
      expect((await buildProject(root)).code).toBe(0);
      const html = await readFile(path.join(root, "dist/v/index.html"), "utf8");
      expect(controls(html)).toEqual({ ...want, duplicateIds: [] });
    },
  );
});

describe("plan hashes and query reuse for grain switches", () => {
  const hashOf = async (cfg: Record<string, unknown>, d: unknown) => {
    const { project } = await loadAt(await writeExample(cfg, { h: d }));
    const { plan } = planDashboard(project, "h");
    if (plan === undefined) throw new Error("no plan");
    return planHash(plan);
  };

  it("spelling week, {unit: week} or {unit: week, anchor: sunday} gives one plan hash", async () => {
    const hashes = await Promise.all(
      ["week", { unit: "week" }, { unit: "week", anchor: "sunday" }].map((w) =>
        hashOf({}, dash([lineB({ grains: [w, "month"] })])),
      ),
    );
    expect(new Set(hashes).size).toBe(1);
  });

  it("a grain filter's label does not change the plan hash", async () => {
    const filter = (label: string) => [
      { type: "grain", id: "g", label, options: ["week", "month"], default: "week" },
    ];
    const [a, b] = await Promise.all(
      ["A", "B"].map((label) =>
        hashOf({}, dash([lineB({ grains: ["week", "month"] })], filter(label))),
      ),
    );
    expect(a).toBe(b);
  });

  it("blocks listing the same grains share one query per grain", async () => {
    const { project } = await loadAt(
      await writeExample(
        {},
        {
          q: dash([
            lineB({ id: "a", grains: ["week", "month", "quarter"] }),
            lineB({ id: "b", grain: "week", grains: ["week", "month", "quarter"] }),
            { type: "line", id: "c", metrics: ["revenue"], grain: "quarter" },
          ]),
        },
      ),
    );
    const plan = planDashboard(project, "q").plan;
    if (plan === undefined) throw new Error("no plan");
    const ids = plan.queries.map((q) => q.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const perBlock = Object.fromEntries(
      plan.blocks.map((b) => [b.blockId, b.grains?.map((g) => g.queryIds)]),
    );
    expect(perBlock.a).toEqual(perBlock.b);
  });

  it("the sales example plans to a pinned hash (the #16 value 036644c0…, then plan and window horizons)", async () => {
    const { project } = await loadAt(EXAMPLE);
    const { plan } = planDashboard(project, "sales");
    expect(plan && planHash(plan)).toBe(
      "34e14f763de8c6aed1506225468ef5ae79ea94aabe2b3f616aeef2bc2d449c9f",
    );
  });

  it("the plan hash changes with what a block shows: the filter default, the option order, and grains at all", async () => {
    const filter = (d: string) => [
      { type: "grain", id: "g", options: ["week", "month"], default: d },
    ];
    const [weekDefault, monthDefault, weekFirst, monthFirst, none, some] = await Promise.all([
      hashOf({}, dash([lineB({ grains: ["week", "month"] })], filter("week"))),
      hashOf({}, dash([lineB({ grains: ["week", "month"] })], filter("month"))),
      hashOf({}, dash([lineB({ grains: ["week", "month"] })])),
      hashOf({}, dash([lineB({ grains: ["month", "week"] })])),
      hashOf({}, dash([lineB({})])),
      hashOf({}, dash([lineB({ grains: ["month", "quarter"] })])),
    ]);
    expect(weekDefault).not.toBe(monthDefault);
    expect(weekFirst).not.toBe(monthFirst);
    expect(none).not.toBe(some);
  });

  it("the example dashboards plan to the same hash on every call", async () => {
    const { project } = await loadAt(EXAMPLE);
    for (const name of ["sales", "trends"]) {
      const a = planDashboard(project, name).plan;
      const b = planDashboard(project, name).plan;
      expect(a && planHash(a)).toBe(b && planHash(b));
    }
  });
});

describe("the trends example rebuilds byte for byte", () => {
  it("builds the same HTML twice, with unique ids and every switching card at month", async () => {
    const trends = fromYaml(await readFile(path.join(EXAMPLE, "dashboards/trends.yaml"), "utf8"));
    const root = await writeExample({}, { t: trends });
    expect((await buildProject(root)).code).toBe(0);
    const a = await readFile(path.join(root, "dist/t/index.html"), "utf8");
    expect((await buildProject(root)).code).toBe(0);
    const b = await readFile(path.join(root, "dist/t/index.html"), "utf8");
    expect(a === b).toBe(true);
    expect(controls(a)).toEqual({
      groups: [
        ["week:sunday=Week", "month=Month", "quarter:01-01=Quarter"],
        ["week:sunday=Week", "month=Month", "quarter:01-01=Quarter"],
        ["month=Month", "quarter:01-01=Quarter"],
        ["week:sunday=Week", "month=Month"],
      ],
      duplicateIds: [],
      visiblePanelsAtLoad: ["month", "month", "month"],
    });
  });
});
