import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  containerRunning,
  POSTGRES,
  pauseOthers,
  removeContainer,
  startContainer,
  startPostgres,
} from "../docker.ts";
import { KPI_SQL, PERIOD } from "../sql.ts";
import type { BenchContext, Target } from "../target.ts";
import { run, waitUntil } from "../util.ts";

export const SUPERSET_IMAGE = "hatchmark-bench-superset:6.1.0";
const CONTAINER = "hatchmark-bench-superset";
const PORT = 8989;
const BASE = `http://127.0.0.1:${PORT}`;
const CHART = ".dashboard-component-chart-holder canvas";
const USER = { username: "admin", password: "bench-admin" };

interface State {
  dashboardId: number;
  chartData: string[];
}

const statePath = (ctx: BenchContext) => join(ctx.work, "superset.json");

class Client {
  cookies = new Map<string, string>();
  token = "";
  csrf = "";

  async request(
    path: string,
    init: { method?: string; body?: unknown; form?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = {
      referer: BASE,
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.csrf) headers["x-csrftoken"] = this.csrf;
    let body: string | undefined;
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }
    const response = await fetch(`${BASE}${path}`, {
      method: init.method ?? (body ? "POST" : "GET"),
      headers,
      redirect: "manual",
      ...(body ? { body } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await response.text();
    if (response.status >= 400)
      throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text.slice(0, 500)}`);
    return text;
  }

  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return JSON.parse(await this.request(path, init)) as T;
  }

  async loginApi() {
    const { access_token } = await this.json<{ access_token: string }>("/api/v1/security/login", {
      body: { ...USER, provider: "db", refresh: false },
    });
    this.token = access_token;
    this.csrf = (await this.json<{ result: string }>("/api/v1/security/csrf_token/")).result;
  }

  async loginBrowser(): Promise<string> {
    const page = await this.request("/login/");
    const csrf =
      /name="csrf_token"[^>]*value="([^"]+)"/.exec(page)?.[1] ??
      /value="([^"]+)"[^>]*name="csrf_token"/.exec(page)?.[1];
    if (!csrf) throw new Error("superset login page has no csrf_token");
    await this.request("/login/", { form: { ...USER, csrf_token: csrf } });
    const session = this.cookies.get("session");
    if (!session) throw new Error("superset login set no session cookie");
    return session;
  }
}

const metric = (label: string, sqlExpression: string) => ({
  expressionType: "SQL",
  sqlExpression,
  label,
  hasCustomLabel: true,
  optionName: `metric_${label.toLowerCase().replace(/\W+/g, "_")}`,
});
const REVENUE = metric("Revenue", KPI_SQL.revenue);

async function provision(): Promise<State> {
  const client = new Client();
  await client.loginApi();
  const database = await client.json<{ id: number }>("/api/v1/database/", {
    body: {
      database_name: "bench",
      sqlalchemy_uri: `postgresql://bench:bench@${POSTGRES}:5432/bench`,
      expose_in_sqllab: true,
    },
  });
  const dataset = await client.json<{ id: number }>("/api/v1/dataset/", {
    body: {
      database: database.id,
      schema: "public",
      table_name: "orders_period",
      sql: `select * from orders where ${PERIOD}`,
    },
  });
  await client.request(`/api/v1/dataset/${dataset.id}/refresh`, { method: "PUT" });
  const dashboard = await client.json<{ id: number }>("/api/v1/dashboard/", {
    body: { dashboard_title: "Global sales", published: true },
  });
  const base = { datasource: `${dataset.id}__table`, time_range: "No filter", adhoc_filters: [] };
  const paid = [{ expressionType: "SQL", sqlExpression: "status = 'paid'", clause: "WHERE" }];
  const charts = [
    {
      name: "Revenue",
      viz: "big_number_total",
      width: 3,
      height: 25,
      params: { metric: REVENUE, y_axis_format: "$,.3s" },
    },
    {
      name: "Orders",
      viz: "big_number_total",
      width: 3,
      height: 25,
      params: { metric: metric("Orders", KPI_SQL.orders), y_axis_format: ",d" },
    },
    {
      name: "Average order value",
      viz: "big_number_total",
      width: 3,
      height: 25,
      params: { metric: metric("Average order value", KPI_SQL.aov), y_axis_format: "$,.2f" },
    },
    {
      name: "Refund rate",
      viz: "big_number_total",
      width: 3,
      height: 25,
      params: { metric: metric("Refund rate", KPI_SQL.refund_rate), y_axis_format: ".1%" },
    },
    {
      name: "Revenue by month, by region",
      viz: "echarts_timeseries_line",
      width: 8,
      height: 50,
      params: {
        x_axis: "ordered_at",
        time_grain_sqla: "P1M",
        metrics: [metric("Revenue", "sum(amount)")],
        groupby: ["region"],
        adhoc_filters: paid,
        row_limit: 10000,
        y_axis_format: "$,.3s",
      },
    },
    {
      name: "Revenue by channel",
      viz: "echarts_timeseries_bar",
      width: 4,
      height: 50,
      params: {
        x_axis: "channel",
        metrics: [metric("Revenue", "sum(amount)")],
        groupby: [],
        adhoc_filters: paid,
        orientation: "horizontal",
        x_axis_sort: "Revenue",
        x_axis_sort_asc: false,
        row_limit: 1000,
        y_axis_format: "$,.3s",
      },
    },
    {
      name: "Top countries by revenue",
      viz: "table",
      width: 12,
      height: 60,
      params: {
        query_mode: "aggregate",
        groupby: ["country"],
        metrics: [
          metric("Revenue", "sum(amount)"),
          metric("Orders", "count(*)"),
          metric("Average order value", "sum(amount) / count(*)"),
          metric("Customers", "count(distinct customer_id)"),
        ],
        adhoc_filters: paid,
        timeseries_limit_metric: metric("Revenue", "sum(amount)"),
        order_desc: true,
        row_limit: 15,
        server_pagination: false,
      },
    },
  ];
  const ids: number[] = [];
  for (const chart of charts) {
    const params = { ...base, viz_type: chart.viz, ...chart.params };
    const created = await client.json<{ id: number }>("/api/v1/chart/", {
      body: {
        slice_name: chart.name,
        viz_type: chart.viz,
        datasource_id: dataset.id,
        datasource_type: "table",
        params: JSON.stringify(params),
        dashboards: [dashboard.id],
      },
    });
    ids.push(created.id);
  }
  const rows = [[0, 1, 2, 3], [4, 5], [6]];
  const position: Record<string, unknown> = {
    DASHBOARD_VERSION_KEY: "v2",
    ROOT_ID: { type: "ROOT", id: "ROOT_ID", children: ["GRID_ID"] },
    GRID_ID: {
      type: "GRID",
      id: "GRID_ID",
      children: rows.map((_, i) => `ROW-${i}`),
      parents: ["ROOT_ID"],
    },
    HEADER_ID: { id: "HEADER_ID", type: "HEADER", meta: { text: "Global sales" } },
  };
  rows.forEach((members, r) => {
    position[`ROW-${r}`] = {
      type: "ROW",
      id: `ROW-${r}`,
      children: members.map((m) => `CHART-${ids[m]}`),
      parents: ["ROOT_ID", "GRID_ID"],
      meta: { background: "BACKGROUND_TRANSPARENT" },
    };
    for (const m of members) {
      const chart = charts[m];
      position[`CHART-${ids[m]}`] = {
        type: "CHART",
        id: `CHART-${ids[m]}`,
        children: [],
        parents: ["ROOT_ID", "GRID_ID", `ROW-${r}`],
        meta: {
          chartId: ids[m],
          width: chart?.width,
          height: chart?.height,
          sliceName: chart?.name,
        },
      };
    }
  });
  const metadata = {
    native_filter_configuration: [
      {
        id: "NATIVE_FILTER-region",
        name: "Region",
        filterType: "filter_select",
        type: "NATIVE_FILTER",
        targets: [{ datasetId: dataset.id, column: { name: "region" } }],
        controlValues: {
          enableEmptyFilter: false,
          defaultToFirstItem: false,
          multiSelect: false,
          searchAllOptions: false,
          inverseSelection: false,
        },
        defaultDataMask: { extraFormData: {}, filterState: {}, ownState: {} },
        cascadeParentIds: [],
        scope: { rootPath: ["ROOT_ID"], excluded: [] },
        chartsInScope: ids,
        tabsInScope: [],
        description: "",
      },
    ],
    chart_configuration: {},
    cross_filters_enabled: false,
    color_scheme: "",
    refresh_frequency: 0,
    expanded_slices: {},
    label_colors: {},
    timed_refresh_immune_slices: [],
  };
  await client.request(`/api/v1/dashboard/${dashboard.id}`, {
    method: "PUT",
    body: { position_json: JSON.stringify(position), json_metadata: JSON.stringify(metadata) },
  });
  return {
    dashboardId: dashboard.id,
    chartData: await captureChartData(dashboard.id, charts.length),
  };
}

async function captureChartData(dashboardId: number, count: number): Promise<string[]> {
  const session = await new Client().loginBrowser();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 2400 } });
    await context.addCookies([{ name: "session", value: session, url: BASE }]);
    const page = await context.newPage();
    const bodies: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/v1/chart/data")) {
        bodies.push(request.postData() ?? "");
      }
    });
    await page.goto(`${BASE}/superset/dashboard/${dashboardId}/`);
    await waitUntil("superset chart requests", async () => bodies.length >= count, 120_000, 500);
    return bodies;
  } finally {
    await browser.close();
  }
}

export const superset: Target = {
  name: "superset",
  version: () => "apache/superset:6.1.0 with psycopg2-binary",
  visuals: [
    { name: "kpi_revenue", kind: "text", selector: ".header-line", index: 0 },
    { name: "kpi_orders", kind: "text", selector: ".header-line", index: 1 },
    { name: "kpi_aov", kind: "text", selector: ".header-line", index: 2 },
    { name: "kpi_refund_rate", kind: "text", selector: ".header-line", index: 3 },
    { name: "line_revenue_by_region", kind: "canvas", chart: true, selector: CHART, index: 0 },
    { name: "bar_revenue_by_channel", kind: "canvas", chart: true, selector: CHART, index: 1 },
    {
      name: "table_by_country",
      kind: "table",
      selector: ".dashboard-component-chart-holder tbody",
      marks: "tr",
      minMarks: 10,
    },
  ],
  async setup(ctx) {
    await startPostgres(ctx);
    run("docker", [
      "build",
      "--quiet",
      "--tag",
      SUPERSET_IMAGE,
      join(ctx.root, "bench/docker/superset"),
    ]);
    const fresh = !containerRunning(CONTAINER);
    startContainer(CONTAINER, [
      "--env",
      "SUPERSET_CONFIG_PATH=/app/bench/superset_config.py",
      "--env",
      "SUPERSET_SECRET_KEY=hatchmark-bench-local-only",
      "--env",
      "SCARF_ANALYTICS=false",
      "--env",
      "SERVER_WORKER_AMOUNT=2",
      "--publish",
      `127.0.0.1:${PORT}:8088`,
      SUPERSET_IMAGE,
      "sh",
      "-c",
      [
        "superset db upgrade",
        `superset fab create-admin --username ${USER.username} --password ${USER.password} --firstname Bench --lastname Admin --email admin@example.com`,
        "superset init",
        "/usr/bin/run-server.sh",
      ].join(" && "),
    ]);
    await waitUntil(
      "superset health",
      async () => (await fetch(`${BASE}/health`)).ok,
      600_000,
      3000,
    );
    if (fresh || !existsSync(statePath(ctx))) {
      writeFileSync(statePath(ctx), JSON.stringify(await provision(), null, 2));
    }
  },
  async start(ctx) {
    const resume = pauseOthers(CONTAINER);
    if (!containerRunning(CONTAINER))
      throw new Error("superset is not running; run setup superset first");
    const state: State = JSON.parse(readFileSync(statePath(ctx), "utf8"));
    return {
      url: `${BASE}/superset/dashboard/${state.dashboardId}/`,
      async authenticate(context) {
        await context.addCookies([
          { name: "session", value: await new Client().loginBrowser(), url: BASE },
        ]);
      },
      async serverQueries() {
        const client = new Client();
        await client.loginApi();
        const started = performance.now();
        await Promise.all(
          state.chartData.map((body) => client.request("/api/v1/chart/data", { body })),
        );
        return performance.now() - started;
      },
      async close() {
        resume();
      },
    };
  },
  async prepareInteraction(page) {
    await page.locator('[data-test="NATIVE_FILTER-region"]').click();
    await page.locator('.ant-select-item-option[title="EMEA"]').click();
  },
  async commitInteraction(page) {
    await page.locator('[data-test="filter-bar__apply-button"]').click();
  },
  async teardown() {
    removeContainer(CONTAINER);
  },
};
