import { REVENUE_LINE, SALES } from "../../gallery/fixtures.js";
import {
  assemble,
  planDashboard,
  planHash,
  printSql,
  querySql,
  resolveParams,
  resolveRange,
} from "../../src/compiler/index.js";
import { createReport, renderHuman } from "../../src/diagnostics/index.js";
import { renderChartSvg, renderDashboardPage, textWidth } from "../../src/render/index.js";
import {
  checkReferences,
  DEFAULT_ANCHORS,
  jsonSchema,
  loadProject,
  PROJECT_DEFAULTS,
  type ProjectHost,
  parseDiagnostics,
} from "../../src/spec/index.js";

const files: Record<string, string> = {
  "hatchmark.json": JSON.stringify({
    ...PROJECT_DEFAULTS,
    name: "Worker smoke",
    sources: { orders: { type: "csv", path: "data/orders.csv" } },
  }),
  "data/orders.csv": "ordered_at,region,amount\n2026-10-01,West,10\n",
  "metrics/revenue.json": JSON.stringify({
    label: "Revenue",
    type: "aggregate",
    table: "orders",
    aggregate: "sum",
    column: "amount",
    time: "ordered_at",
    format: { type: "currency" },
    better: "up",
  }),
  "dashboards/sales.json":
    '{\n  "title": "Sales",\n  "blocks": [{"type": "kpi", "metric": "revenu"}]\n}\n',
  "dashboards/ok.json": JSON.stringify({
    title: "OK",
    period: { asOf: "2026-10-31", range: "last_complete_month", compare: "none" },
    blocks: [{ type: "kpi", metric: "revenue" }],
  }),
};

const host: ProjectHost = {
  label: "memory",
  readText: async (file) => files[file],
  listFiles: async (dir) =>
    Object.keys(files)
      .filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/"))
      .map((f) => f.slice(dir.length + 1)),
  isFile: async (file) => file in files,
  readHead: async (file, bytes) => {
    const text = files[file];
    return text === undefined
      ? undefined
      : { text: text.slice(0, bytes), complete: text.length <= bytes };
  },
};

export default {
  async fetch(): Promise<Response> {
    const { project, diagnostics } = await loadProject(host);
    if (project === undefined) return Response.json({ error: "no project" }, { status: 500 });
    const report = createReport([
      ...parseDiagnostics(project),
      ...diagnostics,
      ...checkReferences(project),
    ]);
    const { plan } = planDashboard(project, "ok");
    const query = plan?.queries[0];
    const assembled =
      plan &&
      query &&
      assemble(
        project,
        plan,
        new Map([
          [
            query.id,
            { columns: [{ name: "revenue__sum", type: "number" as const }], rows: [[10]] },
          ],
        ]),
        {
          asOf: "2026-10-31",
          timezone: "UTC",
          anchors: { ...DEFAULT_ANCHORS, week: "monday" },
          bindings: {},
        },
      );
    return Response.json({
      report,
      kpi: assembled?.data?.blocks[0],
      human: renderHuman(report),
      columns: project.columns.get("orders"),
      schemaTitle: jsonSchema("dashboard").title,
      params: resolveParams(project, "sales"),
      window: resolveRange("last_complete_month", "previous_period", "2026-11-15", DEFAULT_ANCHORS),
      planHash: planHash({
        version: 2,
        dashboard: "sales",
        period: { asOf: "2026-11-15", range: "last_complete_month", compare: "previous_period" },
        timezone: "America/New_York",
        anchors: { ...DEFAULT_ANCHORS, week: "monday" },
        params: [],
        horizons: [],
        blocks: [],
        queries: [],
        materialization: {},
      }),
      page: renderDashboardPage(SALES, {
        assets: { runtime: "../_hatchmark/hatchmark.js", fonts: {} },
      }),
      svg: renderChartSvg(REVENUE_LINE, SALES, { width: 600, mode: "dark" }),
      width: textWidth("Revenue", { size: 12 }),
      sql:
        query &&
        printSql(
          querySql(
            {
              name: "orders",
              relation: '"__hm_source_orders"',
              columns: [
                { name: "ordered_at", type: "DATE" },
                { name: "amount", type: "BIGINT" },
              ],
            },
            query,
            {
              asOf: "2026-10-31",
              timezone: "UTC",
              anchors: { ...DEFAULT_ANCHORS, week: "monday" },
              bindings: {},
            },
          ),
        ),
    });
  },
};
