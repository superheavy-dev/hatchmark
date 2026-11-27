// Adopted from the HAT-66 review of hatchmark#29 (the edges and incomplete options, RFC 0001 section
// 6.5): every chart value is checked against raw SQL over the same rows, written apart from the
// planner. Three sources lag differently, so hide, clip and HM4014 meet a horizon before, inside and
// after the range.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, expect, test } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { BarData, KpiData, LineData } from "../../src/compiler/index.js";
import type { Diagnostic } from "../../src/diagnostics/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);
const schema = JSON.parse(
  readFileSync(new URL("../../schema/dashboard.schema.json", import.meta.url), "utf8"),
);
const rows = [
  ["fast", "2026-09-14T12:00:00Z", 10],
  ["fast", "2026-09-16T12:00:00Z", 20],
  ["fast", "2026-09-21T12:00:00Z", 30],
  ["fast", "2026-09-28T12:00:00Z", 40],
  ["fast", "2026-10-05T12:00:00Z", 50],
  ["fast", "2026-10-12T12:00:00Z", 60],
  ["fast", "2026-10-19T12:00:00Z", 70],
  ["fast", "2026-10-26T12:00:00Z", 80],
  ["fast", "2026-10-29T12:00:00Z", 90],
  ["slow", "2026-09-14T12:00:00Z", 1],
  ["slow", "2026-09-16T12:00:00Z", 2],
  ["slow", "2026-09-21T12:00:00Z", 3],
  ["slow", "2026-09-28T12:00:00Z", 4],
  ["slow", "2026-10-05T12:00:00Z", 5],
  ["slow", "2026-10-08T12:00:00Z", 6],
  ["stale", "2026-09-14T12:00:00Z", 1],
  ["stale", "2026-09-15T12:00:00Z", 2],
] as const;
const week = { unit: "week", anchor: "monday" };
const kpi = { type: "kpi", id: "summary", metric: "slow" };
const chart = (id: string, options: Record<string, unknown> = {}) => ({
  type: "line",
  id,
  grain: week,
  metrics: ["slow"],
  ...options,
});
const dashboard = (blocks: unknown[], end = "2026-11-05") => ({
  title: "D",
  period: { asOf: end, range: { start: "2026-09-16", end }, compare: "none" },
  blocks,
});
async function build(blocks: unknown[], end?: string) {
  const keys = ["fast", "slow", "stale"] as const;
  const fixture = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Review",
      timezone: "UTC",
      sources: Object.fromEntries(keys.map((k) => [k, { type: "csv", path: k + ".csv" }])),
    },
    "dashboards/d.json": dashboard(blocks, end),
    ...Object.fromEntries(
      keys.flatMap((k) => [
        [
          k + ".csv",
          "at,v\n" +
            rows
              .filter((row) => row[0] === k)
              .map(([, t, v]) => `${t},${v}\n`)
              .join(""),
        ],
        [
          "metrics/" + k + ".json",
          metric({ type: "aggregate", table: k, aggregate: "sum", column: "v", time: "at" }),
        ],
      ]),
    ),
  });
  const result = await run(fixture.root, fixture.project, "d");
  return {
    root: fixture.root,
    result,
    diagnostics: result.diagnostics,
    block: <T extends LineData | BarData | KpiData = LineData>(id: string) => {
      const resultBlock = result.data?.blocks.find((b) => b.id === id);
      if (!resultBlock) throw new Error(`dashboard has no block ${id}`);
      return resultBlock as T;
    },
  };
}
async function sql(query: string) {
  const oracle = await Oracle.open();
  try {
    await oracle.run("CREATE TABLE raw(src VARCHAR, ts TIMESTAMPTZ, v INTEGER)");
    await oracle.run(
      "INSERT INTO raw VALUES " + rows.map(([s, t, v]) => `('${s}','${t}',${v})`).join(","),
    );
    return await oracle.rows(query);
  } finally {
    oracle.close();
  }
}

test("raw SQL distinguishes snap, clip and an exact-window KPI", async () => {
  const { block } = await build([chart("snap"), chart("clip", { edges: "clip" }), kpi]);
  const [want] = await sql(`SELECT
    sum(v) FILTER (WHERE ts >= '2026-09-14' AND ts < '2026-09-21') AS snap,
    sum(v) FILTER (WHERE ts >= '2026-09-16' AND ts < '2026-09-21') AS clip,
    sum(v) FILTER (WHERE ts >= '2026-09-16' AND ts < '2026-10-08') AS kpi
    FROM raw WHERE src='slow'`);
  expect(block("snap").axis.window.start).toBe("2026-09-14");
  expect(block("clip").axis.window.start).toBe("2026-09-16");
  expect(block("snap").series[0]?.values[0]).toBe(want?.snap);
  expect(block("clip").series[0]?.values[0]).toBe(want?.clip);
  expect(block("clip").series[0]?.partial).toContainEqual({
    index: 0,
    elapsed: 0.714285,
    edge: "start",
    days: 5,
  });
  expect(block<KpiData>("summary").value).toBe(want?.kpi);
});

test("lagging cutoff: hide ends axis at the last kept complete bucket", async () => {
  const { block } = await build([chart("hide", { incomplete: "hide" })]);
  const want = await sql(`WITH weeks(i, lo, hi) AS (VALUES
    (0, '2026-09-14', '2026-09-21'), (1, '2026-09-21', '2026-09-28'),
    (2, '2026-09-28', '2026-10-05'))
    SELECT lo, sum(v) AS v FROM weeks JOIN raw ON src='slow'
    AND ts >= lo::TIMESTAMPTZ AND ts < hi::TIMESTAMPTZ GROUP BY i, lo ORDER BY i`);
  const b = block("hide");
  expect({ buckets: b.axis.buckets, end: b.axis.window.end, values: b.series[0]?.values }).toEqual({
    buckets: want.map((r) => r.lo),
    end: "2026-10-05",
    values: want.map((r) => r.v),
  });
});

test("hide before percent stacking: an interior missing part has neither total nor share", async () => {
  const { block } = await build([
    chart("stack", {
      type: "bar",
      metrics: ["slow", "fast"],
      stack: "percent",
      incomplete: "hide",
    }),
  ]);
  const b = block<BarData>("stack");
  const [want] = await sql(`SELECT sum(v) AS total, sum(v) FILTER (WHERE src='slow') AS slow
    FROM raw WHERE ts >= '2026-09-28' AND ts < '2026-10-05'`);
  expect(b.totals?.[2]).toBe(want?.total);
  expect(b.series[0]?.share?.[2]).toBe(Number(want?.slow) / Number(want?.total));
  expect(b.axis.kind === "time" && b.axis.buckets[3]).toBe("2026-10-05");
  expect(b.series.map((s) => s.values[3])).toEqual([null, 50]);
  expect([b.totals?.[3], ...b.series.map((s) => s.share?.[3])]).toEqual([null, null, null]);
});

test("clip before stale horizon: data cannot have a negative elapsed share", async () => {
  const { block, diagnostics } = await build([
    chart("staleclip", { edges: "clip", metrics: ["stale"] }),
    chart("staleshow", { edges: "clip", metrics: ["stale"], incomplete: "show" }),
  ]);
  const [want] = await sql(`SELECT count(*) AS n FROM raw WHERE src='stale'
    AND ts >= '2026-09-16' AND ts < '2026-09-21'`);
  expect(want?.n).toBe(0);
  const b = block("staleclip");
  expect.soft(b.series[0]?.values.every((v: unknown) => v === null)).toBe(true);
  expect.soft(b.series[0]?.partial ?? []).toEqual([]);
  expect.soft(diagnostics.some((d) => d.code === "HM4014")).toBe(false);
});

test("HM4014 attaches only to a shown flow with a trailing partial", async () => {
  const { block, diagnostics } = await build([
    chart("implicit"),
    chart("explicit", { edges: "snap", incomplete: "mark" }),
    chart("show", { incomplete: "show" }),
  ]);
  expect(block("show").series[0]?.values).toEqual(block("implicit").series[0]?.values);
  expect(block("show").series[0]?.partial).toBeUndefined();
  expect(
    diagnostics.filter((d) => d.code === "HM4014").map((d) => [d.severity, d.pointer]),
  ).toEqual([["warning", "/blocks/2/incomplete"]]);
});

test("published schema rejects time options on category bars like the compiler", async () => {
  const validate = new Ajv2020({
    strict: false,
    validateSchema: false,
    validateFormats: false,
  }).compile(schema);
  expect(
    validate(dashboard([chart("x", { type: "area", edges: "clip", incomplete: "hide" })])),
  ).toBe(true);
  const c = { type: "bar", id: "c", metrics: ["slow"], by: "v", incomplete: "show", edges: "clip" };
  const { diagnostics } = await build([c]);
  expect(diagnostics.filter((d) => d.code === "HM3007").map((d) => d.pointer)).toEqual([
    "/blocks/0/edges",
    "/blocks/0/incomplete",
  ]);
  for (const value of [
    { ...c, incomplete: undefined },
    { ...c, edges: undefined },
  ])
    expect.soft(validate(dashboard([value]))).toBe(false);
});

test("all buckets hidden yields an empty axis window", async () => {
  const { block } = await build(
    [chart("allhide", { edges: "clip", incomplete: "hide" })],
    "2026-09-17",
  );
  const b = block("allhide");
  expect(b.axis.buckets).toEqual([]);
  expect(b.axis.window.start).toEqual(b.axis.window.end);
});

async function checkCli(root: string, ...args: string[]) {
  let stdout = "";
  const exit = await cli(["check", "--json", "--cwd", root, ...args], {
    stdout: (s) => {
      stdout += s;
    },
    stderr: () => {},
    cwd: root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  const payload = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as {
    diagnostics?: Diagnostic[];
  };
  return { exit, diagnostics: payload.diagnostics ?? [] };
}

test("HM4014 comes from check --sql and build; plain check stays static", async () => {
  const { root, diagnostics } = await build([chart("show", { incomplete: "show" })]);
  expect(diagnostics.some((d) => d.code === "HM4014")).toBe(true);
  expect((await checkCli(root)).diagnostics.some((d) => d.code === "HM4014")).toBe(false);
  const sql = await checkCli(root, "--sql");
  expect(sql.diagnostics.filter((d) => d.code === "HM4014").map((d) => d.pointer)).toEqual([
    "/blocks/0/incomplete",
  ]);
});
