import { describe, expect, it } from "vitest";
import { resolveParams } from "../../src/compiler/index.js";
import { checkReferences, hasColumn, sameColumn } from "../../src/spec/index.js";
import { fromYaml } from "../yaml.js";
import { applyFix, DASHBOARD, METRICS, projectFrom } from "./helpers.js";

describe("column names", () => {
  it("match case-insensitively for ASCII letters only, as DuckDB resolves identifiers", () => {
    expect(sameColumn("Region", "region")).toBe(true);
    expect(sameColumn("RÉGION", "région")).toBe(false);
    expect(hasColumn(["Order_ID", "Region"], "region")).toBe(true);
    expect(hasColumn(["region"], "country")).toBe(false);
    expect(hasColumn(undefined, "region")).toBeUndefined();
  });

  it("bind filters and pass HM2013 when a source spells the column with other letter case", () => {
    const metrics = {
      ...METRICS,
      sessions: {
        label: "Sessions",
        type: "aggregate",
        table: "merchants",
        aggregate: "count",
        time: "started_at",
        format: { type: "number" },
        better: "up",
      },
      conversion: {
        label: "Conversion",
        type: "ratio",
        numerator: "orders",
        denominator: "sessions",
        format: { type: "percent" },
        better: "up",
      },
    };
    const dashboards = {
      sales: {
        title: "Funnel",
        filters: [{ type: "select", id: "region", column: "region" }],
        blocks: [{ type: "kpi", metric: "conversion" }],
      },
    };
    const project = projectFrom({
      metrics,
      dashboards,
      columns: { orders: ["Region"], merchants: ["REGION"] },
    });
    expect(checkReferences(project).filter((d) => d.code === "HM2013")).toEqual([]);
    expect(resolveParams(project, "sales")).toMatchObject([
      { id: "region", sources: ["merchants", "orders"] },
    ]);
  });
});

describe("HM3008", () => {
  const withFilter = (filter: Record<string, unknown>) =>
    projectFrom({
      dashboards: {
        sales: {
          ...DASHBOARD,
          filters: [{ type: "select", id: "region", column: "region", ...filter }],
        },
      },
    });

  it("rejects a list default on a single select, unwrapping a one-item list as a safe fix", () => {
    const project = withFilter({ default: ["West"] });
    const [d, ...rest] = checkReferences(project).filter((x) => x.code === "HM3008");
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      severity: "error",
      file: "dashboards/sales.yaml",
      pointer: "/filters/0/default",
      message: 'filter "region" selects one value, but its default is a list',
      fix: { text: "West", applicability: "safe" },
    });
    const fixed = applyFix(project.dashboards.get("sales")?.document.text ?? "", d?.fix);
    expect(fromYaml(fixed).filters[0].default).toBe("West");
  });

  it("offers multiple: true as an unsafe fix for a longer list, and no fix for an empty one", () => {
    const [many] = checkReferences(withFilter({ default: ["West", "East"] })).filter(
      (x) => x.code === "HM3008",
    );
    expect(many?.fix).toMatchObject({
      applicability: "unsafe",
      description: "add multiple: true",
    });
    const project = withFilter({ default: ["West", "East"] });
    const fixed = applyFix(project.dashboards.get("sales")?.document.text ?? "", many?.fix);
    expect(fromYaml(fixed).filters[0]).toMatchObject({
      multiple: true,
      default: ["West", "East"],
    });
    const [empty] = checkReferences(withFilter({ default: [] })).filter((x) => x.code === "HM3008");
    expect(empty?.fix).toBeUndefined();
  });

  it("accepts a list default on a multiple select and a scalar default on a single one", () => {
    for (const filter of [{ multiple: true, default: ["West", "East"] }, { default: "West" }, {}]) {
      expect(checkReferences(withFilter(filter)).filter((x) => x.code === "HM3008")).toEqual([]);
    }
  });
});
