import { z } from "zod";
import { currencyCode, identifier, schemaRef } from "./common.js";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes(".."),
    {
      error: "must be a path inside the project, relative to hatchmark.json",
    },
  );

const csvSource = z.strictObject({
  type: z.literal("csv"),
  path: relativePath,
  delimiter: z.string().length(1).optional().meta({ description: 'Field delimiter. Default ",".' }),
  header: z
    .boolean()
    .optional()
    .meta({ description: "Whether the first row holds column names. Default true." }),
});

const parquetSource = z.strictObject({ type: z.literal("parquet"), path: relativePath });

const jsonSource = z.strictObject({
  type: z.literal("json"),
  path: relativePath,
  format: z
    .enum(["array", "ndjson"])
    .optional()
    .meta({ description: 'An array of objects, or one object per line. Default "array".' }),
});

export const sourceSchema = z
  .discriminatedUnion("type", [csvSource, parquetSource, jsonSource])
  .meta({ id: "Source", description: "A table read from a file in the project." });
export type Source = z.infer<typeof sourceSchema>;

const supported = (key: "timeZone"): Set<string> => new Set(Intl.supportedValuesOf(key));
const timeZones = supported("timeZone");

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
 * The defaults `hatchmark init` writes. Every field is required in hatchmark.json so a reader
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
  weekStart: "monday",
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
    metricsDir: relativePath.meta({ description: "Directory holding metrics/<name>.json files." }),
    dashboardsDir: relativePath.meta({
      description: "Directory holding dashboards/<name>.json files.",
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
    timezone: z
      .string()
      .refine((t) => t === "UTC" || timeZones.has(t), {
        error: "must be an IANA time zone, such as UTC or America/New_York",
      })
      .meta({ description: "Time zone that dates are bucketed in." }),
    weekStart: z.enum(["monday", "sunday"]).meta({ description: "First day of a week bucket." }),
    theme: identifier.meta({ description: "Theme id." }),
    telemetry: z.boolean().meta({ description: "Send anonymous usage data. Off unless set true." }),
    sources: z
      .record(identifier, sourceSchema)
      .meta({ description: "Tables by name. Metrics refer to these names in their table field." }),
  })
  .meta({ title: "Hatchmark project config (hatchmark.json)" });

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
