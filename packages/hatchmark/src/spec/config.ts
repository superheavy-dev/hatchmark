import { z } from "zod";
import {
  type Anchors,
  columnName,
  currencyCode,
  customIssue,
  DEFAULT_ANCHORS,
  identifier,
  monthDay,
  schemaRef,
  weekday,
} from "./common.js";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes(".."),
    {
      error: "must be a path inside the project, relative to hatchmark.yaml",
    },
  );

const supported = (key: "timeZone"): Set<string> => new Set(Intl.supportedValuesOf(key));
const timeZones = supported("timeZone");

export const timeZone = z.string().refine((t) => t === "UTC" || timeZones.has(t), {
  error: "must be an IANA time zone, such as UTC or America/New_York",
});

const freshnessSchema = z
  .union([
    z.strictObject({
      column: columnName.meta({ description: "Use the latest value of this column instead." }),
    }),
    z.strictObject({
      lag: z.union([
        z.strictObject({ days: z.number().int().min(1).max(366) }),
        z.strictObject({ hours: z.number().int().min(1).max(8784) }),
      ]),
    }),
    z.strictObject({
      through: z.union([z.literal("as_of"), z.iso.date()]).meta({
        description: '"as_of": complete whenever the build runs; a date: complete through it.',
      }),
    }),
  ])
  .meta({
    description:
      "How complete the source is. Default: through its latest timestamp, or through the whole latest date of a date column.",
  });

const fileSourceOptions = {
  snapshot: columnName.optional().meta({
    description:
      "The source is a full snapshot per value of this date column; metrics on it must not sum over time.",
  }),
  freshness: freshnessSchema.optional(),
  timezone: timeZone.optional().meta({
    description: "Time zone of timestamps without an offset. Default UTC.",
  }),
};

const csvSource = z.strictObject({
  type: z.literal("csv"),
  path: relativePath,
  ...fileSourceOptions,
  delimiter: z.string().length(1).optional().meta({ description: 'Field delimiter. Default ",".' }),
  header: z
    .boolean()
    .optional()
    .meta({ description: "Whether the first row holds column names. Default true." }),
});

const parquetSource = z.strictObject({
  type: z.literal("parquet"),
  path: relativePath,
  ...fileSourceOptions,
});

const jsonSource = z.strictObject({
  type: z.literal("json"),
  path: relativePath,
  ...fileSourceOptions,
  format: z
    .enum(["array", "ndjson"])
    .optional()
    .meta({ description: 'An array of objects, or one object per line. Default "array".' }),
});

const lookupSchema = z
  .strictObject({
    table: identifier.meta({ description: "A file source to join onto the base table." }),
    key: z
      .record(columnName, columnName)
      .refine((k) => Object.keys(k).length > 0, { error: "needs at least one column pair" })
      .meta({
        minProperties: 1,
        description: "Base column to lookup column, such as {subscription: id}.",
      }),
    asof: z
      .strictObject({
        column: columnName.meta({ description: "The lookup table's date or timestamp column." }),
        at: z.string().min(1).meta({
          description:
            'A base time column, or "$evaluation" for the instant a point-in-time metric is read at.',
        }),
      })
      .optional()
      .meta({
        description:
          "Pick the latest lookup row on or before an instant among rows with an equal key.",
      }),
  })
  .meta({
    description:
      "A many-to-one join: each base row gets at most one lookup row, so sums never multiply.",
  });

const lookupSource = z
  .strictObject({
    type: z.literal("lookup"),
    from: identifier.meta({ description: "The base file source." }),
    lookups: z.array(lookupSchema).min(1),
    freshness: freshnessSchema.optional(),
  })
  .meta({
    description:
      "The base source with other sources joined on; their columns read as <table>.<column>.",
  });

export const sourceSchema = z
  .discriminatedUnion("type", [csvSource, parquetSource, jsonSource, lookupSource])
  .meta({
    id: "Source",
    description: "A table read from a file in the project, or a lookup over others.",
  });
export type Source = z.infer<typeof sourceSchema>;
export type FileSource = Exclude<Source, { type: "lookup" }>;
export type LookupSource = Extract<Source, { type: "lookup" }>;

function isLocale(tag: string): boolean {
  try {
    return (
      Intl.getCanonicalLocales(tag)[0] === tag &&
      Intl.NumberFormat.supportedLocalesOf(tag).length === 1
    );
  } catch {
    return false;
  }
}

/**
 * The defaults `hatchmark init` writes. Every field is required in hatchmark.yaml so a reader
 * sees what will happen without knowing the defaults; a missing field gets a safe fix that adds
 * the value below.
 */
export const PROJECT_DEFAULTS = {
  version: 1,
  dataDir: "data",
  metricsDir: "metrics",
  dashboardsDir: "dashboards",
  outDir: "dist",
  locale: "en-US",
  currency: "USD",
  timezone: "UTC",
  theme: "default",
  telemetry: false,
  sources: {},
} as const;

export const projectConfigSchema = z
  .strictObject({
    $schema: schemaRef.optional(),
    version: z.literal(1).meta({ description: "Spec format version." }),
    name: z.string().min(1).meta({ description: "Project name, shown in page titles." }),
    dataDir: relativePath.meta({ description: "Directory holding data files." }),
    metricsDir: relativePath.meta({ description: "Directory holding metrics/<name>.yaml files." }),
    dashboardsDir: relativePath.meta({
      description: "Directory holding dashboards/<name>.yaml files.",
    }),
    segmentsDir: relativePath.optional().meta({
      description:
        'Directory holding segments/<name>.yaml files. Optional until a project has segments; default "segments".',
    }),
    outDir: relativePath.meta({ description: "Build output directory." }),
    locale: z
      .string()
      .refine(isLocale, {
        error: "must be a supported BCP 47 locale tag in canonical form, such as en-US",
      })
      .meta({ description: "Locale for number and date formatting." }),
    currency: currencyCode.meta({
      description: "Default currency for currency-formatted metrics.",
    }),
    timezone: timeZone.meta({ description: "Time zone that dates are bucketed in." }),
    weekStart: z.enum(["monday", "sunday"]).optional().meta({
      description: 'Older spelling of anchors.week ("monday" or "sunday"); use anchors instead.',
    }),
    anchors: z
      .strictObject({
        week: weekday
          .optional()
          .meta({ description: "First day of a week bucket. Default monday." }),
        quarter: monthDay.optional().meta({
          description: "Where quarters begin, such as 02-01. Default: the year anchor.",
        }),
        year: monthDay.optional().meta({
          description:
            "Where years begin, such as 02-01 for a year from February 1. Default 01-01.",
        }),
      })
      .optional()
      .meta({
        description:
          "Where week, quarter and year buckets begin. A fiscal year is a year anchor; a week start is the week anchor.",
      }),
    theme: identifier.meta({ description: "Theme id." }),
    telemetry: z.boolean().meta({ description: "Send anonymous usage data. Off unless set true." }),
    sources: z
      .record(identifier, sourceSchema)
      .meta({ description: "Tables by name. Metrics refer to these names in their table field." }),
  })
  .superRefine((c, ctx) => {
    if (c.weekStart !== undefined && c.anchors?.week !== undefined) {
      ctx.addIssue(
        customIssue("HM3007", ["weekStart"], 'use either "weekStart" or "anchors.week", not both'),
      );
    }
    const { quarter, year } = c.anchors ?? {};
    if (quarter !== undefined && year !== undefined) {
      const months = (m: string) => Number(m.slice(0, 2));
      const aligned =
        quarter.slice(3) === year.slice(3) && (months(quarter) - months(year) + 12) % 3 === 0;
      if (!aligned) {
        ctx.addIssue(
          customIssue(
            "HM3007",
            ["anchors", "quarter"],
            `quarters starting ${quarter} don't divide years starting ${year}; use a date 0, 3, 6 or 9 months after it`,
          ),
        );
      }
    }
  })
  .meta({ title: "Hatchmark project config (hatchmark.yaml)" });

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/** The project's bucket anchors: anchors, else weekStart for weeks; quarters follow the year. */
export function projectAnchors(
  config: Pick<ProjectConfig, "anchors" | "weekStart"> | undefined,
): Anchors {
  const year = config?.anchors?.year ?? DEFAULT_ANCHORS.year;
  return {
    week: config?.anchors?.week ?? config?.weekStart ?? DEFAULT_ANCHORS.week,
    quarter: config?.anchors?.quarter ?? year,
    year,
  };
}
