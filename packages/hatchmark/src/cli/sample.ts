import { PROJECT_DEFAULTS, type ProjectConfig, WEEKDAYS } from "../spec/index.js";

const STATES: readonly [string, string, number][] = [
  ["AL", "South", 5.0],
  ["AK", "West", 0.7],
  ["AZ", "West", 7.2],
  ["AR", "South", 3.0],
  ["CA", "West", 39.5],
  ["CO", "West", 5.8],
  ["CT", "Northeast", 3.6],
  ["DE", "South", 1.0],
  ["DC", "South", 0.7],
  ["FL", "South", 21.5],
  ["GA", "South", 10.7],
  ["HI", "West", 1.5],
  ["ID", "West", 1.8],
  ["IL", "Midwest", 12.8],
  ["IN", "Midwest", 6.8],
  ["IA", "Midwest", 3.2],
  ["KS", "Midwest", 2.9],
  ["KY", "South", 4.5],
  ["LA", "South", 4.7],
  ["ME", "Northeast", 1.4],
  ["MD", "South", 6.2],
  ["MA", "Northeast", 7.0],
  ["MI", "Midwest", 10.1],
  ["MN", "Midwest", 5.7],
  ["MS", "South", 3.0],
  ["MO", "Midwest", 6.2],
  ["MT", "West", 1.1],
  ["NE", "Midwest", 2.0],
  ["NV", "West", 3.1],
  ["NH", "Northeast", 1.4],
  ["NJ", "Northeast", 9.3],
  ["NM", "West", 2.1],
  ["NY", "Northeast", 20.2],
  ["NC", "South", 10.4],
  ["ND", "Midwest", 0.8],
  ["OH", "Midwest", 11.8],
  ["OK", "South", 4.0],
  ["OR", "West", 4.2],
  ["PA", "Northeast", 13.0],
  ["RI", "Northeast", 1.1],
  ["SC", "South", 5.1],
  ["SD", "Midwest", 0.9],
  ["TN", "South", 6.9],
  ["TX", "South", 29.1],
  ["UT", "West", 3.3],
  ["VT", "Northeast", 0.6],
  ["VA", "South", 8.6],
  ["WA", "West", 7.7],
  ["WV", "South", 1.8],
  ["WI", "Midwest", 5.9],
  ["WY", "West", 0.6],
];

const PLANS: readonly [string, number, number, number][] = [
  ["Starter", 0.55, 20, 150],
  ["Growth", 0.33, 120, 600],
  ["Enterprise", 0.12, 800, 4000],
];

const INDUSTRIES = [
  "Apparel",
  "Home & Garden",
  "Electronics",
  "Beauty",
  "Food & Beverage",
  "Sports & Outdoors",
  "Toys",
  "Other",
];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, items: readonly T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= weight(item);
    if (roll < 0) return item;
  }
  return items[items.length - 1] as T;
}

const START = Date.UTC(2025, 10, 1);
const DAYS = 365;

export function sampleOrdersCsv(rows = 1500, seed = 20261127): string {
  const random = lcg(seed);
  const out = ["order_id,ordered_at,customer_id,region,state,plan,industry,status,amount"];
  const lines: [number, string][] = [];
  for (let i = 0; i < rows; i++) {
    let day = Math.floor(random() * DAYS);
    for (;;) {
      const month = new Date(START + day * 86_400_000).getUTCMonth();
      if (random() < (month === 10 || month === 11 ? 1 : 0.7)) break;
      day = Math.floor(random() * DAYS);
    }
    const date = new Date(START + day * 86_400_000).toISOString().slice(0, 10);
    const [state, region] = pick(random, STATES, (s) => s[2]);
    const [plan, , low, high] = pick(random, PLANS, (p) => p[1]);
    const industry = INDUSTRIES[Math.floor(random() * INDUSTRIES.length)] ?? "Other";
    const customer = `C${String(1 + Math.floor(random() * 600)).padStart(4, "0")}`;
    const status = random() < 0.94 ? "paid" : "refunded";
    const amount = (low + (high - low) * random() ** 2).toFixed(2);
    lines.push([
      day,
      `${date},${customer},${region},${state},${plan},${industry},${status},${amount}`,
    ]);
  }
  lines.sort((a, b) => a[0] - b[0]);
  lines.forEach(([, line], i) => {
    out.push(`O${String(i + 1).padStart(5, "0")},${line}`);
  });
  return `${out.join("\n")}\n`;
}

const SCHEMA = (kind: string, depth: number): string =>
  `${depth === 0 ? "./" : "../".repeat(depth)}node_modules/hatchmark/schema/${kind}.schema.json`;

interface WeekInfo {
  firstDay: number;
}

export function sampleConfig(name: string, withData: boolean): ProjectConfig {
  const locale: Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo } =
    new Intl.Locale(PROJECT_DEFAULTS.locale);
  // Node 22 has only the older weekInfo accessor; newer runtimes replace it with getWeekInfo().
  const { firstDay } = (locale.getWeekInfo?.() ?? locale.weekInfo) as WeekInfo;
  return {
    $schema: SCHEMA("project", 0),
    ...PROJECT_DEFAULTS,
    name,
    anchors: { week: WEEKDAYS[firstDay - 1] as (typeof WEEKDAYS)[number] },
    sources: withData
      ? { orders: { type: "csv", path: "data/orders.csv", freshness: { column: "ordered_at" } } }
      : {},
  };
}

const paid = [{ column: "status", op: "eq", value: "paid" }];

export const SAMPLE_METRICS: Record<string, unknown> = {
  revenue: {
    $schema: SCHEMA("metric", 1),
    label: "Revenue",
    description: "Sum of paid order amounts.",
    type: "aggregate",
    table: "orders",
    aggregate: "sum",
    column: "amount",
    filters: paid,
    time: "ordered_at",
    format: { type: "currency", compact: true },
    better: "up",
  },
  orders: {
    $schema: SCHEMA("metric", 1),
    label: "Orders",
    description: "Number of paid orders.",
    type: "aggregate",
    table: "orders",
    aggregate: "count",
    filters: paid,
    time: "ordered_at",
    format: { type: "number" },
    better: "up",
  },
  avg_order_value: {
    $schema: SCHEMA("metric", 1),
    label: "Average order value",
    description: "Revenue divided by orders, recomputed for every group and total.",
    type: "ratio",
    numerator: "revenue",
    denominator: "orders",
    format: { type: "currency", decimals: 2 },
    better: "up",
  },
  customers: {
    $schema: SCHEMA("metric", 1),
    label: "Customers",
    description: "Distinct customers with a paid order.",
    type: "aggregate",
    table: "orders",
    aggregate: "count_distinct",
    column: "customer_id",
    filters: paid,
    time: "ordered_at",
    format: { type: "number" },
    better: "up",
  },
};

export const SAMPLE_DASHBOARD = {
  $schema: SCHEMA("dashboard", 1),
  title: "Sales overview",
  description:
    "Sample dashboard written by hatchmark init. Edit it or start a new file next to it.",
  period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
  filters: [{ type: "select", id: "region", label: "Region", column: "region" }],
  blocks: [
    { type: "kpi", id: "revenue", metric: "revenue", span: 3 },
    { type: "kpi", id: "orders", metric: "orders", span: 3 },
    { type: "kpi", id: "aov", metric: "avg_order_value", span: 3 },
    { type: "kpi", id: "customers", metric: "customers", span: 3 },
    {
      type: "line",
      id: "revenue_trend",
      title: "Revenue by week",
      metrics: ["revenue"],
      grain: "week",
      span: 12,
    },
    {
      type: "bar_list",
      id: "top_industries",
      title: "Revenue by industry",
      metric: "revenue",
      by: "industry",
      span: 6,
    },
    {
      type: "bar",
      id: "orders_by_plan",
      title: "Orders by plan",
      metrics: ["orders"],
      by: "plan",
      span: 6,
    },
    {
      type: "table",
      id: "by_state",
      title: "Revenue by region and state",
      by: ["region", "state"],
      metrics: ["revenue", "orders", "avg_order_value"],
      totals: true,
      percentOfTotal: ["revenue"],
      sort: { by: "revenue", order: "desc" },
      span: 12,
    },
    {
      type: "text",
      id: "summary",
      markdown:
        "Revenue was {{revenue}} this period, {{revenue.change_pct}} against the previous one.",
      span: 12,
    },
  ],
};

export const AGENTS_START = "<!-- hatchmark:start -->";
export const AGENTS_END = "<!-- hatchmark:end -->";

export function agentsBlock(version: string): string {
  return [
    AGENTS_START,
    "## Hatchmark",
    "",
    `This project builds dashboards with Hatchmark ${version}. Your training data likely predates this version, so trust the bundled docs over memory.`,
    "",
    "- Read `node_modules/hatchmark/docs/` before writing or editing specs. `hatchmark schema <project|metric|dashboard>` prints the JSON Schema.",
    "- One file per thing: `metrics/<name>.yaml` and `dashboards/<name>.yaml`; the file name is the name. Settings live in `hatchmark.yaml`.",
    "- Run `hatchmark check --json` after every edit and fix every error before you finish. `hatchmark explain <code>` explains a code.",
    "- Commands never prompt. Exit codes: 0 ok, 1 errors in files, 2 usage or config, 3 environment, 4 internal bug.",
    "",
    "This block is managed by `hatchmark init`; edits inside the markers are overwritten.",
    AGENTS_END,
  ].join("\n");
}
