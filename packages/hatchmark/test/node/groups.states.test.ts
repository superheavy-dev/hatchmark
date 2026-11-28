import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BarData, DashboardData, LineData } from "../../src/compiler/index.js";
import { DEFAULT_THEME, seriesPaints } from "../../src/render/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { buildProject, metric, removeProjects, run, writeProject } from "./fixture.js";

const CSV = [
  "time,region,channel,va,vb,vc",
  "2026-05-05,West,G1,1000000000000000,0.0625,0.0625",
  "2026-05-06,West,G2,0,0,0",
  "2026-05-06,West,U,9,0,0",
  "2026-05-06,West,V,3,0,0",
  "2026-05-06,West,W,1,0,0",
  "2026-06-06,East,U,2,0,0",
  "2026-06-06,East,G1,0,0,0",
  "2026-06-06,East,V,8,0,0",
  "2026-06-06,East,W,5,0,0",
  "2026-06-07,East,,1,0,0",
  "2026-06-07,East,(empty),4,0,0",
].join("\n");

const METRICS = Object.fromEntries(
  ["a", "b", "c"].map((m) => [
    m,
    metric({
      label: m,
      type: "aggregate",
      table: "orders",
      time: "time",
      aggregate: "sum",
      column: `v${m}`,
    }),
  ]),
);
const stack = { metrics: ["a", "b", "c"], by: "channel", stack: "percent" };
const split = { type: "line", grain: "month", split: "channel", metrics: ["a"] };
const blocks = [
  { type: "bar", id: "plain", ...stack },
  { type: "bar", id: "grouped", ...stack, groups: [{ label: "Pair", series: ["b", "c", "a"] }] },
  { type: "area", id: "area_plain", grain: "month", metrics: ["a", "b", "c"], stack: "percent" },
  {
    type: "area",
    id: "area_grouped",
    grain: "month",
    metrics: ["a", "b", "c"],
    stack: "percent",
    groups: [{ label: "Pair", series: ["b", "c", "a"] }],
  },
  { ...split, id: "partial", groups: [{ label: "Pair", series: ["G1", "G2"] }] },
  { ...split, id: "absent", groups: [{ label: "Pair", series: ["G9", "G8"] }] },
  { ...split, id: "empty", groups: [{ label: "Blank", series: ["U", "(empty)"] }] },
];
const dashboard = (range: { start: string; end: string }, region?: string) => ({
  title: "Review",
  period: { asOf: "2026-06-30", range, compare: "none" },
  ...(region
    ? { filters: [{ type: "select", id: "region", column: "region", default: region }] }
    : {}),
  blocks,
});
const MAY = { start: "2026-05-01", end: "2026-06-01" };
const JUNE = { start: "2026-06-01", end: "2026-07-01" };
const ALL = { start: "2026-05-01", end: "2026-07-01" };

let project: Awaited<ReturnType<typeof writeProject>>;
const data: Record<string, DashboardData | undefined> = {};
const problems: Record<string, unknown[]> = {};
const warnings: Record<string, { code: string; message: string; pointer?: string }[]> = {};

function block<T>(name: string, id: string): T {
  const found = data[name]?.blocks.find((b) => b.id === id);
  if (found === undefined)
    throw new Error(`no block ${id} in ${name}: ${JSON.stringify(problems[name])}`);
  return found as T;
}

beforeAll(async () => {
  project = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Review",
      timezone: "UTC",
      sources: { orders: { type: "csv", path: "data/orders.csv" } },
    },
    "data/orders.csv": `${CSV}\n`,
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.yaml`, m])),
    "dashboards/all.yaml": dashboard(ALL),
    "dashboards/may.yaml": dashboard(MAY),
    "dashboards/june.yaml": dashboard(JUNE),
    "dashboards/west.yaml": dashboard(ALL, "West"),
    "dashboards/east.yaml": dashboard(ALL, "East"),
  });
  for (const name of ["all", "may", "june", "west", "east"]) {
    const result = await run(project.root, project.project, name);
    data[name] = result.data;
    problems[name] = result.diagnostics.filter((d) => d.severity === "error");
    warnings[name] = result.diagnostics.filter((d) => d.code === "HM2027");
  }
});
afterAll(removeProjects);

const slots = (b: LineData | BarData) => {
  const paints = seriesPaints(DEFAULT_THEME, b.series, b.groups?.length);
  return Object.fromEntries(b.series.map((s, k) => [s.label, paints[k]?.stroke]));
};

describe("series groups across periods, filters and stacks", () => {
  it("never changes a multi-metric 100% stack's totals or shares, bar or area", () => {
    for (const [plain, grouped] of [
      ["plain", "grouped"],
      ["area_plain", "area_grouped"],
    ] as const) {
      const p = block<BarData | LineData>("all", plain);
      const g = block<BarData | LineData>("all", grouped);
      expect(g.totals).toEqual(p.totals);
      expect(g.series.map((s) => s.key)).toEqual(["b", "c", "a"]);
      for (const s of g.series) {
        const twin = p.series.find((t) => t.key === s.key);
        expect(s.values).toEqual(twin?.values);
        expect(s.share).toEqual(twin?.share);
      }
    }
    const total = block<BarData>("all", "grouped").totals?.[0];
    expect(total).toBe(1e15 + 0.0625 + 0.0625);
  });

  it("keeps every ungrouped split value's colour across periods", () => {
    const states = ["may", "june", "all"].map((name) => slots(block<LineData>(name, "partial")));
    for (const label of ["U", "V", "W"]) {
      const seen = new Set(states.map((s) => s[label]).filter((v) => v !== undefined));
      expect(seen.size, label).toBe(1);
    }
    const ranks = ["may", "june"].map((name) =>
      block<LineData>(name, "partial")
        .series.map((s) => s.label)
        .filter((l) => l === "U" || l === "V"),
    );
    expect(ranks[0]).not.toEqual(ranks[1]);
  });

  it("holds a declared group's family even when none of its series draw", () => {
    for (const name of ["may", "june", "all"]) {
      const colours = Object.values(slots(block<LineData>(name, "absent")));
      const blue = DEFAULT_THEME.groups?.families[0]?.slots ?? [];
      for (const c of colours) expect(blue.map((n) => `c${n}`)).not.toContain(c);
    }
  });

  it("tags only the null value for (empty), never a literal (empty) as well", () => {
    const b = block<LineData>("june", "empty");
    const tagged = b.series.filter((s) => s.group !== undefined);
    expect(tagged.map((s) => [s.splitValue, s.group?.step])).toEqual([
      ["U", 0],
      [null, 1],
    ]);
    expect(b.series.filter((s) => s.label === "(empty)")).toHaveLength(2);
    expect(warnings.june?.filter((w) => w.pointer?.startsWith("/blocks/6"))).toMatchObject([
      {
        pointer: "/blocks/6/groups/0/series/1",
        message:
          'group "Blank" names "(empty)", which matches both empty values and the text "(empty)" in "channel"; the group takes the empty values',
      },
    ]);
  });

  it("never puts a value the page's filters exclude into its HTML", async () => {
    const period = { start: "2026-05-01", end: "2026-07-01" };
    const scoped = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "Scope",
        timezone: "UTC",
        sources: { orders: { type: "csv", path: "data/orders.csv" } },
      },
      "data/orders.csv": [
        "time,region,channel,amount",
        "2026-05-06,West,Direct,10",
        "2026-06-07,West,Marketplace,20",
        "2026-06-08,West,Partners,30",
        "2026-06-09,East,EastOnlyChannel,987654321",
        "",
      ].join("\n"),
      "metrics/revenue.yaml": metric({
        label: "Revenue",
        type: "aggregate",
        table: "orders",
        time: "time",
        aggregate: "sum",
        column: "amount",
      }),
      ...Object.fromEntries(
        [false, true].map((grouped) => [
          `dashboards/${grouped ? "grouped" : "plain"}.yaml`,
          {
            title: "Scope",
            period: { asOf: "2026-06-30", range: period, compare: "none" },
            filters: [
              { type: "select", id: "region", column: "region", default: "West" },
              { type: "period", id: "dates", options: [period, "last_30_days"], default: period },
            ],
            blocks: [
              {
                type: "line",
                id: "revenue",
                grain: "month",
                split: "channel",
                metrics: ["revenue"],
                ...(grouped
                  ? { groups: [{ label: "Owned", series: ["Direct", "Marketplace"] }] }
                  : {}),
              },
            ],
          },
        ]),
      ),
    });
    expect((await buildProject(scoped.root)).code).toBe(0);
    for (const name of ["plain", "grouped"]) {
      const html = await readFile(path.join(scoped.root, "dist", name, "index.html"), "utf8");
      expect(html, name).toContain("Partners");
      expect(html, name).not.toContain("EastOnlyChannel");
      expect(html, name).not.toContain("987654321");
    }
    const grouped = await readFile(path.join(scoped.root, "dist", "grouped", "index.html"), "utf8");
    const payload = JSON.parse(
      grouped.match(/<script type="application\/json" data-hm-periods>(.*?)<\/script>/s)?.[1] ??
        "{}",
    );
    const domainRows = Object.values(
      payload.custom.queries as Record<string, { result?: { rows: unknown[][] } }>,
    ).flatMap((q) => q.result?.rows ?? []);
    expect(domainRows.length).toBeGreaterThan(0);
    for (const row of domainRows) expect(row.slice(1).every((v) => v === null)).toBe(true);
  });

  it("warns about a split value only when no period has rows for it under the page's filters", () => {
    const missing = (name: string) =>
      warnings[name]?.map((w) => w.message).filter((m) => m.includes("no rows"));
    const absent = [
      'group "Pair" names "G9", which "channel" has no rows for',
      'group "Pair" names "G8", which "channel" has no rows for',
    ];
    for (const name of ["may", "june", "all"]) expect(missing(name), name).toEqual(absent);
    expect(missing("west")).toEqual([
      ...absent,
      'group "Blank" names "(empty)", which "channel" has no rows for',
    ]);
    expect(missing("east")).toEqual([
      'group "Pair" names "G2", which "channel" has no rows for',
      ...absent,
    ]);
  });
});
