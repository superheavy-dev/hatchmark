import { describe, expect, it } from "vitest";
import { checkReferences, groupAdditive, parseDiagnostics } from "../../src/spec/index.js";
import { CONFIG, projectFrom } from "./helpers.js";

const larkspurConfig = {
  ...CONFIG,
  name: "Larkspur",
  sources: {
    subscriptions: { type: "csv", path: "data/subscriptions.csv" },
    subscription_items: { type: "csv", path: "data/subscription_items.csv" },
    currencies: { type: "csv", path: "data/currencies.csv" },
    fx_rates: { type: "csv", path: "data/fx_rates.csv" },
    items: {
      type: "lookup",
      from: "subscription_items",
      lookups: [
        { table: "subscriptions", key: { subscription: "id" } },
        { table: "currencies", key: { currency: "code" } },
        {
          table: "fx_rates",
          key: { currency: "currency" },
          asof: { column: "date", at: "$evaluation" },
        },
      ],
    },
    invoice_lines_raw: { type: "csv", path: "data/invoice_line_items.csv" },
    invoice_lines: {
      type: "lookup",
      from: "invoice_lines_raw",
      lookups: [
        { table: "currencies", key: { currency: "code" } },
        {
          table: "fx_rates",
          key: { currency: "currency" },
          asof: { column: "date", at: "paid_at" },
        },
      ],
    },
    subscription_events: { type: "csv", path: "data/subscription_events.csv" },
    mrr_snapshots: { type: "csv", path: "data/mrr_snapshots.csv", snapshot: "snapshot_date" },
    credit_purchases: { type: "csv", path: "data/credit_purchases.csv" },
    usage: { type: "csv", path: "data/usage_daily.csv", freshness: { lag: { days: 1 } } },
    contracts: { type: "csv", path: "data/contracts.csv" },
    internal_accounts: { type: "csv", path: "data/internal_accounts.csv" },
    arr_plan: { type: "csv", path: "data/arr_plan.csv" },
  },
};

const columns: Record<string, string[]> = {
  subscriptions: [
    "id",
    "customer",
    "status",
    "trial_end",
    "cancel_at",
    "ended_at",
    "currency",
    "coupon_percent_off",
  ],
  subscription_items: [
    "id",
    "subscription",
    "plan",
    "unit_amount",
    "currency",
    "interval",
    "interval_count",
    "quantity",
    "valid_from",
    "valid_to",
  ],
  currencies: ["code", "minor"],
  fx_rates: ["date", "currency", "rate"],
  invoice_line_items: [],
  invoice_lines_raw: [
    "id",
    "customer",
    "type",
    "amount",
    "currency",
    "period_start",
    "period_end",
    "paid_at",
  ],
  subscription_events: ["subscription", "customer", "occurred_at", "plan", "mrr_after"],
  mrr_snapshots: ["snapshot_date", "subscription", "customer", "plan", "mrr_usd"],
  credit_purchases: ["customer", "created", "amount"],
  usage: ["date", "customer", "amount_usd"],
  contracts: ["customer", "signed_at", "start_date", "end_date", "acv_usd"],
  internal_accounts: ["customer"],
  arr_plan: ["month", "arr_target"],
};

const money = { format: { type: "currency", compact: true }, better: "up" };

const metrics: Record<string, unknown> = {
  arr: {
    label: "ARR",
    ...money,
    type: "aggregate",
    table: "items",
    aggregate: "sum",
    value:
      "unit_amount * quantity / currencies.minor * fx_rates.rate * match(interval, 'day', 365.0 / 12, 'week', 365.0 / 7 / 12, 'month', 1, 'year', 1.0 / 12) / interval_count * (1 - coalesce(subscriptions.coupon_percent_off, 0) / 100)",
    active: {
      from: "greatest(valid_from, coalesce(subscriptions.trial_end, valid_from))",
      to: "coalesce(valid_to, subscriptions.ended_at)",
      ends: "inclusive",
    },
    scale: 12,
    segments: ["external"],
    targets: [
      {
        id: "plan",
        label: "FY2027 plan",
        grain: "month",
        table: "arr_plan",
        date: "month",
        value: "arr_target",
      },
      {
        id: "goal",
        grain: "month",
        values: { "2026-12-01": 7400000, "2027-12-01": 12000000 },
        path: "compound",
      },
    ],
    tests: [{ at: "2026-10-31", expect: 1392474 }],
  },
  arr_snapshot: {
    label: "ARR (snapshots)",
    ...money,
    type: "aggregate",
    table: "mrr_snapshots",
    aggregate: "sum",
    column: "mrr_usd",
    scale: 12,
    time: "snapshot_date",
    over_time: "last",
  },
  arr_events: {
    label: "ARR (events)",
    ...money,
    type: "aggregate",
    table: "subscription_events",
    aggregate: "sum",
    column: "mrr_after",
    scale: 0.12,
    time: "occurred_at",
    over_time: "last",
    entity: "subscription",
  },
  mrr_invoiced: {
    label: "MRR (invoiced)",
    ...money,
    type: "aggregate",
    table: "invoice_lines",
    aggregate: "sum",
    value:
      "amount / currencies.minor * fx_rates.rate * 30.436875 / greatest(date_diff('day', period_start, period_end), 1)",
    filters: [{ column: "type", op: "eq", value: "subscription" }],
    active: { from: "period_start", to: "period_end", ends: "inclusive" },
  },
  revenue: {
    label: "Revenue",
    ...money,
    type: "aggregate",
    table: "invoice_lines",
    aggregate: "sum",
    value: "amount / currencies.minor * fx_rates.rate",
    time: "paid_at",
    tests: [{ window: ["2026-10-01", "2026-10-31"], expect: 118240.5 }],
  },
  revenue_run_rate: {
    label: "Revenue run rate (30d)",
    ...money,
    type: "aggregate",
    table: "invoice_lines",
    aggregate: "sum",
    value: "amount / currencies.minor * fx_rates.rate",
    time: "paid_at",
    trailing: { days: 30 },
    scale: 12.1667,
  },
  credit_run_rate: {
    label: "Credit purchase run rate",
    ...money,
    type: "aggregate",
    table: "credit_purchases",
    aggregate: "sum",
    column: "amount",
    time: "created",
    trailing: { days: 90 },
    scale: 0.0405556,
  },
  contracted_arr: {
    label: "Contracted ARR",
    ...money,
    type: "aggregate",
    table: "contracts",
    aggregate: "sum",
    column: "acv_usd",
    active: { from: "signed_at", to: "end_date", ends: "inclusive" },
  },
  total_arr: { label: "Total ARR", ...money, type: "formula", expr: "arr + credit_run_rate * 0.6" },
  paying_customers: {
    label: "Paying customers",
    format: { type: "number" },
    better: "up",
    type: "aggregate",
    table: "items",
    aggregate: "count_distinct",
    column: "subscriptions.customer",
    active: {
      from: "valid_from",
      to: "coalesce(valid_to, subscriptions.ended_at)",
      ends: "inclusive",
    },
  },
  arpa: { label: "ARPA", ...money, type: "formula", expr: "arr / paying_customers" },
  cohort_arr_prior: {
    label: "Cohort ARR a year ago",
    ...money,
    type: "per_entity",
    of: "arr",
    key: "subscriptions.customer",
    prior: { months: 12 },
    where: "prior > 0",
    expr: "prior",
    group_at: "current",
  },
  cohort_arr_now: {
    label: "Cohort ARR now",
    ...money,
    type: "per_entity",
    of: "arr",
    key: "subscriptions.customer",
    prior: { months: 12 },
    where: "prior > 0",
    group_at: "current",
  },
  cohort_arr_retained: {
    label: "Cohort ARR retained",
    ...money,
    type: "per_entity",
    of: "arr",
    key: "subscriptions.customer",
    prior: { months: 12 },
    where: "prior > 0",
    expr: "least(current, prior)",
    group_at: "current",
  },
  nrr: {
    label: "NRR",
    format: { type: "percent", decimals: 1 },
    better: "up",
    type: "formula",
    expr: "cohort_arr_now / cohort_arr_prior",
  },
  grr: {
    label: "GRR",
    format: { type: "percent", decimals: 1 },
    better: "up",
    type: "formula",
    expr: "cohort_arr_retained / cohort_arr_prior",
  },
};

const segments = {
  external: {
    label: "External customers",
    filters: [
      {
        column: "subscriptions.customer",
        op: "not_in_table",
        table: "internal_accounts",
        key: "customer",
      },
    ],
  },
};

type Attack = {
  metrics?: Record<string, unknown>;
  config?: unknown;
  segments?: Record<string, unknown>;
  dashboards?: Record<string, unknown>;
  cols?: Record<string, string[]>;
};

const run = (o: Attack) => {
  const project = projectFrom({
    config: o.config ?? larkspurConfig,
    metrics: { ...metrics, ...(o.metrics ?? {}) },
    segments: { ...segments, ...(o.segments ?? {}) },
    dashboards: o.dashboards ?? {},
    columns: { ...columns, ...(o.cols ?? {}) },
  });
  const diags = [...parseDiagnostics(project), ...checkReferences(project)]
    .filter((d) => d.severity !== "note")
    .map((d) => `${d.file} ${d.severity} ${d.code}`);
  const specs = new Map([...project.metrics].map(([k, v]) => [k, v.spec as never]));
  return { diags, specs };
};

function attack(name: string, o: Attack, expected: string[], groupAdditiveX?: boolean) {
  it(name, () => {
    const { diags, specs } = run(o);
    expect(diags).toEqual(expected);
    if (groupAdditiveX !== undefined) expect(groupAdditive("x", specs)).toBe(groupAdditiveX);
  });
}

const x =
  (file = "metrics/x.json") =>
  (code: string, severity = "error") =>
    `${file} ${severity} ${code}`;
const err = x();
const errY = x("metrics/y.json");
const table = (m: string) => ({
  d: {
    title: "T",
    blocks: [
      { type: "table", id: "t", by: ["plan"], metrics: [m], totals: true, percentOfTotal: [m] },
    ],
  },
});
const percentOfTotal = "dashboards/d.json error HM4001";
const snap = {
  ...money,
  type: "aggregate",
  table: "mrr_snapshots",
  aggregate: "sum",
  column: "mrr_usd",
  label: "x",
};
const arrEur = {
  ...(metrics.arr as object),
  label: "ARR EUR",
  format: { type: "currency", currency: "EUR" },
  targets: undefined,
  tests: undefined,
};
const num = { format: { type: "number" }, better: "up" };
const rev = metrics.revenue as Record<string, unknown>;
const snapLookup = {
  ...larkspurConfig,
  sources: {
    ...larkspurConfig.sources,
    snaps: {
      type: "lookup",
      from: "mrr_snapshots",
      lookups: [{ table: "customers2", key: { customer: "id" } }],
    },
    customers2: { type: "csv", path: "data/c.csv" },
  },
};
const internalLookup = {
  ...larkspurConfig,
  sources: {
    ...larkspurConfig.sources,
    internal_lk: {
      type: "lookup",
      from: "internal_accounts",
      lookups: [{ table: "customers2", key: { customer: "id" } }],
    },
    customers2: { type: "csv", path: "data/c.csv" },
  },
};
const customers2 = { customers2: ["id", "country"] };
const notInternal = {
  column: "customer",
  op: "not_in_table",
  table: "internal_lk",
  key: "customer",
};
const withFixture = (filters: unknown[], data: Record<string, string>, where?: unknown[]) => ({
  ...rev,
  filters,
  tests: [{ window: ["2026-10-01", "2026-10-31"], data, ...(where ? { where } : {}), expect: 1 }],
});
const windowTest = (extra: Record<string, unknown>) => ({
  ...rev,
  tests: [{ window: ["2026-10-01", "2026-10-31"], expect: 1, ...extra }],
});

describe("the Larkspur baseline validates clean", () => {
  attack("baseline fixture has no errors or warnings", {}, []);
});

describe("a snapshot source is never summed across snapshots (HM4007)", () => {
  attack(
    "trailing sum on a snapshot source",
    { metrics: { x: { ...snap, time: "snapshot_date", trailing: { days: 30 } } } },
    [err("HM4007")],
  );
  attack(
    "trailing with explicit over_time sum on a snapshot source",
    {
      metrics: { x: { ...snap, time: "snapshot_date", over_time: "sum", trailing: { days: 30 } } },
    },
    [err("HM4007")],
  );
  attack("sum with no time column on a snapshot source", { metrics: { x: { ...snap } } }, [
    err("HM4007"),
  ]);
  attack(
    "count with no time column on a snapshot source",
    {
      metrics: {
        x: { ...snap, aggregate: "count", column: undefined, format: { type: "number" } },
      },
    },
    [err("HM4007")],
  );
  attack(
    "active interval on snapshot rows",
    {
      metrics: { x: { ...snap, active: { from: "snapshot_date", to: "null", ends: "inclusive" } } },
    },
    [err("HM4007")],
  );
  attack(
    "time column other than the snapshot column",
    {
      metrics: { x: { ...snap, time: "created", over_time: "last" } },
      cols: { mrr_snapshots: [...(columns.mrr_snapshots as string[]), "created"] },
    },
    [err("HM4007")],
  );
  attack(
    "at-test on a timeless snapshot sum still reports the snapshot sum",
    { metrics: { x: { ...snap, tests: [{ at: "2026-10-31", expect: 1 }] } } },
    [err("HM4007")],
  );
  attack(
    "target path and prorate on a timeless snapshot sum still report the snapshot sum",
    {
      metrics: {
        x: {
          ...snap,
          targets: [
            {
              id: "t",
              grain: "month",
              values: { "2026-01-01": 1 },
              path: "compound",
              prorate: "days",
            },
          ],
        },
      },
    },
    [err("HM4007")],
  );
  attack(
    "trailing on a lookup whose base is a snapshot",
    {
      config: snapLookup,
      cols: customers2,
      metrics: { x: { ...snap, table: "snaps", time: "snapshot_date", trailing: { days: 30 } } },
    },
    [err("HM4007")],
  );
  attack(
    "sql metric on a snapshot source warns",
    {
      metrics: {
        x: {
          ...money,
          label: "x",
          type: "sql",
          table: "mrr_snapshots",
          sql: "sum(mrr_usd)",
          additive: true,
          time: "snapshot_date",
        },
      },
    },
    [err("HM4007", "warning")],
  );
  attack(
    "over_time last with entity on a snapshot source",
    {
      metrics: { x: { ...snap, time: "snapshot_date", over_time: "last", entity: "subscription" } },
    },
    [err("HM4007")],
  );
  attack(
    "over_time first with entity through a lookup over a snapshot",
    {
      config: snapLookup,
      cols: customers2,
      metrics: {
        x: {
          ...snap,
          table: "snaps",
          time: "snapshot_date",
          over_time: "first",
          entity: "subscription",
        },
      },
    },
    [err("HM4007")],
  );
  attack(
    "snapshot column matched case-insensitively passes",
    { metrics: { x: { ...snap, time: "Snapshot_Date", over_time: "last" } } },
    [],
  );
  attack(
    "entity on an event log passes",
    { metrics: { x: { ...(metrics.arr_events as object) } } },
    [],
  );
  attack(
    "over_time last without entity on an event log is accepted today (not covered)",
    { metrics: { x: { ...(metrics.arr_events as object), entity: undefined } } },
    [],
  );
});

describe("percent of total only for group-additive metrics (HM4001)", () => {
  attack(
    "affine formula arr + 1000 is not group-additive",
    {
      metrics: { x: { ...money, label: "x", type: "formula", expr: "arr + 1000" } },
      dashboards: table("x"),
    },
    [percentOfTotal],
    false,
  );
  attack(
    "over_time max is not group-additive",
    {
      metrics: { x: { ...snap, time: "snapshot_date", over_time: "max" } },
      dashboards: table("x"),
    },
    [percentOfTotal],
    false,
  );
  attack(
    "over_time min is not group-additive",
    {
      metrics: { x: { ...snap, time: "snapshot_date", over_time: "min" } },
      dashboards: table("x"),
    },
    [percentOfTotal],
  );
  attack(
    "count_distinct with scale is not group-additive",
    {
      metrics: { x: { ...(metrics.paying_customers as object), scale: 2 } },
      dashboards: table("x"),
    },
    [percentOfTotal],
  );
  attack(
    "linear formula arr * (1 + 0.5) stays group-additive",
    {
      metrics: { x: { ...money, label: "x", type: "formula", expr: "arr * (1 + 0.5)" } },
      dashboards: table("x"),
    },
    [],
    true,
  );
});

describe("currencies never mix and a format never relabels one (HM4005)", () => {
  attack(
    "coalesce(arr_eur, arr) mixes currencies",
    {
      metrics: {
        arr_eur: arrEur,
        x: { ...money, label: "x", type: "formula", expr: "coalesce(arr_eur, arr)" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "abs(arr_eur) + arr mixes currencies",
    {
      metrics: {
        arr_eur: arrEur,
        x: { ...money, label: "x", type: "formula", expr: "abs(arr_eur) + arr" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "max(arr_eur, arr) mixes currencies",
    {
      metrics: {
        arr_eur: arrEur,
        x: { ...money, label: "x", type: "formula", expr: "max(arr_eur, arr)" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "coalesce(arr_eur, 0) + arr mixes currencies",
    {
      metrics: {
        arr_eur: arrEur,
        x: { ...money, label: "x", type: "formula", expr: "coalesce(arr_eur, 0) + arr" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "arr_eur + arr mixes currencies",
    {
      metrics: {
        arr_eur: arrEur,
        x: { ...money, label: "x", type: "formula", expr: "arr_eur + arr" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "USD formula over arr_eur relabels it, then + arr mixes",
    {
      metrics: {
        arr_eur: arrEur,
        eur_as_usd: { ...money, label: "x", type: "formula", expr: "arr_eur" },
        x: { ...money, label: "x", type: "formula", expr: "eur_as_usd + arr" },
      },
    },
    [x("metrics/eur_as_usd.json")("HM4005"), err("HM4005")],
  );
  attack(
    "USD formula over arr_eur / paying_customers relabels EUR",
    {
      metrics: {
        arr_eur: arrEur,
        x: { ...money, label: "x", type: "formula", expr: "arr_eur / paying_customers" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "relabelling formula then + arpa reports both",
    {
      metrics: {
        arr_eur: arrEur,
        y: { ...money, label: "x", type: "formula", expr: "arr_eur / paying_customers" },
        x: { ...money, label: "x", type: "formula", expr: "y + arpa" },
      },
    },
    [errY("HM4005"), err("HM4005")],
  );
  attack(
    "USD ratio over arr_eur / paying_customers relabels EUR",
    {
      metrics: {
        arr_eur: arrEur,
        x: {
          label: "x",
          format: { type: "currency" },
          better: "up",
          type: "ratio",
          numerator: "arr_eur",
          denominator: "paying_customers",
        },
      },
    },
    [err("HM4005")],
  );
  attack(
    "relabelling ratio then + arpa reports both",
    {
      metrics: {
        arr_eur: arrEur,
        y: {
          label: "x",
          format: { type: "currency" },
          better: "up",
          type: "ratio",
          numerator: "arr_eur",
          denominator: "paying_customers",
        },
        x: { ...money, label: "x", type: "formula", expr: "y + arpa" },
      },
    },
    [errY("HM4005"), err("HM4005")],
  );
  attack(
    "USD per_entity of arr_eur relabels EUR",
    { metrics: { arr_eur: arrEur, x: { ...(metrics.cohort_arr_now as object), of: "arr_eur" } } },
    [err("HM4005")],
  );
  attack(
    "relabelling per_entity then + arr reports both",
    {
      metrics: {
        arr_eur: arrEur,
        y: { ...(metrics.cohort_arr_now as object), of: "arr_eur" },
        x: { ...money, label: "x", type: "formula", expr: "y + arr" },
      },
    },
    [errY("HM4005"), err("HM4005")],
  );
  attack(
    "EUR per_entity correctly formatted, + arr mixes",
    {
      metrics: {
        arr_eur: arrEur,
        y: {
          ...(metrics.cohort_arr_now as object),
          of: "arr_eur",
          format: { type: "currency", currency: "EUR" },
        },
        x: { ...money, label: "x", type: "formula", expr: "y + arr" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "EUR formula arr_eur / paying_customers, + arpa mixes",
    {
      metrics: {
        arr_eur: arrEur,
        y: {
          label: "x",
          format: { type: "currency", currency: "EUR" },
          better: "up",
          type: "formula",
          expr: "arr_eur / paying_customers",
        },
        x: { ...money, label: "x", type: "formula", expr: "y + arpa" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "number-format formula keeps EUR, + arr mixes",
    {
      metrics: {
        arr_eur: arrEur,
        y: { label: "x", ...num, type: "formula", expr: "arr_eur * 2" },
        x: { ...money, label: "x", type: "formula", expr: "y + arr" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "paying_customers * arr_eur shown as USD relabels EUR",
    {
      metrics: {
        arr_eur: arrEur,
        x: { ...money, label: "x", type: "formula", expr: "paying_customers * arr_eur" },
      },
    },
    [err("HM4005")],
  );
  attack(
    "USD over USD ratio shown as percent passes",
    {
      metrics: {
        x: {
          label: "x",
          format: { type: "percent" },
          better: "up",
          type: "ratio",
          numerator: "arr",
          denominator: "contracted_arr",
        },
      },
    },
    [],
  );
  attack(
    "per_entity count shown as a number passes",
    {
      metrics: {
        x: {
          ...(metrics.cohort_arr_now as object),
          aggregate: "count",
          format: { type: "number" },
        },
      },
    },
    [],
  );
  attack(
    "percent + currency is accepted today, HM4005 covers currency codes only (not covered)",
    { metrics: { x: { ...money, label: "x", type: "formula", expr: "nrr + arr" } } },
    [],
  );
});

describe("time natures combine only where they mean something", () => {
  attack(
    "flow metric on an evaluation-instant lookup (HM4019)",
    {
      metrics: {
        x: {
          ...money,
          label: "x",
          type: "aggregate",
          table: "items",
          aggregate: "sum",
          value: "unit_amount * quantity / currencies.minor * fx_rates.rate",
          time: "valid_from",
        },
      },
    },
    [err("HM4019")],
  );
  attack(
    "timeless metric on an evaluation-instant lookup (HM4019)",
    {
      metrics: {
        x: {
          ...money,
          label: "x",
          type: "aggregate",
          table: "items",
          aggregate: "sum",
          value: "unit_amount * fx_rates.rate",
        },
      },
    },
    [err("HM4019")],
  );
  attack(
    "flow metric through an as-of lookup on a declared snapshot passes",
    {
      config: {
        ...larkspurConfig,
        sources: {
          ...larkspurConfig.sources,
          fx_rates: { type: "csv", path: "data/fx_rates.csv", snapshot: "date" },
        },
      },
    },
    [],
  );
  attack(
    "per_entity of over_time max has no value at an instant (HM4008)",
    {
      metrics: {
        peak: { ...snap, time: "snapshot_date", over_time: "max" },
        x: {
          ...money,
          label: "x",
          type: "per_entity",
          of: "peak",
          key: "customer",
          prior: { months: 12 },
          group_at: "current",
        },
      },
    },
    [err("HM4008")],
  );
  attack(
    "per_entity of a formula of point sums (HM4008)",
    {
      metrics: {
        f: { ...money, label: "x", type: "formula", expr: "arr + contracted_arr" },
        x: { ...(metrics.cohort_arr_now as object), of: "f" },
      },
    },
    [err("HM4008")],
  );
  attack(
    "per_entity of a trailing sum passes",
    {
      metrics: {
        x: { ...(metrics.cohort_arr_now as object), of: "credit_run_rate", key: "customer" },
      },
    },
    [],
  );
  attack(
    "point metric + flow metric (HM4009)",
    { metrics: { x: { ...money, label: "x", type: "formula", expr: "arr + revenue * 12" } } },
    [err("HM4009")],
  );
  attack(
    "point over static ratio passes",
    {
      metrics: {
        x: {
          label: "x",
          format: { type: "percent" },
          better: "up",
          type: "ratio",
          numerator: "arr",
          denominator: "paying_customers",
        },
      },
    },
    [],
  );
  attack(
    "constant-only formula passes",
    { metrics: { x: { ...money, label: "x", type: "formula", expr: "12" } } },
    [],
  );
  attack(
    "trailing windows of different lengths are accepted today (not covered)",
    {
      metrics: {
        x: { ...money, label: "x", type: "formula", expr: "credit_run_rate + revenue_run_rate" },
      },
    },
    [],
  );
  attack(
    "lookup on a rate table without asof is accepted today, it multiplies rows (not covered)",
    {
      config: {
        ...larkspurConfig,
        sources: {
          ...larkspurConfig.sources,
          inv2: {
            type: "lookup",
            from: "invoice_lines_raw",
            lookups: [{ table: "fx_rates", key: { currency: "currency" } }],
          },
        },
      },
      metrics: {
        x: {
          ...money,
          label: "x",
          type: "aggregate",
          table: "inv2",
          aggregate: "sum",
          value: "amount * fx_rates.rate",
          time: "paid_at",
        },
      },
    },
    [],
  );
});

describe("targets prorate by days only for metrics that add up over time", () => {
  attack(
    "prorate days on an avg flow target (HM3007)",
    {
      metrics: {
        x: {
          ...money,
          label: "x",
          type: "aggregate",
          table: "invoice_lines",
          aggregate: "avg",
          column: "amount",
          time: "paid_at",
          targets: [{ id: "t", grain: "month", values: { "2026-01-01": 80 }, prorate: "days" }],
        },
      },
    },
    [err("HM3007")],
  );
  attack(
    "default prorate on a ratio flow target passes",
    {
      metrics: {
        inv: {
          ...money,
          label: "x",
          type: "aggregate",
          table: "invoice_lines",
          aggregate: "count",
          time: "paid_at",
        },
        x: {
          label: "x",
          format: { type: "currency" },
          better: "up",
          type: "ratio",
          numerator: "revenue",
          denominator: "inv",
          targets: [{ id: "t", grain: "month", values: { "2026-01-01": 80 } }],
        },
      },
    },
    [],
  );
});

describe("metric tests read only what the metric reads", () => {
  attack(
    "data fixture for a source the metric does not read (HM2023)",
    { metrics: { x: windowTest({ data: { usage: "tests/data/u.csv" } }) } },
    [err("HM2023")],
  );
  attack(
    "window test on a point metric must use at (HM3007)",
    {
      metrics: {
        x: {
          ...(metrics.credit_run_rate as object),
          tests: [{ window: ["2026-10-01", "2026-10-31"], expect: 1 }],
        },
      },
    },
    [err("HM3007")],
  );
  attack(
    "fixture for the from of a metric filter's in_table lookup passes",
    {
      config: internalLookup,
      cols: customers2,
      metrics: { x: withFixture([notInternal], { internal_accounts: "t.csv" }) },
    },
    [],
  );
  attack(
    "fixture for the lookup table of a metric filter's in_table lookup passes",
    {
      config: internalLookup,
      cols: customers2,
      metrics: { x: withFixture([notInternal], { customers2: "t.csv" }) },
    },
    [],
  );
  attack(
    "fixture for the from of a tests.where in_table lookup passes",
    {
      config: internalLookup,
      cols: customers2,
      metrics: { x: withFixture([], { internal_accounts: "t.csv" }, [notInternal]) },
    },
    [],
  );
  attack(
    "fixture for the from of a segment's in_table lookup passes",
    {
      config: internalLookup,
      cols: customers2,
      segments: { ext2: { label: "Ext", filters: [notInternal] } },
      metrics: { x: { ...withFixture([], { internal_accounts: "t.csv" }), segments: ["ext2"] } },
    },
    [],
  );
  attack(
    "fixture for an unrelated source next to an in_table lookup (HM2023)",
    {
      config: internalLookup,
      cols: customers2,
      metrics: { x: withFixture([notInternal], { usage: "t.csv" }) },
    },
    [err("HM2023")],
  );
  attack(
    "test where column missing from the source is accepted today (not covered)",
    { metrics: { x: windowTest({ where: [{ column: "nope", op: "eq", value: 1 }] }) } },
    [],
  );
  attack(
    "test by column missing from the source is accepted today (not covered)",
    { metrics: { x: windowTest({ by: "nope", expect: { a: 1 } }) } },
    [],
  );
  attack(
    "contradicting duplicate tests are accepted today (not covered)",
    {
      metrics: {
        x: {
          ...rev,
          tests: [
            { window: ["2026-10-01", "2026-10-31"], expect: 1 },
            { window: ["2026-10-01", "2026-10-31"], expect: 2 },
          ],
        },
      },
    },
    [],
  );
  attack(
    "test with a known segment passes",
    { metrics: { x: windowTest({ segments: ["external"] }) } },
    [],
  );
});

describe("column references resolve against the source (HM2018)", () => {
  attack(
    "per_entity key missing from the source",
    { metrics: { x: { ...(metrics.cohort_arr_now as object), key: "nope" } } },
    [err("HM2018")],
  );
  attack(
    "uppercase NULL in active.to is read as a column",
    {
      metrics: {
        x: {
          ...(metrics.contracted_arr as object),
          active: { from: "signed_at", to: "coalesce(end_date, NULL)", ends: "inclusive" },
        },
      },
    },
    [err("HM2018")],
  );
  attack(
    "as-of at column taken from the lookup table, not the base",
    {
      config: {
        ...larkspurConfig,
        sources: {
          ...larkspurConfig.sources,
          inv3: {
            type: "lookup",
            from: "invoice_lines_raw",
            lookups: [
              {
                table: "fx_rates",
                key: { currency: "currency" },
                asof: { column: "date", at: "fx_rates.date" },
              },
            ],
          },
        },
      },
    },
    ["hatchmark.json error HM2018"],
  );
  attack(
    "SQL comment in a value expression is accepted today (not covered)",
    {
      metrics: {
        x: {
          ...(metrics.contracted_arr as object),
          value: "acv_usd -- customer",
          column: undefined,
        },
      },
    },
    [],
  );
  attack(
    "active from a literal null is accepted today, caught at data time (not covered)",
    {
      metrics: {
        x: {
          ...(metrics.contracted_arr as object),
          active: { from: "null", to: "end_date", ends: "inclusive" },
        },
      },
    },
    [],
  );
  attack(
    "active from equal to to is accepted today (not covered)",
    {
      metrics: {
        x: {
          ...(metrics.contracted_arr as object),
          active: { from: "end_date", to: "end_date", ends: "inclusive" },
        },
      },
    },
    [],
  );
  attack(
    "active from a numeric expression is accepted today, needs column types (not covered)",
    {
      metrics: {
        x: {
          ...(metrics.contracted_arr as object),
          active: { from: "acv_usd * 2", to: "end_date", ends: "inclusive" },
        },
      },
    },
    [],
  );
});
