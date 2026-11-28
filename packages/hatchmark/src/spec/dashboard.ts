import { z } from "zod";
import {
  columnName,
  comparison,
  customIssue,
  type Grain,
  grainOptions,
  grainSchema,
  identifier,
  rangeSchema,
  scalar,
  schemaRef,
} from "./common.js";
import { HEIGHT_PRESETS } from "./layout.js";
import {
  GEOGRAPHIES,
  GROUP_MAX_COUNT,
  GROUP_MAX_SIZE,
  MAP_DEFAULT_CLASSES,
  MAP_MAX_CLASSES,
  MAP_MIN_CLASSES,
  MAP_SCALE_TYPES,
  PIE_DEFAULT_LIMIT,
} from "./units.js";

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

const height = z.enum(HEIGHT_PRESETS).optional().meta({
  description:
    'Card height: "compact", "default" or "tall". The theme sets the pixels for desktop and phone; there are no pixel heights. Charts side by side in a grid row are drawn at the tallest preset among them.',
});

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
    height: height.meta({
      description:
        'Size of the figure and sparkline: "compact", "default" or "tall". KPIs in one strip are drawn at the tallest preset among them.',
    }),
    metric: metricName,
    compare: comparison
      .optional()
      .meta({ description: "Defaults to the dashboard period's compare." }),
    sparkline: z.boolean().optional(),
  })
  .meta({ id: "KpiBlock" });

const edges = z.enum(["snap", "clip"]).meta({
  description:
    'Where the first bucket starts. "snap" (default) starts the window at the start of the bucket it falls in, so the first bucket is whole; "clip" keeps the window start and marks the first bucket partial.',
});
const incomplete = z.enum(["mark", "hide", "show"]).meta({
  description:
    'Buckets the data doesn\'t fully cover. "mark" (default) lists them in each series\' partial; "hide" leaves them out; "show" draws them as complete buckets (check warns with HM4014 for a flow metric).',
});

const groupsField = z
  .array(
    z
      .strictObject({
        label: z.string().min(1).meta({
          description:
            "The group's name in the key, the tooltip and the data table, such as Revenue.",
        }),
        series: z
          .array(z.union([z.string().min(1), z.number(), z.boolean()]))
          .min(2)
          .meta({
            description: `Series that belong together, lead series first. Each is a metric name from metrics or, with split, a split value as the chart labels it. At most ${GROUP_MAX_SIZE}.`,
          }),
      })
      .meta({ id: "SeriesGroup" }),
  )
  .min(1)
  .optional()
  .meta({
    description: `Series that belong together, such as actual, target and forecast of one metric. A group shares one hue and steps through its lightness in the order listed; ungrouped series keep their usual colours. At most ${GROUP_MAX_COUNT} groups, and a series belongs to one group only.`,
  });

const timeSeriesFields = {
  ...blockCommon,
  height,
  metrics: metricList,
  grain: grainSchema,
  grains: grainsField(),
  edges: edges.optional(),
  incomplete: incomplete.optional(),
  split: columnName.optional().meta({ description: "Column that splits one metric into series." }),
  groups: groupsField,
};

function grainsField() {
  return grainOptions.optional().meta({
    description:
      "Grains the card switches between, such as [week, month, quarter]. grain is the default and must be one of them. A grain filter drives every block that lists its chosen grain.",
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

const stackField = z
  .union([z.boolean(), z.literal("percent")])
  .optional()
  .meta({
    description:
      'true stacks the series on each other; "percent" stacks them to 100%, so each shows its share of the total. Stacking needs metrics that add up (sums and counts) in the same unit.',
  });

const lineBlock = z
  .strictObject({ ...timeSeriesFields, type: z.literal("line") })
  .superRefine(oneMetricWhenSplit)
  .superRefine(grainInGrains)
  .meta({ id: "LineBlock" });

const areaBlock = z
  .strictObject({ ...timeSeriesFields, type: z.literal("area"), stack: stackField })
  .superRefine(oneMetricWhenSplit)
  .superRefine(grainInGrains)
  .meta({ id: "AreaBlock" });

const barBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("bar"),
    height,
    metrics: metricList,
    by: columnName
      .optional()
      .meta({ description: "Category column on the axis. Use either by or grain." }),
    grain: grainSchema
      .optional()
      .meta({ description: "Time buckets on the axis. Use either by or grain." }),
    grains: grainsField(),
    edges: edges.optional().meta({ description: "With grain only. Defaults to snap." }),
    incomplete: incomplete.optional().meta({ description: "With grain only. Defaults to mark." }),
    split: columnName.optional(),
    groups: groupsField,
    stack: stackField,
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
    if (b.grain === undefined) {
      for (const key of ["edges", "incomplete"] as const) {
        if (b[key] === undefined) continue;
        ctx.addIssue(
          customIssue(
            "HM3007",
            [key],
            `"${key}" shapes time buckets; use it with "grain", not "by"`,
          ),
        );
      }
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
  .meta({
    id: "BarBlock",
    allOf: [
      {
        if: { not: { required: ["grain"] } },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { not: { anyOf: [{ required: ["edges"] }, { required: ["incomplete"] }] } },
      },
    ],
  });

export { PIE_DEFAULT_LIMIT };
/** More slices than this get HM5010: the angles become too thin to compare. */
export const PIE_READABLE_LIMIT = 6;

const pieFields = {
  ...blockCommon,
  height,
  metric: metricName.meta({
    description: "A part-of-whole metric: a sum or a count, whose slices add up to its total.",
  }),
  by: columnName.meta({ description: "Category column: one slice per value." }),
  limit: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .meta({
      description: `Largest slices shown; the rest are grouped into one "Other" slice. Default ${PIE_DEFAULT_LIMIT}; more than ${PIE_READABLE_LIMIT} gets warning HM5010.`,
    }),
};

const pieBlock = z
  .strictObject({ ...pieFields, type: z.literal("pie") })
  .meta({ id: "PieBlock", description: "Shares of a whole, as a pie." });

const donutBlock = z
  .strictObject({ ...pieFields, type: z.literal("donut") })
  .meta({ id: "DonutBlock", description: "Shares of a whole, as a ring with the total inside." });

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
    height: height.meta({
      description:
        'Height of the scroll area: "compact", "default" or "tall". A table with a height scrolls inside its card past that many rows; with overflow: page it grows instead and height has no effect (HM2031).',
    }),
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
    limit: z.number().int().min(1).max(1000).optional().meta({
      description:
        "Rows shown, after sort. With subtotals, rows shown in each innermost group. Tables do not paginate.",
    }),
    other: z.boolean().optional().meta({
      description:
        'With limit: fold the rows past the limit into one "Other" row, recomputed from those rows.',
    }),
    subtotals: z.boolean().optional().meta({
      description:
        "A subtotal row for every group of each outer by column, recomputed from rows (not summed). Needs two or more by columns.",
    }),
    bars: z.array(metricName).optional().meta({
      description: "Metrics that draw a bar in their cells, scaled across the rows shown.",
    }),
    overflow: z.enum(["page", "scroll"]).optional().meta({
      description:
        'How a table past 15 rows fits: "page" grows with the page, its header and total pinned to the screen edges; "scroll" scrolls inside its card. Default: "page" when the table is alone in its grid row, else "scroll".',
    }),
  })
  .superRefine((b, ctx) => {
    if (b.other === true && b.limit === undefined) {
      ctx.addIssue(
        customIssue(
          "HM3007",
          ["other"],
          'other folds the rows past "limit" into one row; set "limit", or remove "other"',
        ),
      );
    }
    if (b.subtotals === true && b.by.length < 2) {
      ctx.addIssue(
        customIssue(
          "HM3007",
          ["subtotals"],
          'subtotals group rows by the outer by columns; add a second column to "by", or remove "subtotals" (the total row covers one column)',
        ),
      );
    }
  })
  .meta({ id: "TableBlock" });

const scatterBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("scatter"),
    height,
    x: metricName.meta({ description: "Metric on the horizontal axis." }),
    y: metricName.meta({ description: "Metric on the vertical axis." }),
    by: columnName.meta({ description: "Category column: one point per value." }),
    size: metricName
      .optional()
      .meta({ description: "Metric drawn as the point's area (a bubble chart). Omit for dots." }),
    limit: z.number().int().min(1).max(500).optional().meta({
      description:
        "Points kept, largest first (by size, else by y). Default: every category, up to 500.",
    }),
  })
  .meta({ id: "ScatterBlock" });

const mapScale = z
  .strictObject({
    type: z.enum(MAP_SCALE_TYPES).optional().meta({
      description:
        '"quantile" (default): each class holds about the same number of regions. "threshold": classes split at your breaks. "linear": classes of equal width between the lowest and highest value.',
    }),
    classes: z
      .number()
      .int()
      .min(MAP_MIN_CLASSES)
      .max(MAP_MAX_CLASSES)
      .optional()
      .meta({
        description: `Number of colour classes, ${MAP_MIN_CLASSES} to ${MAP_MAX_CLASSES}. Default ${MAP_DEFAULT_CLASSES}. With threshold breaks it is breaks + 1 and may be left out.`,
      }),
    breaks: z
      .array(z.number())
      .min(MAP_MIN_CLASSES - 1)
      .max(MAP_MAX_CLASSES - 1)
      .optional()
      .meta({
        description:
          "Class boundaries in the metric's unit, ascending, for type threshold. A value equal to a break falls in the class above it.",
      }),
    midpoint: z.number().optional().meta({
      description:
        "Makes the scale diverging: values below the midpoint take one hue, values above it the other. Use it for change, margin or a gap to a target.",
    }),
  })
  .superRefine((s, ctx) => {
    const type = s.type ?? "quantile";
    if (type === "threshold" && s.breaks === undefined) {
      ctx.addIssue(
        customIssue(
          "HM3001",
          ["breaks"],
          'a threshold scale needs "breaks", such as [10, 20, 30, 40]',
        ),
      );
    }
    if (type !== "threshold" && s.breaks !== undefined) {
      ctx.addIssue(
        customIssue(
          "HM3007",
          ["breaks"],
          'breaks set the classes of a threshold scale; set type: threshold, or remove "breaks"',
        ),
      );
    }
    if (s.breaks !== undefined) {
      if (s.breaks.some((b, i) => i > 0 && b <= (s.breaks?.[i - 1] ?? b))) {
        ctx.addIssue(customIssue("HM3005", ["breaks"], "breaks must be strictly ascending"));
      }
      if (s.classes !== undefined && s.classes !== s.breaks.length + 1) {
        ctx.addIssue(
          customIssue(
            "HM3007",
            ["classes"],
            `${s.breaks.length} breaks make ${s.breaks.length + 1} classes; remove "classes" or set it to ${s.breaks.length + 1}`,
          ),
        );
      }
    }
    const classes = s.breaks ? s.breaks.length + 1 : (s.classes ?? MAP_DEFAULT_CLASSES);
    if (s.midpoint !== undefined && classes < 4) {
      ctx.addIssue(
        customIssue(
          "HM3007",
          [s.breaks ? "breaks" : "classes"],
          "a diverging scale needs at least 4 classes, two on each side of its midpoint",
        ),
      );
    }
    if (type === "quantile" && s.midpoint !== undefined && classes % 2 === 1) {
      ctx.addIssue(
        customIssue(
          "HM3007",
          ["classes"],
          "a diverging quantile scale splits the regions on each side of the midpoint into the same number of classes, so it needs an even number of classes",
        ),
      );
    }
  })
  .meta({ id: "MapScale" });

const mapBlock = z
  .strictObject({
    ...blockCommon,
    type: z.literal("map"),
    geo: z.enum(GEOGRAPHIES).meta({
      description:
        'Boundaries to draw: "us-states" (50 states, DC and Puerto Rico) or "world-countries".',
    }),
    region: columnName.meta({
      description:
        "Column naming the region of each row: a code (ISO 3166 alpha-2, alpha-3 or numeric, USPS, FIPS) or a name, matched case- and accent-insensitively.",
    }),
    value: metricName.meta({
      description:
        "Metric that colours each region. A rate, ratio or average reads well on a filled map; a sum or count mostly shows where people are (HM5040).",
    }),
    shape: z.enum(["regions", "tiles"]).optional().meta({
      description:
        '"regions" (default): the real boundaries. "tiles": one equal tile per state, DC and Puerto Rico, so small states read as clearly as large ones; us-states only.',
    }),
    tile: z.enum(["square", "hex"]).optional().meta({
      description:
        'The tile of shape "tiles": "square" (default), the clearest grid for state codes at any width, or "hex", which keeps more neighbours touching.',
    }),
    scale: mapScale.optional(),
    pair: z.enum(["bars", "none"]).optional().meta({
      description:
        '"bars" (default): a ranked bar list beside the map with the same values, below it on narrow cards. "none": the map alone.',
    }),
    missing: z.enum(["hatch"]).optional().meta({
      description: 'How regions without a value are drawn: "hatch" (default).',
    }),
  })
  .meta({ id: "MapBlock", description: "A filled (choropleth) map of one metric by region." });

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
    pieBlock,
    donutBlock,
    barListBlock,
    tableBlock,
    scatterBlock,
    mapBlock,
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
      options: z.array(rangeSchema).min(1).max(12).meta({
        description:
          "Presets the reader picks from, such as [{last: 7, unit: day}, {to_date: month}, {last_complete: month}, last_12_months]. Each is computed exactly at build time.",
      }),
      default: rangeSchema.meta({
        description: "The preset the page shows first; one of options.",
      }),
      custom: z.boolean().optional().meta({
        description:
          "Also offer a calendar for any start and end date. Default true. A static build embeds day-grain aggregates for it; set false to offer only the presets and keep the page small (HM5002).",
      }),
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
    z.strictObject({
      type: z.literal("segment"),
      id: identifier,
      label: z.string().optional(),
      segments: z.array(identifier).min(1).max(4).meta({
        description:
          "Segments the reader turns on and off: names of files under segments/. Selected segments combine with AND.",
      }),
      default: z.array(identifier).optional().meta({
        description: "Segments on when the page opens; some of segments. Default: none (all rows).",
      }),
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
      "Defaults to {asOf: latest_data, range: last_12_months, compare: previous_period}.",
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
  .meta({ title: "Hatchmark dashboard (dashboards/<name>.yaml)" });
export type Dashboard = z.infer<typeof dashboardSchema>;

export { blockId, GEOGRAPHIES, type GeographyId, MAP_DEFAULT_CLASSES } from "./units.js";
