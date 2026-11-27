import { describe, expect, it } from "vitest";
import { tableGroupingSets } from "../../src/compiler/planner.js";
import type { Block } from "../../src/spec/index.js";

const table = (extra: Partial<Block & { type: "table" }>) =>
  ({ type: "table", by: ["a", "b", "c"], metrics: ["m"], ...extra }) as Block & { type: "table" };

describe("table grouping sets", () => {
  it("is rows plus the grand total by default", () => {
    expect(tableGroupingSets(table({}))).toEqual([[0, 1, 2], []]);
  });

  it("rolls up every outer prefix with subtotals (ROLLUP order)", () => {
    expect(tableGroupingSets(table({ subtotals: true }))).toEqual([[0, 1, 2], [0, 1], [0], []]);
  });

  it("keeps the subtotals and drops the total when the table shows neither totals nor shares", () => {
    expect(tableGroupingSets(table({ subtotals: true, totals: false }))).toEqual([
      [0, 1, 2],
      [0, 1],
      [0],
    ]);
    expect(tableGroupingSets(table({ totals: false, percentOfTotal: ["m"] }))).toEqual([
      [0, 1, 2],
      [],
    ]);
  });
});
