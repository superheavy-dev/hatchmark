import { z } from "zod";
import {
  columnName,
  comparison,
  customIssue,
  type Grain,
  grainOptions,
  grainSchema,
  identifier,
  periodRange,
  rangeSchema,
  scalar,
  schemaRef,
} from "./common.js";

const blockCommon = {
  id: identifier.optional().meta({
    description:
      "Stable block id. Defaults to <type>_<index>; set it to keep links and caches across reorders.",
  }),
  title: z.string().optional().meta({ description: "Card title; state the finding." }),
  span: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .meta({ description: "Width in a 12-column grid." }),
};

const metricName = identifier.meta({ description: "A metric name, the file name under metrics/." });
const metricList = z.array(metricName).min(1).max(8);
const sort = z
  .strictObject({
    by: z.string().min(1).meta({ description: "A metric name or a column in by." }),
    order: z.enum(["asc", "desc"]),
  })
  .meta({ id: "Sort" });

const kpiBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("kpi"),
    metric: metricName,
    compare: comparison
      .optional()
      .meta({ description: "Defaults to the dashboard period's compare." }),
    sparkline: z.boolean().optional(),
  })
  .meta({ id: "KpiBlock" });

const timeSeriesFields = {
  ...blockCommon,
  metrics: metricList,
  grain: grainSchema,
  grains: grainsField(),
  split: columnName.optional().meta({ description: "Column that splits one metric into series." }),
};

function grainsField() {
  return grainOptions.optional().meta({
    description:
      'Grains the card switches between, such as ["week", "month", "quarter"]. grain is the default and must be one of them. A grain filter drives every block that lists its chosen grain.',
  });
}

function grainInGrains(
  b: { grain?: Grain | undefined; grains?: Grain[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (b.grains === undefined) return;
  if (b.grain === undefined) {
    ctx.addIssue(
      customIssue(
        "HM3007",
        ["grains"],
        'grains switches time buckets; use it with "grain", not "by"',
      ),
    );
  }
}

function oneMetricWhenSplit(
  b: { metrics: string[]; split?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (b.split !== undefined && b.metrics.length > 1) {
    ctx.addIssue(
      customIssue(
        "HM3007",
        ["split"],
        "split works with exactly one metric; remove split or keep one metric",
      ),
    );
  }
}

const lineBlock = z
  .strictObject({ ...timeSeriesFields, type: z.literal("line") })
  .superRefine(oneMetricWhenSplit)
  .superRefine(grainInGrains)
  .meta({ id: "LineBlock" });

const areaBlock = z
  .strictObject({ ...timeSeriesFields, type: z.literal("area"), stack: z.boolean().optional() })
  .superRefine(oneMetricWhenSplit)
  .superRefine(grainInGrains)
  .meta({ id: "AreaBlock" });

const barBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("bar"),
    metrics: metricList,
    by: columnName
      .optional()
      .meta({ description: "Category column on the axis. Use either by or grain." }),
    grain: grainSchema
      .optional()
      .meta({ description: "Time buckets on the axis. Use either by or grain." }),
    grains: grainsField(),
    split: columnName.optional(),
    stack: z.boolean().optional(),
    orientation: z.enum(["vertical", "horizontal"]).optional(),
    sort: sort.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((b, ctx) => {
    if ((b.by === undefined) === (b.grain === undefined)) {
      ctx.addIssue(
        b.by === undefined
          ? customIssue(
              "HM3001",
              ["by"],
              'a bar block needs either "by" (a column) or "grain" (time buckets)',
            )
          : customIssue("HM3007", ["grain"], 'use either "by" or "grain", not both'),
      );
    }
    if (b.grain !== undefined) {
      for (const key of ["sort", "limit"] as const) {
        if (b[key] === undefined) continue;
        ctx.addIssue(
          customIssue(
            "HM3007",
            [key],
            `a time bar shows every bucket in order; remove "${key}", or use "by" for categories`,
          ),
        );
      }
    }
    oneMetricWhenSplit(b, ctx);
    grainInGrains(b, ctx);
  })
  .meta({ id: "BarBlock" });

const barListBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("bar_list"),
    metric: metricName,
    by: columnName,
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .meta({ description: "Rows shown. Default 10." }),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .meta({ id: "BarListBlock" });

const tableBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("table"),
    by: z
      .array(columnName)
      .min(1)
      .max(3)
      .meta({ description: "Grouping columns, outermost first." }),
    metrics: z.array(metricName).min(1).max(12),
    totals: z
      .boolean()
      .optional()
      .meta({ description: "Total row, recomputed from rows (not summed). Default true." }),
    percentOfTotal: z.array(metricName).optional().meta({
      description: "Metrics that also show their share of the total. Additive metrics only.",
    }),
    sort: sort.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .meta({ id: "TableBlock" });

const textBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("text"),
    markdown: z.string().meta({
      description:
        "Markdown. {{metric}} inserts the current value; {{metric.previous}}, {{metric.change}} and {{metric.change_pct}} insert the comparison.",
    }),
  })
  .meta({ id: "TextBlock" });

export const blockSchema = z
  .discriminatedUnion("type", [
    kpiBlock,
    lineBlock,
    areaBlock,
    barBlock,
    barListBlock,
    tableBlock,
    textBlock,
  ])
  .meta({ id: "Block" });
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];

export const dashboardFilterSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("select"),
      id: identifier,
      label: z.string().optional(),
      column: columnName.meta({
        description: "Filters every block whose metric table has this column.",
      }),
      multiple: z.boolean().optional(),
      default: z
        .union([scalar, z.array(scalar)])
        .optional()
        .meta({ description: "Default: no filter (all)." }),
    }),
    z.strictObject({
      type: z.literal("period"),
      id: identifier,
      label: z.string().optional(),
      options: z.array(periodRange).min(1),
      default: periodRange,
    }),
    z.strictObject({
      type: z.literal("grain"),
      id: identifier,
      label: z.string().optional(),
      options: grainOptions.meta({
        description:
          "Grains to switch between. Drives every time-series block whose grains list the chosen grain.",
      }),
      default: grainSchema,
    }),
  ])
  .meta({ id: "DashboardFilter" });
export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;

export const periodSchema = z
  .strictObject({
    asOf: z.union([z.literal("latest_data"), z.literal("latest_common_data"), z.iso.date()]).meta({
      description:
        '"latest_data" (the newest source horizon), "latest_common_data" (the oldest, so every chart ends on the same day) or a fixed YYYY-MM-DD, so builds are reproducible.',
    }),
    range: rangeSchema,
    compare: comparison,
  })
  .meta({
    id: "Period",
    description:
      'Defaults to {"asOf": "latest_data", "range": "last_12_months", "compare": "previous_period"}.',
  });
export type Period = z.infer<typeof periodSchema>;

export const DEFAULT_PERIOD: Period = {
  asOf: "latest_data",
  range: "last_12_months",
  compare: "previous_period",
};

export const dashboardSchema = z
  .strictObject({
    $schema: schemaRef.optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    period: periodSchema.optional(),
    filters: z.array(dashboardFilterSchema).optional(),
    blocks: z.array(blockSchema).min(1),
  })
  .meta({ title: "Hatchmark dashboard (dashboards/<name>.json)" });
export type Dashboard = z.infer<typeof dashboardSchema>;

/** The id a block is addressed by: its explicit id, else <type>_<index>. */
export function blockId(block: Block, index: number): string {
  return block.id ?? `${block.type}_${index}`;
}
