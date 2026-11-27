import type { TableData, TableRow, Value } from "../src/compiler/dashboard-data.js";
import { COUNTRIES, COUNTRY_TABLE, LAST_12, OCT, REGIONS, round } from "./fixtures.js";

/**
 * Table variants for the phase 1 table features: sorting, top N with Other, subtotals, in-cell
 * bars and the sticky header of a tall table. Every number is derived here from per-row parts
 * (revenue, orders, customers), so totals, subtotals, Other rows and shares agree the way the
 * engine computes them: sums add, averages divide summed parts, distinct counts never fold.
 */

type Key = string | null;
interface Part {
  keys: Key[];
  revenue: number;
  orders: number;
  customers: number;
}

const OCT_REVENUE = 1_843_210;

const countryParts: Part[] = COUNTRIES.map((c) => {
  const revenue = round(OCT_REVENUE * c.share);
  const orders = round(revenue / c.aov);
  return { keys: [c.region, c.name], revenue, orders, customers: round(orders * 0.83) };
});

/** Customers over several rows: a distinct count, so not the sum (repeat buyers across rows). */
const distinctCustomers = (parts: Part[]) =>
  round(parts.reduce((sum, p) => sum + p.customers, 0) * 0.96);

const sum = (parts: Part[], key: "revenue" | "orders") =>
  parts.reduce((total, p) => total + p[key], 0);

const values = (parts: Part[], metrics: string[], customers: Value): Record<string, Value> => {
  const revenue = sum(parts, "revenue");
  const orders = sum(parts, "orders");
  const all: Record<string, Value> = {
    revenue,
    orders,
    avg_order_value: orders === 0 ? null : revenue / orders,
    customers,
  };
  return Object.fromEntries(metrics.map((m) => [m, all[m] ?? null]));
};

function build(
  parts: Part[],
  options: {
    metrics: string[];
    width: 1 | 2;
    percent?: boolean;
    limit?: number;
    other?: boolean;
    subtotals?: boolean;
    sortBy?: "revenue" | "orders";
  },
): Pick<TableData, "rows" | "rowCount" | "total" | "subtotals" | "sort"> {
  const by = options.sortBy ?? "revenue";
  const total = sum(parts, "revenue");
  const keyed = (p: Part): Key[] => (options.width === 1 ? [p.keys[1] ?? null] : p.keys);
  const row = (keys: Key[], group: Part[], customers: Value, extra: Partial<TableRow> = {}) => {
    const v = values(group, options.metrics, customers);
    return {
      keys,
      ...extra,
      values: v,
      ...(options.percent ? { share: { revenue: (v.revenue as number) / total } } : {}),
    };
  };
  const cut = (group: Part[], parent: Key[]): TableRow[] => {
    const sorted = [...group].sort((a, b) => b[by] - a[by]);
    const shown = options.limit === undefined ? sorted : sorted.slice(0, options.limit);
    const rest = sorted.slice(shown.length);
    return [
      ...shown.map((p) => row(keyed(p), [p], p.customers)),
      ...(options.other && rest.length > 0
        ? [
            row(
              [...parent, ...Array.from({ length: options.width - parent.length }, () => null)],
              rest,
              null,
              { kind: "other" as const, count: rest.length },
            ),
          ]
        : []),
    ];
  };
  const rows = options.subtotals
    ? REGIONS.map((r) => r.name)
        .concat("Africa")
        .map((region) => ({ region, group: parts.filter((p) => p.keys[0] === region) }))
        .sort((a, b) => sum(b.group, by) - sum(a.group, by))
        .flatMap(({ region, group }) => [
          row([region, null], group, distinctCustomers(group), { kind: "subtotal", level: 1 }),
          ...cut(group, [region]),
        ])
    : cut(parts, []);
  return {
    rows,
    rowCount: parts.length,
    total: {
      values: values(parts, options.metrics, distinctCustomers(parts)),
      ...(options.percent ? { share: { revenue: 1 } } : {}),
    },
    ...(options.subtotals ? { subtotals: true } : {}),
    sort: { by, order: "desc" },
  };
}

const COUNTRY = [{ column: "country", label: "Country" }];
const REGION_COUNTRY = [
  { column: "region", label: "Region" },
  { column: "country", label: "Country" },
];

const base = (id: string, title: string): Omit<TableData, "rows" | "rowCount"> => ({
  type: "table",
  id,
  title,
  span: 12,
  by: COUNTRY,
  metrics: ["revenue", "orders", "avg_order_value"],
  percentOfTotal: ["revenue"],
  window: OCT,
});

const sortedByOrders = [...COUNTRY_TABLE.rows].sort(
  (a, b) => (a.values.orders ?? 0) - (b.values.orders ?? 0),
);

export const TABLE_SORTED: TableData = {
  ...COUNTRY_TABLE,
  id: "sorted",
  title: "Countries with the fewest orders, sorted by orders ascending",
  rows: sortedByOrders,
  sort: { by: "orders", order: "asc" },
};

export const TABLE_TOP_OTHER: TableData = {
  ...base("top_other", "The top 8 countries bring in 79% of October revenue"),
  ...build(countryParts, {
    metrics: ["revenue", "orders", "avg_order_value"],
    width: 1,
    percent: true,
    limit: 8,
    other: true,
  }),
};

export const TABLE_OTHER_DISTINCT: TableData = {
  ...base("other_distinct", "Customers by country: Other cannot add up distinct customers"),
  metrics: ["revenue", "customers"],
  percentOfTotal: [],
  ...build(countryParts, { metrics: ["revenue", "customers"], width: 1, limit: 5, other: true }),
};

export const TABLE_SUBTOTALS: TableData = {
  ...base("subtotals", "North America is 46% of revenue, led by the United States"),
  by: REGION_COUNTRY,
  bars: ["revenue"],
  ...build(countryParts, {
    metrics: ["revenue", "orders", "avg_order_value"],
    width: 2,
    percent: true,
    subtotals: true,
  }),
};

export const TABLE_SUBTOTALS_OTHER: TableData = {
  ...base("subtotals_other", "The top 3 countries of each region, the rest folded into Other"),
  by: REGION_COUNTRY,
  ...build(countryParts, {
    metrics: ["revenue", "orders", "avg_order_value"],
    width: 2,
    percent: true,
    subtotals: true,
    limit: 3,
    other: true,
  }),
};

export const TABLE_BARS: TableData = {
  ...base("bars", "Revenue and orders by country, with in-cell bars"),
  percentOfTotal: [],
  metrics: ["revenue", "orders", "avg_order_value"],
  bars: ["revenue", "orders"],
  ...build(countryParts, {
    metrics: ["revenue", "orders", "avg_order_value"],
    width: 1,
    limit: 10,
  }),
};

const LINES: [string, number][] = [
  ["Tents and shelters", 182_400],
  ["Footwear", 141_250],
  ["Apparel", 96_800],
  ["Camp kitchen", 31_900],
  ["Climbing hardware, ropes, harnesses and protection", 12_300],
  ["Bikes and accessories", -18_750],
  ["Clearance and returns", -64_200],
];

export const TABLE_BARS_NEGATIVE: TableData = {
  type: "table",
  id: "bars_negative",
  title: "Two product lines lost cash in the last 12 months",
  span: 12,
  by: [{ column: "product_line", label: "Product line" }],
  metrics: ["net_cash_flow"],
  percentOfTotal: [],
  bars: ["net_cash_flow"],
  rows: LINES.map(([name, value]) => ({ keys: [name], values: { net_cash_flow: value } })),
  rowCount: LINES.length,
  total: { values: { net_cash_flow: LINES.reduce((a, [, v]) => a + v, 0) } },
  sort: { by: "net_cash_flow", order: "desc" },
  window: LAST_12,
};

/** US states with rough population weights (millions), for a tall table. */
const STATES: [string, number][] = [
  ["California", 39.0],
  ["Texas", 30.5],
  ["Florida", 22.6],
  ["New York", 19.6],
  ["Pennsylvania", 13.0],
  ["Illinois", 12.5],
  ["Ohio", 11.8],
  ["Georgia", 11.0],
  ["North Carolina", 10.8],
  ["Michigan", 10.0],
  ["New Jersey", 9.3],
  ["Virginia", 8.7],
  ["Washington", 7.8],
  ["Arizona", 7.4],
  ["Tennessee", 7.1],
  ["Massachusetts", 7.0],
  ["Indiana", 6.9],
  ["Missouri", 6.2],
  ["Maryland", 6.2],
  ["Wisconsin", 5.9],
  ["Colorado", 5.9],
  ["Minnesota", 5.7],
  ["South Carolina", 5.4],
  ["Alabama", 5.1],
  ["Louisiana", 4.6],
  ["Kentucky", 4.5],
  ["Oregon", 4.2],
  ["Oklahoma", 4.1],
  ["Connecticut", 3.6],
  ["Utah", 3.4],
  ["Iowa", 3.2],
  ["Nevada", 3.2],
  ["Arkansas", 3.1],
  ["Mississippi", 2.9],
  ["Kansas", 2.9],
  ["New Mexico", 2.1],
  ["Nebraska", 2.0],
  ["Idaho", 2.0],
  ["West Virginia", 1.8],
  ["Hawaii", 1.4],
  ["New Hampshire", 1.4],
  ["Maine", 1.4],
  ["Montana", 1.1],
  ["Rhode Island", 1.1],
  ["Delaware", 1.0],
  ["South Dakota", 0.9],
  ["North Dakota", 0.8],
  ["Alaska", 0.7],
  ["Vermont", 0.6],
  ["Wyoming", 0.6],
];

const statePart = ([name, weight]: [string, number], i: number): Part => {
  const revenue = round(722_540 * (weight / 334.9) * (0.92 + ((i * 37) % 17) / 100));
  const orders = round(revenue / (88 + ((i * 13) % 11)));
  return { keys: [null, name], revenue, orders, customers: round(orders * 0.8) };
};

export const TABLE_TALL: TableData = {
  ...base("states", "Revenue by US state: the header and total stay in view while you scroll"),
  by: [{ column: "state", label: "State" }],
  bars: ["revenue"],
  ...build(STATES.map(statePart), {
    metrics: ["revenue", "orders", "avg_order_value"],
    width: 1,
    percent: true,
  }),
};
