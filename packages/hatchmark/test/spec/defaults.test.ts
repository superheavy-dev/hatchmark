import { describe, expect, it } from "vitest";
import { explainDefaults } from "../../src/compiler/index.js";
import { createReport, renderHuman } from "../../src/diagnostics/index.js";
import { checkReferences } from "../../src/spec/index.js";
import { CONFIG, projectFrom } from "./helpers.js";

const { weekStart: _, ...noAnchors } = CONFIG;

const dashboard = (blocks: unknown[], period?: unknown) => ({
  title: "Sales",
  ...(period === undefined ? {} : { period }),
  blocks,
});

const PERIOD = { asOf: "latest_data", range: "last_12_months", compare: "none" };

function notes(
  blocks: unknown[],
  options: { period?: unknown; config?: unknown; filters?: boolean } = {},
) {
  const d = dashboard(blocks, "period" in options ? options.period : PERIOD);
  const project = projectFrom({
    config: options.config ?? CONFIG,
    dashboards: {
      d: options.filters
        ? {
            ...d,
            filters: [
              {
                type: "period",
                id: "period",
                options: ["last_30_days", "last_90_days"],
                default: "last_90_days",
              },
              { type: "grain", id: "grain", options: ["day", "week", "month"], default: "month" },
            ],
          }
        : d,
    },
  });
  expect(checkReferences(project).filter((d) => d.severity !== "note")).toEqual([]);
  return explainDefaults(project);
}

describe("check explains the defaults it applies (HM4040)", () => {
  it("names edges and incomplete on a time series, and stays quiet once either is set", () => {
    const ds = notes([{ type: "line", metrics: ["revenue"], grain: "month" }]);
    expect(ds.map((d) => [d.code, d.severity, d.file, d.pointer, d.message])).toEqual([
      [
        "HM4040",
        "note",
        "dashboards/d.yaml",
        "/blocks/0/grain",
        "uses edges: snap: the first month starts at the start of the month that holds the range start",
      ],
      [
        "HM4040",
        "note",
        "dashboards/d.yaml",
        "/blocks/0/grain",
        "uses incomplete: mark: a month the data doesn't fully cover is marked in progress",
      ],
    ]);
    expect(ds[0]?.help).toMatch(/edges: clip/);
    expect(ds[1]?.help).toMatch(/incomplete: hide/);
    expect(
      notes([
        { type: "line", metrics: ["revenue"], grain: "month", edges: "snap", incomplete: "mark" },
        { type: "area", metrics: ["revenue"], grain: "month", edges: "clip", incomplete: "hide" },
      ]),
    ).toEqual([]);
  });

  it("skips category bars, KPIs, and edges at day grain, where every bucket is whole", () => {
    const ds = notes([
      { type: "kpi", metric: "revenue" },
      { type: "bar", metrics: ["orders"], by: "plan" },
      { type: "bar", metrics: ["orders"], grain: "day" },
    ]);
    expect(ds.map((d) => [d.pointer, d.message.slice(0, 22)])).toEqual([
      ["/blocks/2/grain", "uses incomplete: mark:"],
    ]);
  });

  it("names both dates when a fixed as-of fixes the window", () => {
    const ds = notes(
      [{ type: "bar", metrics: ["orders"], grain: { unit: "week", anchor: "sunday" } }],
      {
        period: { asOf: "2026-11-27", range: "last_30_days", compare: "none" },
      },
    );
    expect(ds[0]?.message).toBe(
      "uses edges: snap: the first week starts on Sun Oct 25, before the range starts on Oct 29",
    );
  });

  it("names the default period once per dashboard that leaves it out", () => {
    const ds = notes([{ type: "kpi", metric: "revenue" }], { period: undefined });
    expect(ds.map((d) => [d.file, d.pointer, d.message])).toEqual([
      [
        "dashboards/d.yaml",
        "/title",
        "uses the default period, asOf: latest_data: charts end at the newest source's horizon, and sources that end earlier are marked partial",
      ],
    ]);
  });

  it("names the week and year anchors once, on hatchmark.yaml, only where a block relies on them", () => {
    const blocks = [
      { type: "line", metrics: ["revenue"], grain: "week", edges: "snap", incomplete: "mark" },
      {
        type: "bar",
        metrics: ["orders"],
        grain: "month",
        grains: ["month", "quarter"],
        edges: "snap",
        incomplete: "mark",
      },
      { type: "line", metrics: ["revenue"], grain: "year", edges: "snap", incomplete: "mark" },
    ];
    expect(notes(blocks, { config: noAnchors }).map((d) => [d.file, d.pointer, d.message])).toEqual(
      [
        ["hatchmark.yaml", "/name", "uses the default week anchor: weeks start on Monday"],
        [
          "hatchmark.yaml",
          "/name",
          "uses the default quarter anchor: quarters start on Jan 1, Apr 1, Jul 1 and Oct 1",
        ],
        ["hatchmark.yaml", "/name", "uses the default year anchor: years start on Jan 1"],
      ],
    );
    expect(
      notes(blocks, { config: { ...noAnchors, anchors: { week: "monday", year: "01-01" } } }),
    ).toEqual([]);
    expect(
      notes(
        [
          {
            type: "line",
            metrics: ["revenue"],
            grain: { unit: "week", anchor: "sunday" },
            edges: "snap",
            incomplete: "mark",
          },
        ],
        { config: noAnchors },
      ),
    ).toEqual([]);
  });

  it("folds the notes into one line per file in human output, unless asked to explain them", () => {
    const ds = notes([{ type: "line", metrics: ["revenue"], grain: "month" }], {
      config: noAnchors,
      period: undefined,
    });
    const report = createReport(ds);
    expect(report).toMatchObject({ ok: true, error_count: 0, warning_count: 0 });
    expect(renderHuman(report).split("\n\n")).toEqual([
      "note[HM4040]: dashboards/d.yaml: 3 default definitions, run hatchmark check --explain-defaults",
      "ok: 0 errors, 0 warnings",
    ]);
    const all = renderHuman(report, { explainDefaults: true });
    expect(all.match(/^note\[HM4040\]: /gm)).toHaveLength(3);
    expect(all).toMatch(/= help: set edges: clip/);
  });

  it("uses the period and grain a page shows first, from its filters", () => {
    const ds = notes(
      [
        { type: "line", metrics: ["revenue"], grain: "day", grains: ["day", "month"] },
        { type: "line", metrics: ["revenue"], grain: "week", grains: ["week", "month"] },
      ],
      { period: { asOf: "2026-10-20", range: "last_30_days", compare: "none" }, filters: true },
    ).filter((d) => d.message.startsWith("uses edges"));
    expect(ds.map((d) => [d.pointer, d.message])).toEqual([
      [
        "/blocks/0/grain",
        "uses edges: snap: the first month starts on Jul 1, before the range starts on Jul 23",
      ],
      [
        "/blocks/1/grain",
        "uses edges: snap: the first month starts on Jul 1, before the range starts on Jul 23",
      ],
    ]);
  });

  it("names no edges for all_time, which has no start to snap", () => {
    const ds = notes([{ type: "line", metrics: ["revenue"], grain: "month" }], {
      period: { asOf: "latest_data", range: "all_time", compare: "none" },
    });
    expect(ds.map((d) => d.message.slice(0, 22))).toEqual(["uses incomplete: mark:"]);
  });

  it("names the year anchor alone when quarters are anchored, and suggests a quarter start", () => {
    const ds = notes(
      [{ type: "line", metrics: ["revenue"], grain: "year", edges: "snap", incomplete: "mark" }],
      { config: { ...noAnchors, anchors: { quarter: "02-01" } } },
    );
    expect(ds.map((d) => [d.message, d.help])).toEqual([
      [
        "uses the default year anchor: years start on Jan 1",
        "set anchors: {year: 02-01} for a year from Feb 1, or another quarter start, or a block's grain: {unit: year, anchor: 02-01}; anchors: {year: 01-01} keeps the default and silences this note",
      ],
    ]);
  });
});
