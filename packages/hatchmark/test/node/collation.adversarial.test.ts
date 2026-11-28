import { afterAll, describe, expect, it } from "vitest";
import type { BarData, PieData, TableData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { csv, EXPECTED, NAMES } from "./collation.oracle.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

const TIES: [string, number][] = [
  ["Zebra", 50],
  ["Alpha", 100],
  ["Österreich", 50],
];

async function build(locale: string, rows: [string, number][], block: Record<string, unknown>) {
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      locale,
      name: "Collation",
      sources: { orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } } },
    },
    "orders.csv": csv(rows),
    "metrics/amount.yaml": metric({
      table: "orders",
      time: "day",
      type: "aggregate",
      aggregate: "sum",
      column: "amount",
    }),
    "dashboards/probe.yaml": {
      title: "Probe",
      period: { asOf: "2026-02-28", range: "all_time", compare: "none" },
      blocks: [block],
    },
  });
  const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
  const result = data?.blocks[0];
  if (result === undefined) throw new Error(`no block: ${JSON.stringify(diagnostics)}`);
  return result;
}

const table = (by: string, order: "asc" | "desc", extra: Record<string, unknown> = {}) => ({
  type: "table",
  by: ["name"],
  metrics: ["amount"],
  sort: { by, order },
  ...extra,
});

describe("text keys follow the project locale's collation", () => {
  for (const [locale, expected] of Object.entries(EXPECTED)) {
    it(`${locale}: a table sorted by name, both ways`, async () => {
      const up = (await build(locale, NAMES, table("name", "asc"))) as TableData;
      expect(up.rows.map((r) => r.keys[0])).toEqual(expected);
      const down = (await build(locale, NAMES, table("name", "desc"))) as TableData;
      expect(down.rows.map((r) => r.keys[0])).toEqual([...expected].reverse());
    });

    it(`${locale}: a bar chart sorted by its category`, async () => {
      const bar = (await build(locale, NAMES, {
        type: "bar",
        metrics: ["amount"],
        by: "name",
        sort: { by: "name", order: "asc" },
      })) as BarData;
      expect(bar.axis.kind === "category" ? bar.axis.categories : []).toEqual(expected);
    });

    it(`${locale}: top 5 by value and Other hold the same rows in every locale`, async () => {
      const top = (await build(
        locale,
        NAMES,
        table("amount", "desc", { limit: 5, other: true }),
      )) as TableData;
      expect(top.rows.map((r) => [r.kind ?? "row", r.keys[0] ?? null, r.values.amount])).toEqual([
        ["row", "Zebra", 140],
        ["row", "Item 10", 130],
        ["row", "Österreich", 120],
        ["row", "apple", 110],
        ["row", "Aaron", 100],
        ["other", null, 450],
      ]);
      expect(top.rows.at(-1)?.count).toBe(9);
      expect(top.total?.values.amount).toBe(1050);
    });
  }

  for (const [locale, kept] of [
    ["en-US", "Österreich"],
    ["de-DE", "Österreich"],
    ["sv-SE", "Zebra"],
  ] as const) {
    it(`${locale}: a tie at the cut goes to the key that sorts first (${kept})`, async () => {
      const top = (await build(
        locale,
        TIES,
        table("amount", "desc", { limit: 2, other: true }),
      )) as TableData;
      expect(top.rows.map((r) => [r.kind ?? "row", r.keys[0] ?? null, r.values.amount])).toEqual([
        ["row", "Alpha", 100],
        ["row", kept, 50],
        ["other", null, 50],
      ]);
      const pie = (await build(locale, TIES, {
        type: "pie",
        metric: "amount",
        by: "name",
        limit: 2,
      })) as PieData;
      expect(pie.slices.map((s) => [s.label, s.value])).toEqual([
        ["Alpha", 100],
        [kept, 50],
      ]);
      expect(pie.other?.value).toBe(50);
    });
  }
});
