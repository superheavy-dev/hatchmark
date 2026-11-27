import { afterAll, describe, expect, it } from "vitest";
import type { BarData, LineData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

// The edges and incomplete options of time-series blocks (RFC 0001 section 6.5). One row a day at
// noon UTC from Sep 1 to Oct 15, 2026, so last 30 days as of Oct 15 is Sep 16 to Oct 15: Sep 16 is a
// Wednesday inside the Monday week of Sep 14, and the data ends halfway through the week of Oct 12.
// Every expectation is counted here from the rows.

afterAll(removeProjects);

const DAYS: string[] = [];
for (let t = Date.UTC(2026, 8, 1, 12); t <= Date.UTC(2026, 9, 15, 12); t += 86_400_000) {
  DAYS.push(new Date(t).toISOString());
}
const WEEKS = ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
const count = (from: string, to: string) => DAYS.filter((d) => d >= from && d < to).length;

async function build(blocks: unknown[]) {
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Edges",
      timezone: "UTC",
      sources: { orders: { type: "csv", path: "orders.csv" } },
    },
    "orders.csv": `at,v\n${DAYS.map((d) => `${d},1`).join("\n")}\n`,
    "metrics/orders.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "v",
      time: "at",
    }),
    "metrics/units.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "v",
      time: "at",
    }),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "latest_data", range: "last_30_days", compare: "none" },
      blocks,
    },
  });
  const result = await run(fixture.root, fixture.project, "d");
  const block = <T>(id: string) => result.data?.blocks.find((b) => b.id === id) as T;
  return { ...result, block, codes: result.diagnostics.map((d) => [d.code, d.pointer]) };
}

const line = (id: string, options: Record<string, unknown> = {}) => ({
  type: "line",
  id,
  metrics: ["orders"],
  grain: { unit: "week", anchor: "monday" },
  ...options,
});
const weekly = (from: string) =>
  WEEKS.map((w, i) => count(i === 0 ? from : w, WEEKS[i + 1] ?? "2026-10-19"));

describe("edges", () => {
  it("snaps the window back to its first week by default, so the first week is whole", async () => {
    const { block } = await build([line("l")]);
    const l = block<LineData>("l");
    expect(l.axis.buckets).toEqual(WEEKS);
    expect(l.axis.window.start).toBe("2026-09-14");
    expect(l.series[0]?.values).toEqual(weekly("2026-09-14"));
    expect(l.series[0]?.values[0]).toBe(7);
    expect(l.series[0]?.partial).toEqual([
      { index: 4, elapsed: 0.5, days: 4, through: "2026-10-15T12:00:00" },
    ]);
  });

  it("keeps the window start with clip and marks the clipped first week", async () => {
    const { block } = await build([line("l", { edges: "clip" })]);
    const l = block<LineData>("l");
    expect(l.axis.window.start).toBe("2026-09-16");
    expect(l.series[0]?.values).toEqual(weekly("2026-09-16"));
    expect(l.series[0]?.values[0]).toBe(5);
    expect(l.series[0]?.partial).toEqual([
      { index: 0, elapsed: 0.714285, edge: "start", days: 5 },
      { index: 4, elapsed: 0.5, days: 4, through: "2026-10-15T12:00:00" },
    ]);
  });

  it("applies to time bars and is refused on category bars", async () => {
    const { block } = await build([
      {
        type: "bar",
        id: "b",
        metrics: ["orders"],
        grain: { unit: "week", anchor: "monday" },
        edges: "clip",
      },
    ]);
    expect(block<BarData>("b").series[0]?.values[0]).toBe(5);
    const refused = await build([
      { type: "bar", id: "c", metrics: ["orders"], by: "v", edges: "clip" },
    ]);
    expect(refused.data).toBeUndefined();
    expect(refused.codes).toContainEqual(["HM3007", "/blocks/0/edges"]);
  });
});

describe("incomplete", () => {
  it("hide drops the partial weeks at either edge", async () => {
    const { block, codes } = await build([
      line("h", { incomplete: "hide" }),
      line("hc", { incomplete: "hide", edges: "clip" }),
    ]);
    const h = block<LineData>("h");
    expect(h.axis.buckets).toEqual(WEEKS.slice(0, 4));
    expect(h.axis.window).toEqual({ start: "2026-09-14", end: "2026-10-12" });
    expect(h.series[0]?.values).toEqual(weekly("2026-09-14").slice(0, 4));
    expect(h.series[0]).not.toHaveProperty("partial");
    expect(block<LineData>("hc").axis.buckets).toEqual(WEEKS.slice(1, 4));
    expect(block<LineData>("hc").axis.window).toEqual({ start: "2026-09-21", end: "2026-10-12" });
    expect(codes).toEqual([]);
  });

  it("hide leaves a stack's totals and shares on the kept weeks only", async () => {
    const { block } = await build([
      {
        type: "bar",
        id: "p",
        metrics: ["orders", "units"],
        grain: { unit: "week", anchor: "monday" },
        stack: "percent",
        incomplete: "hide",
      },
    ]);
    const p = block<BarData>("p");
    expect(p.axis).toMatchObject({ buckets: WEEKS.slice(0, 4) });
    expect(p.totals).toEqual(
      weekly("2026-09-14")
        .slice(0, 4)
        .map((v) => 2 * v),
    );
    expect(p.series.map((s) => s.share)).toEqual([0, 1].map(() => [0.5, 0.5, 0.5, 0.5]));
  });

  it("show draws the partial week plainly and warns with HM4014 for a flow metric", async () => {
    const { block, codes, diagnostics } = await build([line("s", { incomplete: "show" })]);
    const s = block<LineData>("s");
    expect(s.axis.buckets).toEqual(WEEKS);
    expect(s.series[0]?.values).toEqual(weekly("2026-09-14"));
    expect(s.series[0]).not.toHaveProperty("partial");
    expect(codes).toEqual([["HM4014", "/blocks/0/incomplete"]]);
    expect(diagnostics[0]?.severity).toBe("warning");
  });

  it("mark, the default, keeps the partial week and warns about nothing", async () => {
    const { codes } = await build([line("m", { incomplete: "mark" })]);
    expect(codes).toEqual([]);
  });
});
