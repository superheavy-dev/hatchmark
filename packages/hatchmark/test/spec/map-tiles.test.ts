import { describe, expect, it } from "vitest";
import { checkReferences, parseDiagnostics } from "../../src/spec/index.js";
import { DASHBOARD, projectFrom } from "./helpers.js";

const check = (block: Record<string, unknown>) => {
  const project = projectFrom({
    dashboards: {
      sales: {
        ...DASHBOARD,
        filters: [],
        blocks: [{ type: "map", region: "country", value: "avg_order_value", ...block }],
      },
    },
  });
  return [...parseDiagnostics(project), ...checkReferences(project)]
    .filter((d) => d.code === "HM2033" || d.code === "HM2034" || d.severity === "error")
    .map((d) => [d.code, d.severity, d.pointer]);
};

describe("map tile checks", () => {
  it("accepts square and hex tiles on us-states", () => {
    expect(check({ geo: "us-states", shape: "tiles" })).toEqual([]);
    expect(check({ geo: "us-states", shape: "tiles", tile: "hex" })).toEqual([]);
  });

  it("rejects tiles on world-countries (HM2033)", () => {
    expect(check({ geo: "world-countries", shape: "tiles" })).toEqual([
      ["HM2033", "error", "/blocks/0/shape"],
    ]);
  });

  it("warns about a tile on a map that draws boundaries (HM2034)", () => {
    expect(check({ geo: "us-states", tile: "hex" })).toEqual([
      ["HM2034", "warning", "/blocks/0/tile"],
    ]);
  });
});
