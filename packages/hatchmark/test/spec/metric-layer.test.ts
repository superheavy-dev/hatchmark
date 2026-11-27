import { describe, expect, it } from "vitest";
import {
  checkReferences,
  dashboardsAffectedBy,
  groupAdditive,
  parseDiagnostics,
  timeNature,
} from "../../src/spec/index.js";
import { applyFix, CONFIG, projectFrom } from "./helpers.js";

/**
 * The expressiveness test from RFC 0001: a synthetic US SaaS company (Larkspur) shaped like a
 * Stripe export, with every common ARR method written in the grammar. No keyword in the schema is
 * SaaS-specific; these files must validate with no errors.
 */
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

const larkspur = (
  over: {
    metrics?: Record<string, unknown>;
    config?: unknown;
    segments?: Record<string, unknown>;
  } = {},
) =>
  projectFrom({
    config: over.config ?? larkspurConfig,
    metrics: over.metrics ?? metrics,
    segments: over.segments ?? segments,
    dashboards: {},
    columns,
  });

const diagnose = (over: Parameters<typeof larkspur>[0] = {}) => {
  const project = larkspur(over);
  return [...parseDiagnostics(project), ...checkReferences(project)];
};

const withMetric = (name: string, value: unknown) => ({ metrics: { ...metrics, [name]: value } });

describe("RFC 0001 expressiveness test (Larkspur)", () => {
  it("validates every ARR method with no diagnostics", () => {
    expect(diagnose().map((d) => `${d.file} ${d.code} ${d.message}`)).toEqual([]);
  });

  it("derives time nature and additivity through formulas and per_entity", () => {
    const project = larkspur();
    const map = new Map([...project.metrics].map(([k, v]) => [k, v.spec as never]));
    expect(timeNature("arr", map)).toBe("point");
    expect(timeNature("revenue", map)).toBe("flow");
    expect(timeNature("revenue_run_rate", map)).toBe("point");
    expect(timeNature("total_arr", map)).toBe("point");
    expect(timeNature("nrr", map)).toBe("point");
    expect(groupAdditive("total_arr", map)).toBe(true);
    expect(groupAdditive("arpa", map)).toBe(false);
    expect(groupAdditive("nrr", map)).toBe(false);
    expect(groupAdditive("cohort_arr_retained", map)).toBe(true);
    expect(groupAdditive("paying_customers", map)).toBe(false);
  });
});

describe("metric layer checks", () => {
  it("reports an unknown name in a formula at its exact characters, with a fix", () => {
    const project = larkspur(
      withMetric("total_arr", {
        ...(metrics.total_arr as object),
        expr: "arr + credit_runrate * 0.6",
      }),
    );
    const [d, ...rest] = checkReferences(project);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM2020",
      pointer: "/expr",
      help: 'did you mean "credit_run_rate"?',
      range: { start: { line: 9, column: 18 }, end: { line: 9, column: 32 } },
    });
    const text = project.metrics.get("total_arr")?.document.text ?? "";
    expect(JSON.parse(applyFix(text, d?.fix)).expr).toBe("arr + credit_run_rate * 0.6");
  });

  it("reports formula syntax errors at the token, even after escapes", () => {
    const value = { ...(metrics.total_arr as object), expr: "arr + \u0063redit_run_rate * * 0.6" };
    const project = larkspur(withMetric("total_arr", value));
    const [d] = checkReferences(project);
    const lines = (project.metrics.get("total_arr")?.document.text ?? "").split("\n");
    const line = lines[(d?.range?.start.line ?? 1) - 1] ?? "";
    expect(d).toMatchObject({ code: "HM3010", message: 'unexpected "*"' });
    expect(line.slice((d?.range?.start.column ?? 0) - 1, (d?.range?.end.column ?? 0) - 1)).toBe(
      "*",
    );
  });

  it("finds cycles through formulas and per_entity", () => {
    const ds = checkReferences(
      larkspur({
        metrics: {
          ...metrics,
          a: { label: "A", ...money, type: "formula", expr: "b + 1" },
          b: { label: "B", ...money, type: "formula", expr: "a * 2" },
        },
      }),
    );
    expect(ds.filter((d) => d.code === "HM2004").map((d) => d.file)).toEqual([
      "metrics/a.json",
      "metrics/b.json",
    ]);
  });

  it("refuses to combine flows with point-in-time values (HM4009) and timed with untimed (HM2012)", () => {
    const ds = checkReferences(
      larkspur({
        metrics: {
          ...metrics,
          bad: { label: "Bad", ...money, type: "formula", expr: "arr + revenue * 12" },
          plain: {
            label: "Plain",
            ...money,
            type: "aggregate",
            table: "contracts",
            aggregate: "sum",
            column: "acv_usd",
          },
          mixed: { label: "Mixed", ...money, type: "formula", expr: "revenue / plain" },
          ratio: {
            label: "Ratio",
            format: { type: "number" },
            better: "up",
            type: "ratio",
            numerator: "revenue",
            denominator: "arr",
          },
        },
      }),
    );
    expect(ds.map((d) => [d.file, d.code])).toEqual([
      ["metrics/bad.json", "HM4009"],
      ["metrics/mixed.json", "HM2012"],
      ["metrics/ratio.json", "HM4009"],
    ]);
    expect(ds[0]?.help).toContain('"trailing"');
  });

  it("refuses to add different currencies (HM4005)", () => {
    const eur = {
      ...(metrics.credit_run_rate as object),
      format: { type: "currency", currency: "EUR" },
    };
    const ds = checkReferences(larkspur({ metrics: { ...metrics, credit_run_rate: eur } }));
    expect(ds.map((d) => [d.file, d.code, d.message])).toEqual([
      ["metrics/total_arr.json", "HM4005", "adds USD to EUR"],
    ]);
  });

  it("refuses to sum a declared snapshot over time (HM4007)", () => {
    const { over_time: _, ...summed } = metrics.arr_snapshot as Record<string, unknown>;
    const ds = checkReferences(larkspur(withMetric("arr_snapshot", summed)));
    expect(ds).toMatchObject([
      { code: "HM4007", pointer: "/table", file: "metrics/arr_snapshot.json" },
    ]);
  });

  it("checks per_entity: of, names and shapes", () => {
    const base = metrics.cohort_arr_retained as Record<string, unknown>;
    const ds = checkReferences(
      larkspur({
        metrics: {
          ...metrics,
          e1: { ...base, of: "revenue" },
          e2: { ...base, where: "prior" },
          e3: { ...base, expr: "least(current, piror)" },
        },
      }),
    );
    expect(ds.map((d) => [d.file, d.code, d.pointer])).toEqual([
      ["metrics/e1.json", "HM4008", "/of"],
      ["metrics/e2.json", "HM3010", "/where"],
      ["metrics/e3.json", "HM2020", "/expr"],
    ]);
    expect(ds[2]?.help).toBe('did you mean "prior"?');
  });

  it("explains defaults it applies (HM4040) and stays quiet once set", () => {
    const { group_at: _, ...cohort } = metrics.cohort_arr_now as Record<string, unknown>;
    const arr = metrics.arr as Record<string, unknown>;
    const { ends: __, ...active } = arr.active as Record<string, unknown>;
    const ds = checkReferences(
      larkspur({ metrics: { ...metrics, cohort_arr_now: cohort, arr: { ...arr, active } } }),
    );
    expect(ds.map((d) => [d.file, d.code, d.severity])).toEqual([
      ["metrics/arr.json", "HM4040", "note"],
      ["metrics/cohort_arr_now.json", "HM4040", "note"],
    ]);
  });

  it("checks columns through lookups, case-insensitively (HM2018)", () => {
    const arr = metrics.arr as Record<string, unknown>;
    const ds = checkReferences(
      larkspur(withMetric("arr", { ...arr, value: "UNIT_AMOUNT * subscriptions.quantity" })),
    );
    expect(ds).toMatchObject([
      {
        code: "HM2018",
        pointer: "/value",
        message: 'source "items" has no column "subscriptions.quantity"',
      },
    ]);
  });

  it("checks lookup sources (HM2001, HM2019, HM2018)", () => {
    const sources = { ...larkspurConfig.sources } as Record<string, unknown>;
    sources.nested = {
      type: "lookup",
      from: "items",
      lookups: [{ table: "fx_rate", key: { currency: "currency" } }],
    };
    sources.badkey = {
      type: "lookup",
      from: "subscription_items",
      lookups: [{ table: "subscriptions", key: { subscription: "uid" } }],
    };
    const ds = checkReferences(larkspur({ config: { ...larkspurConfig, sources } }));
    expect(ds.map((d) => [d.code, d.pointer])).toEqual([
      ["HM2019", "/sources/nested/from"],
      ["HM2001", "/sources/nested/lookups/0/table"],
      ["HM2018", "/sources/badkey/lookups/0/key"],
    ]);
  });

  it("checks segment references and segment filters (HM2021, HM2001)", () => {
    const arr = metrics.arr as Record<string, unknown>;
    const ds = checkReferences(
      larkspur({
        metrics: { ...metrics, arr: { ...arr, segments: ["externl"] } },
        segments: {
          external: {
            label: "x",
            filters: [{ column: "customer", op: "in_table", table: "staff", key: "customer" }],
          },
        },
      }),
    );
    expect(ds.map((d) => [d.file, d.code, d.help])).toEqual([
      ["segments/external.json", "HM2001", undefined],
      ["metrics/arr.json", "HM2021", 'did you mean "external"?'],
    ]);
  });

  it("checks targets and tests against the metric's time nature", () => {
    const arr = metrics.arr as Record<string, unknown>;
    const revenue = metrics.revenue as Record<string, unknown>;
    const ds = checkReferences(
      larkspur({
        metrics: {
          ...metrics,
          arr: {
            ...arr,
            targets: [
              { id: "a", grain: "month", values: {}, prorate: "days" },
              { id: "a", grain: "month", values: {} },
            ],
            tests: [{ window: ["2026-10-01", "2026-10-31"], expect: 1 }],
          },
          revenue: { ...revenue, tests: [{ at: "2026-10-31", expect: 1 }] },
        },
      }),
    );
    expect(ds.map((d) => [d.file, d.code, d.pointer])).toEqual([
      ["metrics/arr.json", "HM3007", "/targets/0/prorate"],
      ["metrics/arr.json", "HM2008", "/targets/1/id"],
      ["metrics/arr.json", "HM3007", "/tests/0/window"],
      ["metrics/revenue.json", "HM3007", "/tests/0/at"],
    ]);
  });

  it("rejects conflicting time properties in the schema (HM3007)", () => {
    const arr = metrics.arr_snapshot as Record<string, unknown>;
    const cases: [Record<string, unknown>, string][] = [
      [{ ...arr, active: { from: "a", to: "b" } }, "/active"],
      [{ ...arr, time: undefined }, "/over_time"],
      [{ ...arr, entity: "subscription", over_time: "avg" }, "/entity"],
      [{ ...arr, trailing: { days: 30 } }, "/trailing"],
      [{ ...arr, value: "mrr_usd * 2" }, "/value"],
    ];
    for (const [value, pointer] of cases) {
      const ds = diagnose(withMetric("arr_snapshot", value)).filter(
        (d) => d.file === "metrics/arr_snapshot.json",
      );
      expect(ds.map((d) => [d.code, d.pointer])).toContainEqual(["HM3007", pointer]);
    }
  });

  it("requires a dashboard filter to bind to every source a formula reaches (HM2013)", () => {
    const project = projectFrom({
      config: larkspurConfig,
      metrics,
      segments,
      columns: { ...columns, credit_purchases: [...(columns.credit_purchases ?? []), "region"] },
      dashboards: {
        arr: {
          title: "ARR",
          filters: [{ type: "select", id: "region", column: "region" }],
          blocks: [{ type: "kpi", metric: "total_arr", compare: "none" }],
        },
      },
    });
    expect(checkReferences(project)).toMatchObject([
      {
        code: "HM2013",
        message: 'filter "region" would apply to credit_purchases but not to items in this block',
      },
    ]);
  });

  it("names the dashboards to recompile when a lookup's file or a segment changes", () => {
    const project = projectFrom({
      config: larkspurConfig,
      metrics,
      segments,
      columns,
      dashboards: {
        arr: { title: "ARR", blocks: [{ type: "kpi", metric: "nrr", compare: "none" }] },
        cash: { title: "Cash", blocks: [{ type: "kpi", metric: "revenue", compare: "none" }] },
      },
    });
    expect(dashboardsAffectedBy(project, "data/subscriptions.csv")).toEqual(["arr"]);
    expect(dashboardsAffectedBy(project, "data/internal_accounts.csv")).toEqual(["arr"]);
    expect(dashboardsAffectedBy(project, "segments/external.json")).toEqual(["arr"]);
    expect(dashboardsAffectedBy(project, "data/fx_rates.csv")).toEqual(["arr", "cash"]);
  });
});
