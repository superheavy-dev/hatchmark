import { describe, expect, it } from "vitest";
import { resolveParams } from "../../src/compiler/index.js";
import { CONFIG, METRICS, projectFrom } from "../spec/helpers.js";

const dashboard = (filters: unknown[]) => ({
  sales: { title: "Sales", filters, blocks: [{ type: "kpi", metric: "orders", compare: "none" }] },
});

describe("resolveParams", () => {
  it("carries the column, operator, default and sources of each select filter (HAT-13)", () => {
    const params = (column: string) =>
      resolveParams(
        projectFrom({
          dashboards: dashboard([{ type: "select", id: "slice", column }]),
          columns: { orders: ["region", "channel"] },
        }),
        "sales",
      );
    expect(params("region")).toEqual([
      {
        id: "slice",
        kind: "select",
        column: "region",
        operator: "in",
        multiple: false,
        default: [],
        sources: ["orders"],
      },
    ]);
    expect(JSON.stringify(params("region"))).not.toBe(JSON.stringify(params("channel")));
  });

  it("changes the plan whenever a filter is retargeted to another column (property)", () => {
    const columns = ["region", "channel", "state", "plan", "status", "industry"];
    for (const from of columns) {
      for (const to of columns) {
        if (from === to) continue;
        const make = (column: string) =>
          JSON.stringify(
            resolveParams(
              projectFrom({
                dashboards: dashboard([
                  { type: "select", id: "f", column, default: "West", multiple: true },
                ]),
              }),
              "sales",
            ),
          );
        expect(make(from), `${from} -> ${to}`).not.toBe(make(to));
      }
    }
  });

  it("binds only to sources that can have the column, and lists period time columns", () => {
    const project = projectFrom({
      config: CONFIG,
      metrics: METRICS,
      columns: { orders: ["region"], merchants: ["merchant_id"] },
      dashboards: {
        sales: {
          title: "Sales",
          filters: [
            { type: "select", id: "region", column: "region", default: ["West", "East"] },
            {
              type: "period",
              id: "range",
              options: ["last_7_days", "last_30_days"],
              default: "last_30_days",
            },
          ],
          blocks: [
            { type: "kpi", metric: "revenue" },
            { type: "kpi", metric: "merchants", compare: "none" },
          ],
        },
      },
    });
    expect(resolveParams(project, "sales")).toEqual([
      {
        id: "region",
        kind: "select",
        column: "region",
        operator: "in",
        multiple: false,
        default: ["West", "East"],
        sources: ["orders"],
      },
      {
        id: "range",
        kind: "period",
        options: ["last_7_days", "last_30_days"],
        default: "last_30_days",
        columns: { orders: ["ordered_at"] },
      },
    ]);
  });
});
