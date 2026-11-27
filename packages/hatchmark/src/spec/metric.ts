import { z } from "zod";
import { columnName, currencyCode, customIssue, identifier, scalar, schemaRef } from "./common.js";

const comparisonFilter = z.strictObject({
  column: columnName,
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
  value: scalar,
});
const setFilter = z.strictObject({
  column: columnName,
  op: z.enum(["in", "not_in"]),
  values: z.array(scalar).min(1),
});
const nullFilter = z.strictObject({ column: columnName, op: z.enum(["is_null", "not_null"]) });
const betweenFilter = z.strictObject({
  column: columnName,
  op: z.literal("between"),
  from: scalar,
  to: scalar,
});
const tableFilter = z
  .strictObject({
    column: columnName,
    op: z.enum(["in_table", "not_in_table"]),
    table: identifier.meta({ description: "A source name from hatchmark.yaml." }),
    key: columnName.meta({ description: "The column of that source to match against." }),
  })
  .meta({
    description:
      "Keeps rows whose column value appears (in_table) or does not appear (not_in_table) in another source's key column. A null value passes not_in_table and fails in_table.",
  });

export const filterSchema = z
  .discriminatedUnion("op", [comparisonFilter, setFilter, nullFilter, betweenFilter, tableFilter])
  .meta({
    id: "Filter",
    description:
      "A row filter. between is inclusive at both ends. A date (YYYY-MM-DD) compared with a timestamp column compares the row's calendar date in the project time zone, so eq matches the whole day and between includes all of its last day. neq and not_in keep rows whose column is null; the other operators never match null.",
  });
export type Filter = z.infer<typeof filterSchema>;

const decimals = z.number().int().min(0).max(6);

export const formatSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("number"),
      decimals: decimals.optional(),
      compact: z.boolean().optional(),
    }),
    z.strictObject({
      type: z.literal("currency"),
      currency: currencyCode.optional().meta({ description: "Overrides the project currency." }),
      decimals: decimals.optional(),
      compact: z.boolean().optional(),
    }),
    z
      .strictObject({
        type: z.literal("percent"),
        decimals: decimals.optional(),
      })
      .meta({ description: "The value is a fraction: 0.124 shows as 12.4%." }),
  ])
  .meta({ id: "Format", description: "How values of this metric are shown." });
export type Format = z.infer<typeof formatSchema>;

export const AGGREGATES = [
  "sum",
  "count",
  "count_distinct",
  "avg",
  "min",
  "max",
  "median",
] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const OVER_TIME = ["sum", "last", "first", "avg", "min", "max"] as const;
export type OverTime = (typeof OVER_TIME)[number];

/** A length of time back from an instant, in local wall-clock days or calendar months. */
export const durationSchema = z
  .union([
    z.strictObject({ days: z.number().int().min(1).max(3660) }),
    z.strictObject({ months: z.number().int().min(1).max(120) }),
  ])
  .meta({
    id: "Duration",
    description: "A length of time, such as {days: 30} or {months: 12}.",
  });
export type Duration = z.infer<typeof durationSchema>;

const isoDate = z.iso.date();

const targetSchema = z
  .strictObject({
    id: identifier,
    label: z.string().min(1).optional(),
    grain: z.enum(["day", "week", "month", "quarter", "year"]).meta({
      description: "The grain the target values are stated at; each key or date is a bucket start.",
    }),
    values: z.record(isoDate, z.number()).optional().meta({
      description: 'Inline values by bucket start date, such as {"2027-01-01": 9000000}.',
    }),
    table: identifier.optional().meta({ description: "A source holding the target values." }),
    date: columnName.optional().meta({ description: "Column with each bucket's start date." }),
    value: columnName.optional().meta({ description: "Column with the target value." }),
    path: z.enum(["linear", "compound"]).optional().meta({
      description:
        "Point-in-time targets only: how the target moves between values. Default linear.",
    }),
    prorate: z.enum(["days", "none"]).optional().meta({
      description:
        "Flow targets only: at a finer grain, split by days (default) or hide the target.",
    }),
    segments: z.array(identifier).optional().meta({
      description: "Segments the target was set for; it hides when other segments are toggled.",
    }),
  })
  .meta({
    id: "Target",
    oneOf: [
      {
        required: ["values"],
        not: { anyOf: [{ required: ["table"] }, { required: ["date"] }, { required: ["value"] }] },
      },
      { required: ["table", "date", "value"], not: { required: ["values"] } },
    ],
  })
  .superRefine((t, ctx) => {
    const fromTable = t.table !== undefined || t.date !== undefined || t.value !== undefined;
    if (t.values !== undefined && fromTable) {
      ctx.addIssue(customIssue("HM3007", ["values"], 'use either "values" or "table", not both'));
    } else if (t.values === undefined) {
      for (const key of ["table", "date", "value"] as const) {
        if (t[key] === undefined) {
          ctx.addIssue(
            customIssue("HM3001", [key], `missing required property "${key}" (or set "values")`),
          );
        }
      }
    }
  });
export type Target = z.infer<typeof targetSchema>;

const testSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    at: isoDate.optional().meta({
      description: "Point-in-time metrics: the value at the end of this local date.",
    }),
    window: z
      .tuple([isoDate, isoDate])
      .optional()
      .meta({ description: "Flow metrics: an inclusive pair of local dates." }),
    where: z.array(filterSchema).optional(),
    segments: z.array(identifier).optional(),
    by: columnName.optional().meta({ description: "Check a breakdown; expect is then an object." }),
    expect: z.union([z.number(), z.record(z.string(), z.number())]),
    tolerance: z.number().min(0).optional().meta({
      description: "Absolute, in display units. Default: equal after rounding to 6 decimals.",
    }),
    data: z
      .record(identifier, z.string().min(1))
      .optional()
      .meta({ description: "Swap sources for fixture files, by source name." }),
  })
  .meta({
    id: "MetricTest",
    allOf: [
      { oneOf: [{ required: ["at"] }, { required: ["window"] }] },
      {
        if: { required: ["by"] },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { properties: { expect: { type: "object" } } },
        else: { properties: { expect: { type: "number" } } },
      },
    ],
  })
  .superRefine((t, ctx) => {
    if ((t.at === undefined) === (t.window === undefined)) {
      ctx.addIssue(
        t.at === undefined
          ? customIssue("HM3001", ["at"], 'a test needs "at" (point-in-time) or "window" (flow)')
          : customIssue("HM3007", ["window"], 'use either "at" or "window", not both'),
      );
    }
    if ((t.by === undefined) !== (typeof t.expect === "number")) {
      ctx.addIssue(
        customIssue(
          "HM3007",
          ["expect"],
          t.by === undefined
            ? 'an object "expect" needs "by"'
            : 'with "by", "expect" maps each group to its value',
        ),
      );
    }
    if (t.window && t.window[0] > t.window[1]) {
      ctx.addIssue(customIssue("HM3005", ["window", 1], "the window ends before it starts"));
    }
  });
export type MetricTest = z.infer<typeof testSchema>;

const common = {
  $schema: schemaRef.optional(),
  label: z.string().min(1).meta({ description: "Human name, such as Net revenue." }),
  description: z.string().optional(),
  format: formatSchema,
  better: z
    .enum(["up", "down", "neutral"])
    .meta({ description: "Which direction of change is good; colours the KPI delta." }),
  targets: z.array(targetSchema).optional().meta({ description: "Goals for this metric." }),
  tests: z
    .array(testSchema)
    .optional()
    .meta({ description: "Pinned values that check verifies against the data." }),
};

const timeColumn = columnName.optional().meta({
  description:
    "Date or timestamp column that places rows in time. Needed for time series and period comparison.",
});

const rowExpression = z.string().min(1);

const activeSchema = z
  .strictObject({
    from: rowExpression.meta({
      description: "Row expression: the instant the row starts counting.",
    }),
    to: rowExpression.meta({
      description: "Row expression: the instant it stops counting; null means it never stops.",
    }),
    ends: z.enum(["inclusive", "exclusive"]).optional().meta({
      description:
        "Whether a row whose interval ends exactly at a bucket end still counts in that bucket. Default inclusive.",
    }),
  })
  .meta({
    description:
      "Makes the metric point-in-time: a row counts at every instant in [from, to). Replaces time.",
  });

const scale = z
  .number()
  .refine((n) => Number.isFinite(n) && n !== 0, { error: "must be a non-zero number" })
  .meta({
    description: "Constant multiplier applied after aggregation, such as 0.01 or 12.",
    not: { const: 0 },
  });

const aggregateMetric = z
  .strictObject({
    ...common,
    type: z.literal("aggregate"),
    table: identifier.meta({ description: "A source name from hatchmark.yaml." }),
    aggregate: z.enum(AGGREGATES),
    column: columnName.optional().meta({
      description:
        "Column to aggregate. Required except for count, where it counts non-null values; without it, count counts rows.",
    }),
    value: rowExpression.optional().meta({
      description: "Row expression to aggregate instead of a column, such as price * quantity.",
    }),
    filters: z.array(filterSchema).optional(),
    segments: z
      .array(identifier)
      .optional()
      .meta({ description: "Segments always applied: names of files under segments/." }),
    time: timeColumn,
    over_time: z.enum(OVER_TIME).optional().meta({
      description:
        "sum (default) adds rows over a bucket. last, first, avg, min, max make the metric point-in-time: read a snapshot, or each entity's latest row when entity is set.",
    }),
    entity: columnName.optional().meta({
      description:
        "With over_time last or first: the key whose state each row describes; its latest row carries forward.",
    }),
    active: activeSchema.optional(),
    trailing: durationSchema.optional().meta({
      description:
        "Makes the metric point-in-time: at each instant, aggregate the rows of this length before it.",
    }),
    scale: scale.optional(),
  })
  .meta({
    allOf: [
      { not: { required: ["column", "value"] } },
      {
        if: { not: { properties: { aggregate: { const: "count" } } } },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { anyOf: [{ required: ["column"] }, { required: ["value"] }] },
      },
      { not: { required: ["time", "active"] } },
      {
        if: { required: ["active"] },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { not: { anyOf: [{ required: ["over_time"] }, { required: ["trailing"] }] } },
      },
      {
        if: { anyOf: [{ required: ["over_time"] }, { required: ["trailing"] }] },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { anyOf: [{ required: ["time"] }, { required: ["active"] }] },
      },
      {
        if: { required: ["trailing", "over_time"] },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { properties: { over_time: { const: "sum" } } },
      },
      {
        if: { required: ["entity"] },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { required: ["over_time"], properties: { over_time: { enum: ["last", "first"] } } },
      },
    ],
  })
  .superRefine((m, ctx) => {
    if (m.column !== undefined && m.value !== undefined) {
      ctx.addIssue(customIssue("HM3007", ["value"], 'use either "column" or "value", not both'));
    } else if (m.aggregate !== "count" && m.column === undefined && m.value === undefined) {
      ctx.addIssue(
        customIssue(
          "HM3001",
          ["column"],
          `missing required property "column" (or "value") for aggregate "${m.aggregate}"`,
        ),
      );
    }
    const pointInTime = m.over_time !== undefined && m.over_time !== "sum";
    if (m.active !== undefined && m.time !== undefined) {
      ctx.addIssue(customIssue("HM3007", ["active"], 'use either "time" or "active", not both'));
    }
    if (m.active !== undefined && (m.over_time !== undefined || m.trailing !== undefined)) {
      ctx.addIssue(
        customIssue(
          "HM3007",
          [m.over_time !== undefined ? "over_time" : "trailing"],
          '"active" is already point-in-time; remove this property',
        ),
      );
    }
    for (const key of ["over_time", "trailing"] as const) {
      if (m[key] !== undefined && m.time === undefined && m.active === undefined) {
        ctx.addIssue(customIssue("HM3007", [key], `"${key}" needs "time"`));
      }
    }
    if (m.trailing !== undefined && pointInTime) {
      ctx.addIssue(
        customIssue("HM3007", ["trailing"], 'use either "trailing" or "over_time" other than sum'),
      );
    }
    if (m.entity !== undefined && m.over_time !== "last" && m.over_time !== "first") {
      ctx.addIssue(customIssue("HM3007", ["entity"], "entity needs over_time: last or first"));
    }
  })
  .meta({ id: "AggregateMetric" });

const ratioMetric = z
  .strictObject({
    ...common,
    type: z.literal("ratio"),
    numerator: identifier.meta({ description: "Metric name." }),
    denominator: identifier.meta({ description: "Metric name." }),
  })
  .meta({ id: "RatioMetric" });

const sqlMetric = z
  .strictObject({
    ...common,
    type: z.literal("sql"),
    table: identifier,
    sql: z
      .string()
      .min(1)
      .superRefine((text, ctx) => {
        if (/\$hm_p/i.test(text)) {
          ctx.addIssue(
            customIssue(
              "HM3005",
              [],
              'sql must not contain "$hm_p": it is the reserved prefix of the parameters Hatchmark binds',
            ),
          );
        }
      })
      .meta({
        description:
          'Escape hatch: one SQL aggregate expression over the table, such as sum(amount) - sum(refund). "$hm_p" is reserved and must not appear in it.',
      }),
    additive: z.boolean().meta({
      description: "True only if summing the metric over groups gives the metric over all rows.",
    }),
    filters: z.array(filterSchema).optional(),
    segments: z.array(identifier).optional(),
    time: timeColumn,
  })
  .meta({ id: "SqlMetric" });

const formulaMetric = z
  .strictObject({
    ...common,
    type: z.literal("formula"),
    expr: z.string().min(1).meta({
      description:
        "Arithmetic over metric names: + - * /, parentheses, numbers, coalesce, min, max, abs. Such as subscription_arr + credit_run_rate * 0.6.",
    }),
  })
  .meta({ id: "FormulaMetric" });

const perEntityMetric = z
  .strictObject({
    ...common,
    type: z.literal("per_entity"),
    of: identifier.meta({
      description: "A point-in-time sum or count metric, evaluated per entity at two instants.",
    }),
    key: columnName.meta({ description: "The entity column in that metric's source." }),
    prior: durationSchema.meta({
      description: "The reference instant: this long before the evaluation instant.",
    }),
    where: z.string().min(1).optional().meta({
      description:
        "Condition over current and prior that fixes the entities, such as prior > 0. Default: every entity.",
    }),
    expr: z.string().min(1).optional().meta({
      description:
        "Combines one entity's two values before aggregating, such as least(current, prior). Default current. An entity missing at an instant counts as 0.",
    }),
    aggregate: z.enum(["sum", "count"]).optional().meta({
      description: "sum (default) of expr, or count of entities that pass where.",
    }),
    group_at: z.enum(["current", "prior"]).optional().meta({
      description:
        "When a block splits by a column, which instant gives an entity its group. Default current, falling back to prior.",
    }),
  })
  .meta({
    id: "PerEntityMetric",
    if: { required: ["aggregate"], properties: { aggregate: { const: "count" } } },
    // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
    then: { not: { required: ["expr"] } },
  })
  .superRefine((m, ctx) => {
    if (m.aggregate === "count" && m.expr !== undefined) {
      ctx.addIssue(
        customIssue("HM3007", ["expr"], 'aggregate: count counts entities; remove "expr"'),
      );
    }
  });

export const metricSchema = z
  .discriminatedUnion("type", [
    aggregateMetric,
    ratioMetric,
    sqlMetric,
    formulaMetric,
    perEntityMetric,
  ])
  .meta({ title: "Hatchmark metric (metrics/<name>.yaml)" });
export type Metric = z.infer<typeof metricSchema>;
export type TableMetric = Extract<Metric, { table: string }>;

/** How a metric relates to time: summed over a bucket, read at an instant, or not placed in time. */
export type TimeNature = "flow" | "point" | "static";

/** The time nature of an aggregate or sql metric; formulas, ratios and per_entity derive theirs. */
export function ownTimeNature(metric: TableMetric): TimeNature {
  if (metric.type === "aggregate") {
    if (metric.active !== undefined || metric.trailing !== undefined) return "point";
    if (metric.over_time !== undefined && metric.over_time !== "sum") return "point";
  }
  return metric.time === undefined ? "static" : "flow";
}
