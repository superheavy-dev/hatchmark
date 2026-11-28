import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { waitUntil } from "../util.ts";

export const METABASE_IMAGE = "metabase/metabase:v0.65.7.4";
const CONTAINER = "hatchmark-bench-metabase";
const PORT = 3939;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = { email: "bench@example.com", password: "bench-local-only-1" };
const PARAMETER = "region";
const SCALAR = '[data-testid="scalar-value"]';

interface State {
  dashboardId: number;
  dashcards: { id: number; cardId: number }[];
}

const statePath = (ctx: BenchContext) => join(ctx.work, "metabase.json");

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; session?: string } = {},
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(init.session ? { "x-metabase-session": init.session } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function login(): Promise<string> {
  const { id } = await api<{ id: string }>("/api/session", {
    body: { username: USER.email, password: USER.password },
  });
  return id;
}

function nativeCard(
  name: string,
  display: string,
  sql: string,
  settings: Record<string, unknown>,
  database: number,
) {
  return {
    name,
    display,
    visualization_settings: settings,
    dataset_query: {
      type: "native",
      database,
      native: {
        query: sql,
        "template-tags": {
          region: {
            id: "6f3c2a52-0d5e-4bb4-9a49-4d6a1c0b7e11",
            name: "region",
            "display-name": "Region",
            type: "text",
          },
        },
      },
    },
  };
}

const where = `where ${PERIOD} [[and region = {{region}}]]`;
const currency = (column: string, extra: Record<string, unknown> = {}) => ({
  column_settings: {
    [JSON.stringify(["name", column])]: { number_style: "currency", currency: "USD", ...extra },
  },
});

async function provision(): Promise<State> {
  const properties = await api<{ "setup-token": string | null; "has-user-setup": boolean }>(
    "/api/session/properties",
  );
  if (!properties["has-user-setup"]) {
    await api("/api/setup", {
      body: {
        token: properties["setup-token"],
        user: { first_name: "Bench", last_name: "User", ...USER, site_name: "Bench" },
        prefs: { site_name: "Bench", site_locale: "en", allow_tracking: false },
      },
    });
  }
  const session = await login();
  const database = await api<{ id: number }>("/api/database", {
    session,
    body: {
      engine: "postgres",
      name: "bench",
      details: {
        host: POSTGRES,
        port: 5432,
        dbname: "bench",
        user: "bench",
        password: "bench",
        ssl: false,
      },
    },
  });
  const cards = [
    nativeCard(
      "Revenue",
      "scalar",
      `select ${KPI_SQL.revenue} as revenue from orders ${where}`,
      { ...currency("revenue"), "scalar.compact_primary_number": true },
      database.id,
    ),
    nativeCard(
      "Orders",
      "scalar",
      `select ${KPI_SQL.orders} as orders from orders ${where}`,
      {},
      database.id,
    ),
    nativeCard(
      "Average order value",
      "scalar",
      `select ${KPI_SQL.aov} as aov from orders ${where}`,
      currency("aov", { decimals: 2 }),
      database.id,
    ),
    nativeCard(
      "Refund rate",
      "scalar",
      `select ${KPI_SQL.refund_rate} as refund_rate from orders ${where}`,
      {
        column_settings: {
          [JSON.stringify(["name", "refund_rate"])]: { number_style: "percent", decimals: 1 },
        },
      },
      database.id,
    ),
    nativeCard(
      "Revenue by month, by region",
      "line",
      `select date_trunc('month', ordered_at) as month, region, sum(amount) as revenue from orders ${where} and status = 'paid' group by 1, 2 order by 1, 2`,
      {
        "graph.dimensions": ["month", "region"],
        "graph.metrics": ["revenue"],
        ...currency("revenue"),
      },
      database.id,
    ),
    nativeCard(
      "Revenue by channel",
      "row",
      `select channel, sum(amount) as revenue from orders ${where} and status = 'paid' group by 1 order by 2 desc`,
      { "graph.dimensions": ["channel"], "graph.metrics": ["revenue"], ...currency("revenue") },
      database.id,
    ),
    nativeCard(
      "Top countries by revenue",
      "table",
      `select country, sum(amount) as revenue, count(*) as orders, sum(amount) / count(*) as average_order_value, count(distinct customer_id) as customers from orders ${where} and status = 'paid' group by 1 order by 2 desc limit 15`,
      {
        ...currency("revenue"),
        ...{
          column_settings: {
            ...currency("revenue").column_settings,
            ...currency("average_order_value", { decimals: 2 }).column_settings,
          },
        },
      },
      database.id,
    ),
  ];
  const created: { id: number }[] = [];
  for (const card of cards)
    created.push(await api<{ id: number }>("/api/card", { session, body: card }));
  const dashboard = await api<{ id: number }>("/api/dashboard", {
    session,
    body: { name: "Global sales" },
  });
  const layout = [
    [0, 0, 6, 3],
    [0, 6, 6, 3],
    [0, 12, 6, 3],
    [0, 18, 6, 3],
    [3, 0, 16, 6],
    [3, 16, 8, 6],
    [9, 0, 24, 9],
  ];
  const updated = await api<{ dashcards: { id: number; card_id: number }[] }>(
    `/api/dashboard/${dashboard.id}`,
    {
      session,
      method: "PUT",
      body: {
        parameters: [
          {
            id: PARAMETER,
            name: "Region",
            slug: "region",
            type: "string/=",
            sectionId: "string",
            values_query_type: "list",
            values_source_type: "static-list",
            values_source_config: { values: ["APAC", "Americas", "EMEA"] },
          },
        ],
        dashcards: created.map((card, i) => {
          const [row, col, size_x, size_y] = layout[i] ?? [0, 0, 6, 3];
          return {
            id: -(i + 1),
            card_id: card.id,
            row,
            col,
            size_x,
            size_y,
            parameter_mappings: [
              {
                parameter_id: PARAMETER,
                card_id: card.id,
                target: ["variable", ["template-tag", "region"]],
              },
            ],
            visualization_settings: {},
          };
        }),
      },
    },
  );
  return {
    dashboardId: dashboard.id,
    dashcards: updated.dashcards.map((d) => ({ id: d.id, cardId: d.card_id })),
  };
}

export const metabase: Target = {
  name: "metabase",
  version: () => METABASE_IMAGE,
  visuals: [
    { name: "kpi_revenue", kind: "text", selector: SCALAR, index: 0 },
    { name: "kpi_orders", kind: "text", selector: SCALAR, index: 1 },
    { name: "kpi_aov", kind: "text", selector: SCALAR, index: 2 },
    { name: "kpi_refund_rate", kind: "text", selector: SCALAR, index: 3 },
    {
      name: "line_revenue_by_region",
      kind: "svg",
      chart: true,
      selector: '[data-testid="chart-container"] svg',
      marks: "path",
      minMarks: 3,
    },
    {
      name: "bar_revenue_by_channel",
      kind: "svg",
      chart: true,
      selector: '[data-testid="row-chart-container"] svg',
      marks: "rect",
      minMarks: 6,
    },
    {
      name: "table_by_country",
      kind: "table",
      selector: '[data-testid="table-root"]',
      marks: '[data-testid="table-body"] [role="row"]',
      minMarks: 5,
    },
  ],
  async setup(ctx) {
    await startPostgres(ctx);
    const fresh = !containerRunning(CONTAINER);
    startContainer(CONTAINER, [
      "--env",
      "JAVA_OPTS=-Xmx2g",
      "--env",
      "MB_ANONYMOUS_TRACKING_ENABLED=false",
      "--env",
      "MB_CHECK_FOR_UPDATES=false",
      "--publish",
      `127.0.0.1:${PORT}:3000`,
      METABASE_IMAGE,
    ]);
    await waitUntil(
      "metabase health",
      async () => (await fetch(`${BASE}/api/health`)).ok,
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
      throw new Error("metabase is not running; run setup metabase first");
    const state: State = JSON.parse(readFileSync(statePath(ctx), "utf8"));
    return {
      url: `${BASE}/dashboard/${state.dashboardId}`,
      async authenticate(context) {
        await context.addCookies([
          { name: "metabase.SESSION", value: await login(), url: BASE },
          { name: "metabase.TIMEOUT", value: "alive", url: BASE },
        ]);
      },
      async serverQueries() {
        const session = await login();
        const started = performance.now();
        await Promise.all(
          state.dashcards.map((d) =>
            api(`/api/dashboard/${state.dashboardId}/dashcard/${d.id}/card/${d.cardId}/query`, {
              session,
              body: { parameters: [] },
            }),
          ),
        );
        return performance.now() - started;
      },
      async close() {
        resume();
      },
    };
  },
  async prepareInteraction(page) {
    await page.getByRole("button", { name: "Region" }).first().click();
    await page.getByRole("dialog").getByText("EMEA", { exact: true }).click();
  },
  async commitInteraction(page) {
    await page.getByRole("button", { name: /Add filter|Update filter|Apply/ }).click();
  },
  async teardown() {
    removeContainer(CONTAINER);
  },
};
