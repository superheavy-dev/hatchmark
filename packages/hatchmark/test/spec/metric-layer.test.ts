import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { planDashboard } from "../../src/compiler/index.js";
import {
  checkReferences,
  dashboardsAffectedBy,
  groupAdditive,
  parseDiagnostics,
  timeNature,
} from "../../src/spec/index.js";
import { jsonSchema } from "../../src/spec/json-schema.js";
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
  credit_purchases_total: {
    label: "Credit purchases",
    ...money,
    type: "aggregate",
    table: "credit_purchases",
    aggregate: "sum",
    column: "amount",
    time: "created",
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
      from: "greatest(valid_from, coalesce(subscriptions.trial_end, valid_from))",
      to: "coalesce(valid_to, subscriptions.ended_at)",
      ends: "inclusive",
    },
    segments: ["external"],
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
      { code: "HM4007", pointer: "/time", file: "metrics/arr_snapshot.json" },
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
      ["metrics/paying_customers.json", "HM2018", undefined],
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

const codes = (ds: { file?: string; code: string; pointer?: string }[]) =>
  ds.map((d) => [d.file, d.code, d.pointer]);
const only = (name: string, value: unknown) =>
  checkReferences(larkspur(withMetric(name, value))).filter(
    (d) => d.file === `metrics/${name}.json` && d.severity !== "note",
  );

describe("metric layer invariants", () => {
  const snapshot = metrics.arr_snapshot as Record<string, unknown>;
  const { over_time: _, ...flowSnapshot } = snapshot;

  it("reads a snapshot table one snapshot date at a time, whatever the time primitive (HM4007)", () => {
    const cases: [string, unknown, string][] = [
      ["over_time sum", { ...snapshot, over_time: "sum" }, "/over_time"],
      ["trailing", { ...flowSnapshot, trailing: { days: 30 } }, "/trailing"],
      [
        "active",
        { ...flowSnapshot, time: undefined, active: { from: "snapshot_date", to: "null" } },
        "/active",
      ],
      ["no time", { ...flowSnapshot, time: undefined }, "/table"],
      ["another time column", { ...snapshot, time: "plan" }, "/time"],
      [
        "sql",
        {
          ...money,
          label: "S",
          type: "sql",
          table: "mrr_snapshots",
          sql: "sum(mrr_usd)",
          additive: true,
        },
        "/sql",
      ],
    ];
    for (const [label, value, pointer] of cases) {
      expect(codes(only("probe", value)), label).toEqual([
        ["metrics/probe.json", "HM4007", pointer],
      ]);
    }
    expect(only("probe", { ...snapshot, over_time: "avg" })).toEqual([]);
    expect(only("probe", { ...snapshot, time: "SNAPSHOT_DATE" })).toEqual([]);
  });

  it("checks the snapshot of a lookup's base table, not of its lookup tables (HM4007)", () => {
    const config = structuredClone(larkspurConfig) as typeof larkspurConfig;
    Object.assign(config.sources, {
      snapshots_joined: {
        type: "lookup",
        from: "mrr_snapshots",
        lookups: [{ table: "subscriptions", key: { subscription: "id" } }],
      },
    });
    Object.assign(config.sources.fx_rates, { snapshot: "date" });
    const joined = { ...flowSnapshot, table: "snapshots_joined" };
    const ds = checkReferences(larkspur({ config, metrics: { ...metrics, joined } }));
    expect(codes(ds.filter((d) => d.severity !== "note"))).toEqual([
      ["metrics/joined.json", "HM4007", "/time"],
    ]);
  });

  it("joins at the evaluation instant only for point-in-time metrics (HM4019)", () => {
    const flow = {
      ...money,
      label: "Item value",
      type: "aggregate",
      table: "items",
      aggregate: "sum",
      value: "unit_amount * fx_rates.rate",
      time: "valid_from",
    };
    expect(codes(only("probe", flow))).toEqual([["metrics/probe.json", "HM4019", "/table"]]);
    expect(codes(only("probe", { ...flow, time: undefined }))).toEqual([
      ["metrics/probe.json", "HM4019", "/table"],
    ]);
    expect(only("probe", { ...flow, over_time: "last", entity: "id" })).toEqual([]);
  });

  it("keeps currencies through scalar arithmetic and functions (HM4005)", () => {
    const eur = {
      ...(metrics.credit_run_rate as object),
      format: { type: "currency", currency: "EUR" },
    };
    const formula = (expr: string, format: unknown = money.format) => ({
      ...money,
      format,
      label: "F",
      type: "formula",
      expr,
    });
    const mixed = [
      "arr + eur * (2 + 3)",
      "arr + -2 * eur",
      "arr + abs(eur)",
      "arr + coalesce(eur, 0)",
      "max(arr, eur)",
      "arr - eur / 4",
    ];
    for (const expr of mixed) {
      const ds = checkReferences(larkspur({ metrics: { ...metrics, eur, f: formula(expr) } }));
      expect(codes(ds), expr).toEqual([["metrics/f.json", "HM4005", "/expr"]]);
    }
    const fine = ["arr + coalesce(arr, 0) * 2", "arr / eur", "arr + 1000"];
    for (const expr of fine) {
      const ds = checkReferences(larkspur({ metrics: { ...metrics, eur, f: formula(expr) } }));
      expect(codes(ds), expr).toEqual([]);
    }
    const relabelled = checkReferences(
      larkspur({ metrics: { ...metrics, eur, f: formula("eur * 2") } }),
    );
    expect(codes(relabelled)).toEqual([["metrics/f.json", "HM4005", "/format"]]);
    const labelled = formula("eur * 2", { type: "currency", currency: "EUR" });
    expect(checkReferences(larkspur({ metrics: { ...metrics, eur, f: labelled } }))).toEqual([]);
  });

  it("treats constant terms and min or max over time as non-additive (HM4001)", () => {
    const map = (extra: Record<string, unknown>) => {
      const project = larkspur({ metrics: { ...metrics, ...extra } });
      return new Map([...project.metrics].map(([k, v]) => [k, v.spec as never]));
    };
    const m = map({
      plus_one: { ...money, label: "A", type: "formula", expr: "arr + 1" },
      minus_const: { ...money, label: "B", type: "formula", expr: "1000 - arr" },
      scaled: { ...money, label: "C", type: "formula", expr: "(arr - credit_run_rate) * 2 / 4" },
      snap_min: { ...snapshot, over_time: "min" },
      snap_max: { ...snapshot, over_time: "max" },
      snap_avg: { ...snapshot, over_time: "avg" },
    });
    expect(groupAdditive("plus_one", m)).toBe(false);
    expect(groupAdditive("minus_const", m)).toBe(false);
    expect(groupAdditive("scaled", m)).toBe(true);
    expect(groupAdditive("snap_min", m)).toBe(false);
    expect(groupAdditive("snap_max", m)).toBe(false);
    expect(groupAdditive("snap_avg", m)).toBe(true);
    expect(groupAdditive("arr_snapshot", m)).toBe(true);
  });

  it("reads per_entity only from metrics with a value per entity at an instant (HM4008)", () => {
    for (const over of ["avg", "min", "max"]) {
      const project = larkspur({
        metrics: {
          ...metrics,
          snap: { ...snapshot, over_time: over },
          per: { ...(metrics.cohort_arr_now as object), of: "snap", key: "customer" },
        },
      });
      expect(codes(checkReferences(project).filter((d) => d.severity !== "note")), over).toEqual([
        ["metrics/per.json", "HM4008", "/of"],
      ]);
    }
  });

  it("prorates flow targets by days only for metrics that add up over time (HM3007)", () => {
    const target = { id: "t", grain: "month", values: { "2026-11-01": 10 }, prorate: "days" };
    const avg = { ...(metrics.revenue as object), aggregate: "avg", targets: [target] };
    expect(codes(only("probe", avg))).toEqual([
      ["metrics/probe.json", "HM3007", "/targets/0/prorate"],
    ]);
    expect(only("probe", { ...(metrics.revenue as object), targets: [target] })).toEqual([]);
  });

  it("swaps test data only for sources the metric reads (HM2023)", () => {
    const test = (data: Record<string, string>) => ({
      ...(metrics.revenue as object),
      tests: [{ window: ["2026-10-01", "2026-10-31"], expect: 1, data }],
    });
    expect(codes(only("probe", test({ usage: "fixtures/usage.csv" })))).toEqual([
      ["metrics/probe.json", "HM2023", "/tests/0/data/usage"],
    ]);
    expect(
      only("probe", test({ fx_rates: "fixtures/fx.csv", invoice_lines_raw: "f.csv" })),
    ).toEqual([]);
    const viaSegment = {
      ...(metrics.arr as object),
      tests: [{ at: "2026-10-31", expect: 1, data: { internal_accounts: "f.csv" } }],
    };
    expect(only("probe", viaSegment)).toEqual([]);
  });

  it("reserves expression keywords as metric names (HM1004)", () => {
    const ds = diagnose(withMetric("and", metrics.revenue));
    expect(codes(ds)).toEqual([["metrics/and.json", "HM1004", undefined]]);
  });

  it("puts a fix on the name inside parentheses, not on the parentheses", () => {
    const ds = checkReferences(
      larkspur(
        withMetric("probe", { ...money, label: "P", type: "formula", expr: "((revenu)) * 2" }),
      ),
    );
    const fix = ds.find((d) => d.code === "HM2020")?.fix;
    const text =
      larkspur(
        withMetric("probe", { ...money, label: "P", type: "formula", expr: "((revenu)) * 2" }),
      ).metrics.get("probe")?.document.text ?? "";
    expect(applyFix(text, fix)).toContain('"((revenue)) * 2"');
  });

  it("keeps the ARPA operands on one population and one interval", () => {
    const arr = metrics.arr as { active: unknown; segments: unknown; table: unknown };
    const customers = metrics.paying_customers as typeof arr;
    expect(customers.active).toEqual(arr.active);
    expect(customers.segments).toEqual(arr.segments);
    expect(customers.table).toEqual(arr.table);
  });

  it("exports the shape rules to the JSON Schema, agreeing with check", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(jsonSchema("metric"));
    for (const [name, value] of Object.entries(metrics)) {
      expect(validate(value), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
    const revenue = metrics.revenue as Record<string, unknown>;
    const invalid: [string, unknown][] = [
      ["time and active", { ...revenue, active: { from: "paid_at", to: "null" } }],
      ["column and value", { ...revenue, column: "amount" }],
      ["neither column nor value", { ...revenue, value: undefined }],
      ["over_time without time", { ...revenue, time: undefined, over_time: "last" }],
      ["trailing with over_time last", { ...revenue, trailing: { days: 30 }, over_time: "last" }],
      ["active with trailing", { ...(metrics.contracted_arr as object), trailing: { days: 30 } }],
      ["entity without last or first", { ...revenue, entity: "customer" }],
      ["scale 0", { ...revenue, scale: 0 }],
      [
        "target with neither values nor table",
        { ...revenue, targets: [{ id: "t", grain: "month" }] },
      ],
      [
        "target with values and table",
        {
          ...revenue,
          targets: [
            {
              id: "t",
              grain: "month",
              values: {},
              table: "arr_plan",
              date: "month",
              value: "arr_target",
            },
          ],
        },
      ],
      [
        "test with at and window",
        {
          ...revenue,
          tests: [{ at: "2026-10-31", window: ["2026-10-01", "2026-10-31"], expect: 1 }],
        },
      ],
      [
        "test by without an object",
        {
          ...revenue,
          tests: [{ window: ["2026-10-01", "2026-10-31"], by: "customer", expect: 1 }],
        },
      ],
      [
        "per_entity count with expr",
        { ...(metrics.cohort_arr_retained as object), aggregate: "count" },
      ],
    ];
    for (const [label, value] of invalid) {
      const text = JSON.stringify(value);
      expect(validate(JSON.parse(text)), `JSON Schema accepts ${label}`).toBe(false);
      const errors = diagnose(withMetric("probe", JSON.parse(text))).filter(
        (d) => d.file === "metrics/probe.json" && d.severity === "error",
      );
      expect(errors.length, `check accepts ${label}`).toBeGreaterThan(0);
    }
  });

  it("leaves out blocks whose metrics use primitives the planner does not evaluate (HM4023)", () => {
    const project = projectFrom({
      config: larkspurConfig,
      metrics,
      segments,
      columns,
      dashboards: {
        d: {
          title: "D",
          blocks: [
            { type: "kpi", id: "arr", metric: "arr" },
            { type: "kpi", id: "nrr", metric: "nrr" },
            { type: "kpi", id: "credits", metric: "credit_purchases_total" },
          ],
        },
      },
    });
    const result = planDashboard(project, "d");
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["HM4023", "/blocks/0"],
      ["HM4023", "/blocks/1"],
    ]);
    expect(result.plan?.blocks.map((b) => b.blockId)).toEqual(["credits"]);
  });
});
