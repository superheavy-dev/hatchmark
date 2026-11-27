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

export const filterSchema = z
  .discriminatedUnion("op", [comparisonFilter, setFilter, nullFilter, betweenFilter])
  .meta({ description: "A row filter. between is inclusive at both ends." });
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
  .meta({ description: "How values of this metric are shown." });
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

const common = {
  $schema: schemaRef.optional(),
  label: z.string().min(1).meta({ description: "Human name, such as Net revenue." }),
  description: z.string().optional(),
  format: formatSchema,
  better: z
    .enum(["up", "down", "neutral"])
    .meta({ description: "Which direction of change is good; colours the KPI delta." }),
};

const timeColumn = columnName.optional().meta({
  description:
    "Date or timestamp column that places rows in time. Needed for time series and period comparison.",
});

const aggregateMetric = z
  .strictObject({
    ...common,
    type: z.literal("aggregate"),
    table: identifier.meta({ description: "A source name from hatchmark.json." }),
    aggregate: z.enum(AGGREGATES),
    column: columnName.optional().meta({
      description:
        "Column to aggregate. Required except for count, where it counts non-null values; without it, count counts rows.",
    }),
    filters: z.array(filterSchema).optional(),
    time: timeColumn,
  })
  .superRefine((m, ctx) => {
    if (m.aggregate !== "count" && m.column === undefined) {
      ctx.addIssue(
        customIssue(
          "HM3001",
          ["column"],
          `missing required property "column" for aggregate "${m.aggregate}"`,
        ),
      );
    }
  });

const ratioMetric = z.strictObject({
  ...common,
  type: z.literal("ratio"),
  numerator: identifier.meta({ description: "Metric name." }),
  denominator: identifier.meta({ description: "Metric name." }),
});

const sqlMetric = z.strictObject({
  ...common,
  type: z.literal("sql"),
  table: identifier,
  sql: z.string().min(1).meta({
    description:
      "Escape hatch: one SQL aggregate expression over the table, such as sum(amount) - sum(refund).",
  }),
  additive: z.boolean().meta({
    description: "True only if summing the metric over groups gives the metric over all rows.",
  }),
  filters: z.array(filterSchema).optional(),
  time: timeColumn,
});

export const metricSchema = z
  .discriminatedUnion("type", [aggregateMetric, ratioMetric, sqlMetric])
  .meta({ title: "Hatchmark metric (metrics/<name>.json)" });
export type Metric = z.infer<typeof metricSchema>;

/**
 * Whether summing the metric over groups gives the metric over all rows. Only additive metrics may
 * show a percent of total; every metric's totals are recomputed from rows, never summed.
 */
export function isAdditive(metric: Metric): boolean {
  if (metric.type === "sql") return metric.additive;
  if (metric.type === "ratio") return false;
  return metric.aggregate === "sum" || metric.aggregate === "count";
}
