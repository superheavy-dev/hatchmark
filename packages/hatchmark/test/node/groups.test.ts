import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BarData, DashboardData, LineData } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

const CHANNELS = ["Online store", "Marketplace", "Retail partners", "Wholesale"];

function orders(): string {
  const lines = ["order_id,ordered_at,channel,status,amount,refund"];
  for (let i = 0; i < 240; i++) {
    const month = 1 + (i % 6);
    const day = 1 + ((i * 7) % 28);
    const channel = CHANNELS[(i * 5) % CHANNELS.length] as string;
    const at = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00Z`;
    lines.push(
      `${i},${at},${channel},${i % 9 === 0 ? "refunded" : "paid"},${20 + (i % 37)},${i % 5}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const usd = { type: "currency", currency: "USD" };
const on = (body: Record<string, unknown>) =>
  metric({ type: "aggregate", table: "orders", time: "ordered_at", ...body }, usd);
const METRICS = {
  revenue: on({ label: "Revenue", aggregate: "sum", column: "amount" }),
  refunds: on({ label: "Refunds", aggregate: "sum", column: "refund" }),
  paid: on({
    label: "Paid revenue",
    aggregate: "sum",
    column: "amount",
    filters: [{ column: "status", op: "eq", value: "paid" }],
  }),
};

const PERIOD = { asOf: "2026-06-30", range: "year_to_date", compare: "none" };
const split = { metrics: ["revenue"], by: "channel", split: "channel", stack: "percent" };
const DASHBOARDS = {
  groups: {
    title: "Groups",
    period: PERIOD,
    blocks: [
      {
        type: "line",
        id: "metrics",
        metrics: ["revenue", "refunds", "paid"],
        grain: "month",
        groups: [{ label: "Revenue", series: ["paid", "revenue"] }],
      },
      {
        type: "line",
        id: "metrics_plain",
        metrics: ["revenue", "refunds", "paid"],
        grain: "month",
      },
      {
        type: "bar",
        id: "split",
        ...split,
        by: undefined,
        grain: "month",
        groups: [{ label: "Direct", series: ["Retail partners", "Nowhere", "Online store"] }],
      },
      { type: "bar", id: "split_plain", ...split, by: undefined, grain: "month" },
    ],
  },
};

let project: Awaited<ReturnType<typeof writeProject>>;
let data: DashboardData | undefined;
let diagnostics: { code: string; severity: string; message: string; pointer?: string }[];

function block<T>(id: string): T {
  const found = data?.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as T;
}

beforeAll(async () => {
  project = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Groups",
      timezone: "America/New_York",
      sources: { orders: { type: "csv", path: "data/orders.csv" } },
    },
    "data/orders.csv": orders(),
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.yaml`, m])),
    ...Object.fromEntries(Object.entries(DASHBOARDS).map(([n, d]) => [`dashboards/${n}.yaml`, d])),
  });
  const result = await run(project.root, project.project, "groups");
  data = result.data;
  diagnostics = result.diagnostics;
});
afterAll(removeProjects);

describe("series groups in the engine", () => {
  it("checks cleanly", () => {
    expect(project.diagnostics).toEqual([]);
    expect(checkReferences(project.project)).toEqual([]);
  });

  it("moves a group's members together in the group's order and tags each with its step", () => {
    const grouped = block<LineData>("metrics");
    expect(grouped.groups).toEqual([{ label: "Revenue" }]);
    expect(grouped.series.map((s) => [s.key, s.group])).toEqual([
      ["paid", { index: 0, step: 0 }],
      ["revenue", { index: 0, step: 1 }],
      ["refunds", undefined],
    ]);
    const plain = block<LineData>("metrics_plain");
    expect(plain.groups).toBeUndefined();
    expect(plain.series.some((s) => "group" in s)).toBe(false);
    for (const s of grouped.series) {
      expect(s.values).toEqual(plain.series.find((p) => p.key === s.key)?.values);
    }
  });

  it("keeps the declared step of every split value, even one the data lacks", () => {
    const grouped = block<BarData>("split");
    const plain = block<BarData>("split_plain");
    const steps = grouped.series.filter((s) => s.group).map((s) => [s.label, s.group?.step]);
    expect(steps).toEqual([
      ["Retail partners", 0],
      ["Online store", 2],
    ]);
    expect(grouped.series.map((s) => s.label).sort()).toEqual(
      plain.series.map((s) => s.label).sort(),
    );
    expect(grouped.totals).toEqual(plain.totals);
    for (const s of grouped.series) {
      const twin = plain.series.find((p) => p.key === s.key);
      expect(s.values).toEqual(twin?.values);
      expect(s.share).toEqual(twin?.share);
    }
  });

  it("warns once about a split value the data has no rows for (HM2027)", () => {
    expect(diagnostics.filter((d) => d.code === "HM2027")).toMatchObject([
      {
        severity: "warning",
        pointer: "/blocks/2/groups/0/series/1",
        message: 'group "Direct" names "Nowhere", which "channel" has no rows for',
      },
    ]);
  });
});
