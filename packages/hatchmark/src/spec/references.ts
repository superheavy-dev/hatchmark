import {
  closestMatch,
  type Diagnostic,
  type DiagnosticCode,
  docsCommand,
  type Fix,
  type Severity,
  type SpecDocument,
} from "../diagnostics/index.js";
import {
  foldColumn,
  GLOB_CHARACTERS,
  type Grain,
  grainKey,
  keyComparison,
  resolveGrain,
  sameColumn,
} from "./common.js";
import { isFileSource, projectAnchors, type Source } from "./config.js";
import {
  type Block,
  blockId,
  type Dashboard,
  DEFAULT_PERIOD,
  PIE_READABLE_LIMIT,
} from "./dashboard.js";
import { ENTITY_NAMES, type Expr, exprRefs, parseExpr, shapeError } from "./expr.js";
import {
  addPropertyFix,
  removeItemFix,
  removePropertyFix,
  replaceValueFix,
  yamlText,
} from "./fixes.js";
import {
  blockTarget,
  filterTables,
  metricSources,
  proratedTargetNote,
  readSources,
  sourceTables,
} from "./graph.js";
import { layoutItems, MIN_CHART_SPAN } from "./layout.js";
import type { Filter, Metric, TableMetric } from "./metric.js";
import type { Project, SpecFile } from "./project.js";
import {
  currencyUnit,
  exprCurrency,
  groupAdditive,
  groupFoldable,
  metricCurrency,
  metricDeps,
  timeNature,
} from "./semantics.js";
import { parseTemporal, temporalRepair } from "./temporal.js";
import { GROUP_MAX_COUNT, GROUP_MAX_SIZE, rangeKey } from "./units.js";

export const TEXT_REFERENCE_FIELDS = ["value", "previous", "change", "change_pct"] as const;
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

const TEXT_REFERENCE = /\{\{([^{}]*)\}\}/g;
const TEXT_REFERENCE_BODY = /^([a-z][a-z0-9_]*)(?:\.([a-z_]+))?$/;

interface Reporter {
  report(
    code: DiagnosticCode,
    pointer: string,
    message: string,
    extra?: Partial<Diagnostic> & { severity?: Severity },
  ): void;
}

function reporter(spec: SpecFile, out: Diagnostic[]): Reporter {
  return {
    report(code, pointer, message, extra = {}) {
      const location = extra.range ? {} : spec.document.locationOf(pointer);
      out.push({
        code,
        severity: "error",
        message,
        file: spec.file,
        pointer,
        ...location,
        ...extra,
        docs: docsCommand(code),
      });
    },
  };
}

function suggestion(
  document: SpecDocument,
  input: string,
  options: string[],
  pointer: string,
): { help?: string; fix?: Fix } {
  const match = closestMatch(input, options);
  if (match === undefined) return {};
  const fix = replaceValueFix(
    document,
    pointer,
    match,
    match.toLowerCase() === input.toLowerCase() ? "safe" : "unsafe",
    `replace with "${match}"`,
  );
  return { help: `did you mean "${match}"?`, ...(fix ? { fix } : {}) };
}

function metricMap(project: Project): Map<string, Metric> {
  const out = new Map<string, Metric>();
  for (const [name, file] of project.metrics) if (file.spec) out.set(name, file.spec);
  return out;
}

/** Whether every row of a metric can be placed in time; ratios need both sides to be. */
export function metricHasTime(name: string, metrics: ReadonlyMap<string, Metric>): boolean {
  const nature = timeNature(name, metrics);
  return nature === "flow" || nature === "point";
}

// DuckDB matches column names case-insensitively.
function columnsOf(project: Project, source: string): Set<string> | undefined {
  const sources = project.config.spec?.sources ?? {};
  const spec = sources[source];
  if (spec === undefined) return undefined;
  if (spec.type !== "lookup") {
    const list = project.columns.get(source);
    return list ? new Set(list.map(foldColumn)) : undefined;
  }
  const base = project.columns.get(spec.from);
  if (base === undefined) return undefined;
  const out = new Set(base.map(foldColumn));
  for (const lookup of spec.lookups) {
    const cols = project.columns.get(lookup.table);
    if (cols === undefined) return undefined;
    for (const c of cols) out.add(foldColumn(`${lookup.table}.${c}`));
  }
  return out;
}

function expressionRange(
  file: SpecFile,
  pointer: string,
  start: number,
  end: number,
): Partial<Diagnostic> {
  const node = file.document.locate(pointer)?.node;
  if (node?.kind !== "string") return {};
  return {
    range: file.document.rangeAt(
      file.document.stringOffset(node, start),
      file.document.stringOffset(node, Math.max(end, start + 1), "end"),
    ),
  };
}

function parsedField(
  r: Reporter,
  file: SpecFile,
  pointer: string,
  text: string,
  mode: "formula" | "row" | "entity",
  want: "value" | "condition" | "any",
): Expr | undefined {
  const parsed = parseExpr(text, mode);
  const error = parsed.ok
    ? want === "any"
      ? undefined
      : shapeError(parsed.expr, want)
    : parsed.error;
  if (error) {
    r.report(
      "HM3010",
      pointer,
      error.message,
      expressionRange(file, pointer, error.start, error.end),
    );
    return undefined;
  }
  return parsed.ok ? parsed.expr : undefined;
}

function sourceSuggestion(
  r: Reporter,
  file: SpecFile,
  pointer: string,
  name: string,
  sources: string[],
): boolean {
  if (sources.includes(name)) return true;
  r.report("HM2001", pointer, `unknown source "${name}"`, {
    label: "not a key of sources in hatchmark.yaml",
    expected: sources,
    ...suggestion(file.document, name, sources, pointer),
  });
  return false;
}

function checkColumns(
  r: Reporter,
  project: Project,
  source: string,
  refs: { pointer: string; column: string; range?: Partial<Diagnostic> }[],
): void {
  const columns = columnsOf(project, source);
  if (columns === undefined) return;
  for (const ref of refs) {
    if (columns.has(foldColumn(ref.column))) continue;
    const list = [...(project.columns.get(source) ?? columnsOfList(project, source))];
    const close = closestMatch(ref.column, list);
    r.report("HM2018", ref.pointer, `source "${source}" has no column "${ref.column}"`, {
      ...(ref.range ?? {}),
      expected: list,
      ...(close ? { help: `did you mean "${close}"?` } : {}),
    });
  }
}

const UNREADABLE_TYPE = /^(INTERVAL|BLOB|BIT|STRUCT|MAP|UNION|VARIANT)|\]$/;
const NUMERIC_TYPE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL)/;
const NUMERIC_AGGREGATES = new Set(["sum", "avg", "median", "min", "max"]);

function checkDatabaseTypes(
  r: Reporter,
  project: Project,
  metric: TableMetric,
  refs: { pointer: string; column: string; range?: Partial<Diagnostic> }[],
): void {
  const schema = project.databases.get(metric.table);
  if (schema === undefined) return;
  const types = new Map(schema.columns.map((c) => [foldColumn(c.name), c.type]));
  const decimals = new Set(schema.decimals.map(foldColumn));
  const numeric = metric.type === "aggregate" && NUMERIC_AGGREGATES.has(metric.aggregate);
  for (const ref of refs) {
    const type = types.get(foldColumn(ref.column));
    if (type === undefined) continue;
    const at = `column "${ref.column}" of database source "${metric.table}"`;
    const problem = UNREADABLE_TYPE.test(type)
      ? `has type ${type}, which Hatchmark does not compare or group`
      : ref.pointer === "/time" && type !== "DATE" && !type.startsWith("TIMESTAMP")
        ? `is ${type}, not a date or timestamp`
        : ref.pointer === "/column" && numeric && !NUMERIC_TYPE.test(type)
          ? `is ${type}, not a number, so ${metric.type === "aggregate" ? metric.aggregate : "sum"} cannot aggregate it`
          : undefined;
    if (problem !== undefined) {
      r.report("HM2043", ref.pointer, `${at} ${problem}`, {
        ...(ref.range ?? {}),
        help: "cast the column in the source's query, or use another column",
      });
    } else if (
      numeric &&
      (ref.pointer === "/column" || ref.pointer === "/value") &&
      decimals.has(foldColumn(ref.column))
    ) {
      r.report(
        "HM4080",
        ref.pointer,
        `${at} is an exact decimal that the database driver reads as a float, so it is summed with float rules`,
        {
          ...(ref.range ?? {}),
          severity: "warning",
          help: "declare it with a precision of 38 digits or less, such as numeric(18,2), or cast it in the source's query",
        },
      );
    }
  }
}

function columnsOfList(project: Project, source: string): string[] {
  const spec = project.config.spec?.sources?.[source];
  if (spec?.type !== "lookup") return project.columns.get(source) ?? [];
  return [
    ...(project.columns.get(spec.from) ?? []),
    ...spec.lookups.flatMap((l) =>
      (project.columns.get(l.table) ?? []).map((c) => `${l.table}.${c}`),
    ),
  ];
}

function filterColumnRefs(filters: readonly Filter[], base: string) {
  return filters.map((f, i) => ({ pointer: `${base}/${i}/column`, column: f.column }));
}

function checkFilterTables(
  r: Reporter,
  project: Project,
  file: SpecFile,
  filters: readonly Filter[],
  base: string,
  sources: string[],
): void {
  filters.forEach((f, i) => {
    if (f.op !== "in_table" && f.op !== "not_in_table") return;
    if (sourceSuggestion(r, file, `${base}/${i}/table`, f.table, sources)) {
      checkColumns(r, project, f.table, [{ pointer: `${base}/${i}/key`, column: f.key }]);
    }
  });
}

function checkSegmentRefs(
  r: Reporter,
  project: Project,
  file: SpecFile,
  list: readonly string[] | undefined,
  base: string,
): void {
  const names = [...project.segments.keys()];
  (list ?? []).forEach((name, i) => {
    if (project.segments.has(name)) return;
    const pointer = `${base}/${i}`;
    r.report("HM2021", pointer, `unknown segment "${name}"`, {
      label: `no file segments/${name}.yaml`,
      expected: names,
      ...suggestion(file.document, name, names, pointer),
    });
  });
}

function checkSources(project: Project, out: Diagnostic[]): void {
  const config = project.config;
  const sources = config.spec?.sources;
  if (sources === undefined) return;
  const r = reporter(config, out);
  const names = Object.keys(sources);
  for (const [name, source] of Object.entries(sources)) {
    if (source.type !== "lookup") continue;
    const base = `/sources/${name}`;
    const tables = [
      { pointer: `${base}/from`, table: source.from },
      ...source.lookups.map((l, i) => ({ pointer: `${base}/lookups/${i}/table`, table: l.table })),
    ];
    for (const { pointer, table } of tables) {
      if (!sourceSuggestion(r, config, pointer, table, names)) continue;
      if (sources[table]?.type === "lookup") {
        r.report(
          "HM2019",
          pointer,
          `"${table}" is a lookup source; lookups join file sources only`,
          {
            help: `point at "${(sources[table] as { from: string }).from}" and add its lookups here`,
          },
        );
      }
    }
    source.lookups.forEach((lookup, i) => {
      const at = `${base}/lookups/${i}`;
      const keys = Object.entries(lookup.key);
      checkColumns(
        r,
        project,
        source.from,
        keys.map(([col]) => ({ pointer: `${at}/key`, column: col })),
      );
      checkColumns(
        r,
        project,
        lookup.table,
        keys.map(([, col]) => ({ pointer: `${at}/key`, column: col })),
      );
      if (lookup.asof) {
        checkColumns(r, project, lookup.table, [
          { pointer: `${at}/asof/column`, column: lookup.asof.column },
        ]);
        if (lookup.asof.at !== "$evaluation") {
          checkColumns(r, project, source.from, [
            { pointer: `${at}/asof/at`, column: lookup.asof.at },
          ]);
        }
      }
    });
  }
}

function checkKeyType(
  r: Reporter,
  project: Project,
  table: string,
  filter: Filter,
  pointer: string,
): void {
  if (filter.op !== "in_table" && filter.op !== "not_in_table") return;
  const typeOf = (source: string, name: string) =>
    project.columnTypes.get(source)?.find((c) => sameColumn(c.name, name))?.type;
  const own = typeOf(table, filter.column);
  const key = typeOf(filter.table, filter.key);
  if (own === undefined || key === undefined || keyComparison(own, key) !== undefined) return;
  r.report(
    "HM2029",
    pointer,
    `${filter.op} compares column "${filter.column}" (${own}) of "${table}" with key "${filter.key}" (${key}) of "${filter.table}"`,
    {
      help: `store both columns with the same type: integers of any width match each other and text matches text; cast one side where the data is written, or read it with another type`,
    },
  );
}

function checkKeyTypes(r: Reporter, project: Project, metric: TableMetric): void {
  (metric.filters ?? []).forEach((f, i) => {
    checkKeyType(r, project, metric.table, f, `/filters/${i}`);
  });
  (metric.segments ?? []).forEach((name, i) => {
    for (const f of project.segments.get(name)?.spec?.filters ?? [])
      checkKeyType(r, project, metric.table, f, `/segments/${i}`);
  });
}

function checkSegments(project: Project, out: Diagnostic[]): void {
  const sources = Object.keys(project.config.spec?.sources ?? {});
  for (const file of project.segments.values()) {
    if (file.spec === undefined) continue;
    checkFilterTables(reporter(file, out), project, file, file.spec.filters, "/filters", sources);
  }
}

function tableMetricColumns(
  r: Reporter,
  file: SpecFile,
  metric: TableMetric,
  project: Project,
): { pointer: string; column: string; range?: Partial<Diagnostic> }[] {
  const refs: { pointer: string; column: string; range?: Partial<Diagnostic> }[] = [];
  if (metric.time !== undefined) refs.push({ pointer: "/time", column: metric.time });
  refs.push(...filterColumnRefs(metric.filters ?? [], "/filters"));
  for (const id of metric.segments ?? []) {
    const segment = project.segments.get(id)?.spec;
    if (segment) {
      const i = (metric.segments ?? []).indexOf(id);
      refs.push(...segment.filters.map((f) => ({ pointer: `/segments/${i}`, column: f.column })));
    }
  }
  if (metric.type !== "aggregate") return refs;
  if (metric.column !== undefined) refs.push({ pointer: "/column", column: metric.column });
  if (metric.entity !== undefined) refs.push({ pointer: "/entity", column: metric.entity });
  const expressions: [string, string | undefined, "value" | "any"][] = [
    ["/value", metric.value, "value"],
    ["/active/from", metric.active?.from, "value"],
    ["/active/to", metric.active?.to, "value"],
  ];
  for (const [pointer, text, want] of expressions) {
    if (text === undefined) continue;
    const expr = parsedField(r, file, pointer, text, "row", want);
    if (expr === undefined) continue;
    for (const ref of exprRefs(expr)) {
      refs.push({
        pointer,
        column: ref.name,
        range: expressionRange(file, pointer, ref.start, ref.end),
      });
    }
  }
  return refs;
}

function checkMetrics(project: Project, out: Diagnostic[]): void {
  const sources = Object.keys(project.config.spec?.sources ?? {});
  const configured = project.config.spec?.sources ?? {};
  const projectCurrency = project.config.spec?.currency ?? "USD";
  const metrics = metricMap(project);
  const names = [...project.metrics.keys()];
  for (const [name, file] of project.metrics) {
    const metric = file.spec;
    if (metric === undefined) continue;
    const r = reporter(file, out);
    checkTargetsAndTests(r, project, file, metric, metrics, sources);

    if (metric.type === "aggregate" || metric.type === "sql") {
      checkTimeFilters(file, metric, r);
      checkSegmentRefs(r, project, file, metric.segments, "/segments");
      checkFilterTables(r, project, file, metric.filters ?? [], "/filters", sources);
      checkKeyTypes(r, project, metric);
      if (project.config.spec && !sourceSuggestion(r, file, "/table", metric.table, sources))
        continue;
      const refs = tableMetricColumns(r, file, metric, project);
      checkColumns(r, project, metric.table, refs);
      checkDatabaseTypes(r, project, metric, refs);
      checkSnapshot(r, metric, configured);
      checkEvaluationLookups(r, name, metric, configured, metrics);
      if (
        metric.type === "aggregate" &&
        metric.over_time === "avg" &&
        metric.entity === undefined
      ) {
        r.report(
          "HM4040",
          "/over_time",
          "uses the default: over_time avg averages the snapshots present in each period, not every calendar day",
          {
            severity: "note",
            help: "a day with no snapshot is left out of the average rather than carrying the previous snapshot forward; calendar-day averaging is not available yet",
          },
        );
      }
      if (
        metric.type === "aggregate" &&
        metric.active !== undefined &&
        metric.active.ends === undefined
      ) {
        r.report(
          "HM4040",
          "/active",
          "uses the default: an interval that ends exactly at a bucket end still counts in that bucket",
          {
            severity: "note",
            help: `set ends: exclusive to drop it from that bucket; set ends: inclusive to keep the default and silence this note`,
          },
        );
      }
      continue;
    }

    if (metric.type === "ratio") {
      let cyclic = false;
      for (const side of ["numerator", "denominator"] as const) {
        const ref = metric[side];
        if (!project.metrics.has(ref)) {
          r.report("HM2003", `/${side}`, `unknown metric "${ref}"`, {
            label: `no file metrics/${ref}.yaml`,
            expected: names,
            ...suggestion(file.document, ref, names, `/${side}`),
          });
        } else if (reaches(ref, name, metrics)) {
          r.report("HM2004", `/${side}`, `metric "${name}" refers back to itself through "${ref}"`);
          cyclic = true;
        }
      }
      if (cyclic) continue;
      checkFormatCurrency(r, name, metric, metrics, projectCurrency);
      const { numerator, denominator } = metric;
      if (!metrics.has(numerator) || !metrics.has(denominator)) continue;
      const timed = {
        numerator: metricHasTime(numerator, metrics),
        denominator: metricHasTime(denominator, metrics),
      };
      if (timed.numerator !== timed.denominator) {
        const side = timed.numerator ? "denominator" : "numerator";
        r.report(
          "HM2012",
          `/${side}`,
          `"${metric[side]}" has no time column, but the other side of the ratio does`,
          {
            label: "a dashboard period would window only one side",
            help: `add "time" to metrics/${metric[side]}.yaml, or remove it from the other side`,
          },
        );
      } else {
        checkNatureMix(
          r,
          "/" + "numerator",
          [
            { name: numerator, at: {} },
            { name: denominator, at: {} },
          ],
          metrics,
        );
      }
      continue;
    }

    if (metric.type === "formula") {
      const expr = parsedField(r, file, "/expr", metric.expr, "formula", "value");
      if (expr === undefined) continue;
      const refs = exprRefs(expr);
      let ok = true;
      for (const ref of refs) {
        const at = expressionRange(file, "/expr", ref.start, ref.end);
        if (!project.metrics.has(ref.name)) {
          const close = closestMatch(ref.name, names);
          const fix =
            close && at.range
              ? {
                  fix: {
                    range: at.range,
                    text: close,
                    applicability: "unsafe" as const,
                    description: `replace with "${close}"`,
                  },
                }
              : {};
          r.report("HM2020", "/expr", `unknown metric "${ref.name}" in formula`, {
            ...at,
            label: `no file metrics/${ref.name}.yaml`,
            expected: names,
            ...(close ? { help: `did you mean "${close}"?` } : {}),
            ...fix,
          });
          ok = false;
        } else if (reaches(ref.name, name, metrics)) {
          r.report(
            "HM2004",
            "/expr",
            `metric "${name}" refers back to itself through "${ref.name}"`,
            at,
          );
          ok = false;
        }
      }
      if (!ok) continue;
      const operands = refs.map((ref) => ({
        name: ref.name,
        at: expressionRange(file, "/expr", ref.start, ref.end),
      }));
      const timed = operands.filter((o) => metricHasTime(o.name, metrics));
      if (timed.length > 0 && timed.length < operands.length) {
        const untimed = operands.find((o) => !metricHasTime(o.name, metrics));
        if (untimed) {
          r.report(
            "HM2012",
            "/expr",
            `"${untimed.name}" has no time column, but other metrics in the formula do`,
            {
              ...untimed.at,
              label: "a dashboard period would window only some operands",
              help: `add "time" to metrics/${untimed.name}.yaml, or keep timed and untimed metrics apart`,
            },
          );
        }
      } else {
        checkNatureMix(r, "/expr", operands, metrics);
      }
      checkUnits(r, file, expr, metrics, projectCurrency);
      checkFormatCurrency(r, name, metric, metrics, projectCurrency);
      continue;
    }

    checkFormatCurrency(r, name, metric, metrics, projectCurrency);
    if (!project.metrics.has(metric.of)) {
      r.report("HM2003", "/of", `unknown metric "${metric.of}"`, {
        label: `no file metrics/${metric.of}.yaml`,
        expected: names,
        ...suggestion(file.document, metric.of, names, "/of"),
      });
    } else if (reaches(metric.of, name, metrics)) {
      r.report("HM2004", "/of", `metric "${name}" refers back to itself through "${metric.of}"`);
    } else {
      const of = metrics.get(metric.of);
      if (of !== undefined) {
        if (
          of.type !== "aggregate" ||
          (of.aggregate !== "sum" && of.aggregate !== "count") ||
          timeNature(metric.of, metrics) !== "point" ||
          of.over_time === "avg" ||
          of.over_time === "min" ||
          of.over_time === "max"
        ) {
          r.report(
            "HM4008",
            "/of",
            `"${metric.of}" must be a point-in-time sum or count to be read per entity`,
            {
              label:
                of.type !== "aggregate"
                  ? of.type
                  : of.over_time === "avg" || of.over_time === "min" || of.over_time === "max"
                    ? `over_time ${of.over_time} has no value per entity at an instant`
                    : `${of.aggregate}, ${timeNature(metric.of, metrics) ?? "unknown"}`,
              help: "point at an aggregate metric with sum or count and over_time last or first, active or trailing",
            },
          );
        } else {
          checkColumns(r, project, of.table, [{ pointer: "/key", column: metric.key }]);
        }
      }
    }
    for (const [pointer, text, want] of [
      ["/where", metric.where, "condition"],
      ["/expr", metric.expr, "value"],
    ] as const) {
      if (text === undefined) continue;
      const expr = parsedField(r, file, pointer, text, "entity", want);
      if (expr === undefined) continue;
      for (const ref of exprRefs(expr)) {
        if ((ENTITY_NAMES as readonly string[]).includes(ref.name)) continue;
        const close = closestMatch(ref.name, [...ENTITY_NAMES]);
        r.report(
          "HM2020",
          pointer,
          `unknown name "${ref.name}"; per_entity expressions use current and prior`,
          {
            ...expressionRange(file, pointer, ref.start, ref.end),
            expected: [...ENTITY_NAMES],
            ...(close ? { help: `did you mean "${close}"?` } : {}),
          },
        );
      }
    }
    if (metric.group_at === undefined) {
      r.report(
        "HM4040",
        "/type",
        "uses the default: when a block splits by a column, an entity takes its group from the current instant, else from the prior one",
        {
          severity: "note",
          help: `set group_at: prior to group by the reference instant (a cohort view); set group_at: current to keep the default and silence this note`,
        },
      );
    }
  }
}

function checkTimeFilters(
  file: SpecFile<"metric">,
  metric: Metric & { type: "aggregate" | "sql" },
  r: Reporter,
): void {
  const time = metric.time;
  if (time === undefined) return;
  (metric.filters ?? []).forEach((filter, i) => {
    if (!sameColumn(filter.column, time)) return;
    const values: [string, unknown][] =
      filter.op === "between"
        ? [
            ["from", filter.from],
            ["to", filter.to],
          ]
        : filter.op === "in" || filter.op === "not_in"
          ? filter.values.map((v, j) => [`values/${j}`, v])
          : "value" in filter
            ? [["value", filter.value]]
            : [];
    for (const [key, value] of values) {
      if (typeof value === "string" && parseTemporal(value) !== undefined) continue;
      const pointer = `/filters/${i}/${key}`;
      const repaired = typeof value === "string" ? temporalRepair(value) : undefined;
      r.report("HM3009", pointer, `${JSON.stringify(value)} is not a date or time`, {
        label: `"${time}" is the metric's time column`,
        help: "write a day as YYYY-MM-DD, a local time as YYYY-MM-DDTHH:MM:SS, or an exact moment with Z or an offset such as -05:00",
        ...optional(
          "fix",
          repaired === undefined
            ? undefined
            : replaceValueFix(
                file.document,
                pointer,
                repaired,
                "unsafe",
                `replace with "${repaired}"`,
              ),
        ),
      });
    }
  });
}

function checkNatureMix(
  r: Reporter,
  pointer: string,
  operands: { name: string; at: Partial<Diagnostic> }[],
  metrics: ReadonlyMap<string, Metric>,
): void {
  const flow = operands.find((o) => timeNature(o.name, metrics) === "flow");
  const point = operands.find((o) => timeNature(o.name, metrics) === "point");
  if (flow === undefined || point === undefined) return;
  r.report(
    "HM4009",
    pointer,
    `"${flow.name}" is summed over each period but "${point.name}" is read at an instant, so they can't be combined`,
    {
      ...flow.at,
      label: "flow combined with point-in-time",
      help: `give "${flow.name}" a "trailing" window (such as {days: 30}) so it is read at an instant too`,
    },
  );
}

function checkSnapshot(r: Reporter, metric: TableMetric, configured: Record<string, Source>): void {
  const declared = configured[metric.table];
  const base = declared?.type === "lookup" ? configured[declared.from] : declared;
  if (base === undefined || base.type === "lookup" || base.snapshot === undefined) return;
  const column = base.snapshot;
  const help = `read one snapshot date at a time: time: ${yamlText(column)} with over_time: last (or "first", "avg", "min", "max")`;
  const report = (pointer: string, message: string, severity?: Severity) =>
    r.report("HM4007", pointer, `source "${metric.table}" is a snapshot table, ${message}`, {
      label: "every snapshot would count again",
      help,
      ...optional("severity", severity),
    });
  if (metric.type === "sql") {
    report("/sql", "and a SQL metric cannot read one snapshot date at a time", "warning");
    return;
  }
  if (metric.entity !== undefined) {
    report(
      "/entity",
      "so each date already holds every entity; entity would carry a key missing from a snapshot forward",
    );
  } else if (metric.active !== undefined) {
    report(
      "/active",
      "so an interval on each snapshot row counts the same state once per snapshot",
    );
  } else if (metric.time === undefined) {
    report("/table", "and without a time column the aggregate adds every snapshot in the table");
  } else if (!sameColumn(metric.time, column)) {
    report("/time", `so the time column must be its snapshot column "${column}"`);
  } else if (metric.trailing !== undefined) {
    report("/trailing", "so a trailing window adds every snapshot inside it");
  } else if (metric.over_time === undefined || metric.over_time === "sum") {
    report(
      metric.over_time === undefined ? "/time" : "/over_time",
      "so summing it over each period counts each snapshot again",
    );
  }
}

function checkEvaluationLookups(
  r: Reporter,
  name: string,
  metric: TableMetric,
  configured: Record<string, Source>,
  metrics: ReadonlyMap<string, Metric>,
): void {
  const declared = configured[metric.table];
  if (declared?.type !== "lookup") return;
  const lookup = declared.lookups.find((l) => l.asof?.at === "$evaluation");
  const nature = timeNature(name, metrics);
  if (lookup === undefined || nature === "point") return;
  r.report(
    "HM4019",
    "/table",
    `source "${metric.table}" joins "${lookup.table}" at the evaluation instant, but this metric is ${nature === "flow" ? "summed over each period" : "not placed in time"}`,
    {
      label: "at: $evaluation needs a point-in-time metric",
      help: "join at each row's own time with at: <time column> in a separate lookup source, or read the metric at an instant (over_time, active or trailing)",
    },
  );
}

function checkUnits(
  r: Reporter,
  file: SpecFile,
  expr: Expr,
  metrics: ReadonlyMap<string, Metric>,
  projectCurrency: string,
): void {
  exprCurrency(
    expr,
    (name) => metricCurrency(name, metrics, projectCurrency),
    (e, a, b) => {
      r.report(
        "HM4005",
        "/expr",
        e.kind === "call" ? `${e.fn} mixes ${a} and ${b}` : `adds ${a} to ${b}`,
        {
          ...expressionRange(file, "/expr", e.start, e.end),
          label: "different currencies",
          help: "convert one side with an as-of lookup on a rates table, so both metrics are in one currency",
        },
      );
    },
  );
}

function checkFormatCurrency(
  r: Reporter,
  name: string,
  metric: Metric,
  metrics: ReadonlyMap<string, Metric>,
  projectCurrency: string,
): void {
  const derived = metricCurrency(name, metrics, projectCurrency);
  const shown = currencyUnit(metric, projectCurrency);
  if (typeof derived !== "string" || shown === undefined || shown === derived) return;
  r.report("HM4005", "/format", `the values are in ${derived}, but the format shows ${shown}`, {
    label: "a format changes the label, not the currency",
    help: `set currency: ${yamlText(derived)} in format, or convert the operands to ${shown}`,
  });
}

function checkTargetsAndTests(
  r: Reporter,
  project: Project,
  file: SpecFile,
  metric: Metric,
  metrics: ReadonlyMap<string, Metric>,
  sources: string[],
): void {
  const nature = timeNature(file.name, metrics);
  const ids = new Set<string>();
  (metric.targets ?? []).forEach((target, i) => {
    const base = `/targets/${i}`;
    if (ids.has(target.id)) r.report("HM2008", `${base}/id`, `duplicate target id "${target.id}"`);
    ids.add(target.id);
    if (
      target.table !== undefined &&
      sourceSuggestion(r, file, `${base}/table`, target.table, sources)
    ) {
      checkColumns(r, project, target.table, [
        ...(target.date ? [{ pointer: `${base}/date`, column: target.date }] : []),
        ...(target.value ? [{ pointer: `${base}/value`, column: target.value }] : []),
      ]);
    }
    checkSegmentRefs(r, project, file, target.segments, `${base}/segments`);
    if (nature === "flow" && target.path !== undefined) {
      r.report(
        "HM3007",
        `${base}/path`,
        "path applies to point-in-time metrics; this metric is summed over each period",
        { help: "remove path" },
      );
    }
    if (nature === "flow" && target.prorate === "days" && !groupAdditive(file.name, metrics)) {
      r.report(
        "HM3007",
        `${base}/prorate`,
        "prorate days splits a target in proportion to days, which holds only for a metric that adds up over time; this one doesn't",
        {
          label: "an average, ratio or distinct count",
          help: "set prorate: none, which is the default for this metric",
        },
      );
    }
    if (nature === "point" && target.prorate !== undefined) {
      r.report(
        "HM3007",
        `${base}/prorate`,
        "prorate applies to flow metrics; this metric is read at an instant",
        { help: "remove prorate" },
      );
    }
  });
  (metric.tests ?? []).forEach((test, i) => {
    const base = `/tests/${i}`;
    if (nature === "point" && test.window !== undefined) {
      r.report("HM3007", `${base}/window`, 'this metric is read at an instant; test it with "at"', {
        help: 'replace "window" with at: <date>',
      });
    }
    if (nature === "flow" && test.at !== undefined) {
      r.report(
        "HM3007",
        `${base}/at`,
        'this metric is summed over a period; test it with "window"',
        { help: 'replace "at" with window: [<start>, <end>]' },
      );
    }
    checkSegmentRefs(r, project, file, test.segments, `${base}/segments`);
    checkFilterTables(r, project, file, test.where ?? [], `${base}/where`, sources);
    const read = readSources(project, file.name);
    const testFilters = [
      ...(test.where ?? []),
      ...(test.segments ?? []).flatMap((s) => project.segments.get(s)?.spec?.filters ?? []),
    ];
    for (const table of filterTables(testFilters)) {
      for (const s of sourceTables(project.config.spec?.sources ?? {}, table)) read.add(s);
    }
    for (const key of Object.keys(test.data ?? {})) {
      const pointer = `${base}/data/${key}`;
      if (!sourceSuggestion(r, file, pointer, key, sources) || read.has(key)) continue;
      r.report("HM2023", pointer, `metric "${file.name}" does not read source "${key}"`, {
        label: "swapping it changes nothing",
        expected: [...read].sort(),
        help: "remove the entry, or name a source the metric reads",
      });
    }
  });
}

function reaches(
  from: string,
  target: string,
  metrics: ReadonlyMap<string, Metric>,
  seen = new Set<string>(),
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const metric = metrics.get(from);
  if (metric === undefined) return false;
  return metricDeps(metric).some((dep) => reaches(dep, target, metrics, seen));
}

function checkBlockTarget(
  r: Reporter,
  project: Project,
  file: SpecFile<"dashboard">,
  block: Block,
  index: number,
  metrics: ReadonlyMap<string, Metric>,
): void {
  const pointer = `/blocks/${index}/target`;
  const found = blockTarget(block, metrics);
  const names = blockMetricRefs(block).map((ref) => ref.name);
  const quoted = (list: readonly string[]) => list.map((n) => `"${n}"`).join(", ");
  if (found === undefined) {
    const ids = [
      ...new Set(names.flatMap((n) => (metrics.get(n)?.targets ?? []).map((t) => t.id))),
    ];
    const id = "target" in block ? (block.target ?? "") : "";
    r.report("HM2022", pointer, `unknown target "${id}"`, {
      label:
        ids.length === 0
          ? `${quoted(names)} defines no targets`
          : `not a target id of ${quoted(names)}`,
      expected: ids,
      ...suggestion(file.document, id, ids, pointer),
    });
    return;
  }
  const { metric, target } = found;
  const nature = timeNature(metric, metrics);
  const additive = groupAdditive(metric, metrics);
  const grains =
    "grain" in block && block.grain !== undefined
      ? [block.grain, ...("grains" in block ? (block.grains ?? []) : [])]
      : [];
  const rank = { day: 0, week: 1, month: 2, quarter: 3, year: 4 } as const;
  const finer = grains.some((g) => rank[typeof g === "string" ? g : g.unit] < rank[target.grain]);
  if (nature === "flow" && additive && (target.prorate ?? "days") === "days" && finer) {
    const note = proratedTargetNote(blockId(block, index), target.id, metric, target.grain);
    r.report("HM4022", pointer, note.message, { severity: "note", help: note.help });
  }
  const read = [...metricSources(project, metric)];
  const known = (source: string, column: string) =>
    columnsOf(project, source)?.has(foldColumn(column));
  const inMetric = (columns: string[]) =>
    read.length > 0 && read.every((s) => columns.every((c) => known(s, c) === true));
  const table = target.table;
  const inTarget = (columns: string[]) =>
    table !== undefined && columns.every((c) => known(table, c) !== false);
  const owner = `target "${target.id}" of "${metric}"`;
  for (const filter of file.spec?.filters ?? []) {
    if (filter.type === "select") {
      if (!inMetric([filter.column]) || inTarget([filter.column])) continue;
      r.report(
        "HM4021",
        pointer,
        `${owner} is hidden while filter "${filter.id}" keeps some values: ${table === undefined ? "inline values have no columns" : `source "${table}" has no column "${filter.column}"`}`,
        {
          severity: "warning",
          label: "the block shows no target then",
          help: `give the target a table with a "${filter.column}" column, so the target filters with the block`,
        },
      );
    } else if (filter.type === "segment") {
      const hiddenBy = filter.segments.filter((name) => {
        const columns = (project.segments.get(name)?.spec?.filters ?? []).map((f) => f.column);
        if (!inMetric(columns)) return false;
        return target.segments !== undefined ? !target.segments.includes(name) : !inTarget(columns);
      });
      if (hiddenBy.length === 0) continue;
      const why =
        target.segments !== undefined
          ? `it is set for ${quoted(target.segments) || "no segment"}`
          : table === undefined
            ? "inline values have no columns"
            : `source "${table}" lacks the segment's columns`;
      r.report(
        "HM4021",
        pointer,
        `${owner} is hidden while segment ${quoted(hiddenBy)} of filter "${filter.id}" is on: ${why}`,
        {
          severity: "warning",
          label: "the block shows no target then",
          help: 'list the segments the target was set for in its "segments", or give its table the segment\'s columns',
        },
      );
    }
  }
}

function blockMetricRefs(block: Block): { pointer: string; name: string }[] {
  switch (block.type) {
    case "kpi":
    case "bar_list":
    case "pie":
    case "donut":
      return [{ pointer: "/metric", name: block.metric }];
    case "line":
    case "area":
    case "bar":
    case "table":
      return block.metrics.map((name, i) => ({ pointer: `/metrics/${i}`, name }));
    case "scatter":
      return [
        { pointer: "/x", name: block.x },
        { pointer: "/y", name: block.y },
        ...(block.size === undefined ? [] : [{ pointer: "/size", name: block.size }]),
      ];
    case "map":
      return [{ pointer: "/value", name: block.value }];
    case "text":
      return [];
  }
}

function needsTime(block: Block, dashboard: Dashboard): boolean {
  switch (block.type) {
    case "line":
    case "area":
      return true;
    case "bar":
      return block.grain !== undefined;
    case "kpi":
      return (
        block.sparkline === true ||
        (block.compare ?? dashboard.period?.compare ?? DEFAULT_PERIOD.compare) !== "none"
      );
    default:
      return false;
  }
}

function notAdditiveLabel(metric: Metric): string {
  const kind =
    metric.type === "aggregate"
      ? metric.over_time === "min" || metric.over_time === "max"
        ? `${metric.aggregate} over_time ${metric.over_time}`
        : metric.aggregate
      : metric.type === "formula"
        ? "a non-linear formula"
        : metric.type;
  return `${kind} does not add up across rows`;
}

function checkGroups(
  r: Reporter,
  file: SpecFile<"dashboard">,
  block: Block & { type: "line" | "area" | "bar" },
  base: string,
): void {
  const groups = block.groups;
  if (groups === undefined) return;
  const split = block.split !== undefined;
  if (!split && block.metrics.length < 2) {
    r.report("HM5031", `${base}/groups`, "groups need a chart with two or more series", {
      label: `this chart draws one series, "${block.metrics[0] ?? ""}"`,
      help: "remove groups, or add the related metrics to metrics",
    });
    return;
  }
  if (groups.length > GROUP_MAX_COUNT) {
    r.report(
      "HM5032",
      `${base}/groups`,
      `${groups.length} groups are more than the ${GROUP_MAX_COUNT} hue families a chart can give groups`,
      { help: "merge groups, or leave some series ungrouped" },
    );
  }
  const seen = new Map<string, number>();
  groups.forEach((group, g) => {
    const pointer = `${base}/groups/${g}/series`;
    if (group.series.length > GROUP_MAX_SIZE) {
      r.report(
        "HM5030",
        pointer,
        `group "${group.label}" has ${group.series.length} series; a group holds at most ${GROUP_MAX_SIZE}`,
        {
          label: `a hue family has ${GROUP_MAX_SIZE} lightness steps that stay apart`,
          help: "split the group in two, or leave the least important series ungrouped",
        },
      );
    }
    group.series.forEach((member, i) => {
      const name = String(member);
      const at = `${pointer}/${i}`;
      if (!split && !block.metrics.includes(name)) {
        const listed = new Set(groups.flatMap((other) => other.series.map(String)));
        r.report(
          "HM2027",
          at,
          `group "${group.label}" names "${name}", which this chart does not draw`,
          {
            expected: block.metrics,
            ...suggestion(
              file.document,
              name,
              block.metrics.filter((m) => !listed.has(m)),
              at,
            ),
          },
        );
        return;
      }
      const owner = seen.get(name);
      if (owner !== undefined) {
        r.report(
          "HM3011",
          at,
          owner === g
            ? `"${name}" is listed twice in group "${group.label}"`
            : `"${name}" is already in group "${groups[owner]?.label ?? ""}"`,
          group.series.length > 2
            ? {
                help: "a series takes its colour from one group; remove the repeat",
                ...optional(
                  "fix",
                  removeItemFix(
                    file.document,
                    pointer,
                    i,
                    "unsafe",
                    `remove "${name}" from this group`,
                  ),
                ),
              }
            : {
                help: "a series takes its colour from one group; list another series in its place, or remove this group",
              },
        );
        return;
      }
      seen.set(name, g);
    });
  });
}

function checkPie(
  r: Reporter,
  file: SpecFile<"dashboard">,
  block: Block & { type: "pie" | "donut" },
  base: string,
  metrics: ReadonlyMap<string, Metric>,
): void {
  const metric = metrics.get(block.metric);
  if (metric !== undefined && !groupAdditive(block.metric, metrics)) {
    r.report(
      "HM4001",
      `${base}/metric`,
      `a ${block.type} is not meaningful for "${block.metric}"`,
      {
        label: notAdditiveLabel(metric),
        help: `a ${block.type} shows parts of a whole, so its metric must be a sum or a count; show "${block.metric}" in a bar chart instead, or the sum or count it is built from`,
      },
    );
  }
  if (block.limit !== undefined && block.limit > PIE_READABLE_LIMIT) {
    r.report(
      "HM5010",
      `${base}/limit`,
      `${block.limit} slices are too many to compare in a ${block.type}`,
      {
        severity: "warning",
        label: `at most ${PIE_READABLE_LIMIT} read well; the rest join "Other"`,
        help: `set "limit" to ${PIE_READABLE_LIMIT} or fewer, or show the categories as a horizontal bar chart with "limit"`,
        ...optional(
          "fix",
          replaceValueFix(
            file.document,
            `${base}/limit`,
            PIE_READABLE_LIMIT,
            "unsafe",
            `set limit: ${PIE_READABLE_LIMIT}`,
          ),
        ),
      },
    );
  }
}

function checkStack(
  r: Reporter,
  file: SpecFile<"dashboard">,
  block: Block & { type: "bar" | "area" },
  base: string,
  metrics: ReadonlyMap<string, Metric>,
  projectCurrency: string,
): void {
  const percent = block.stack === "percent";
  if (!percent && block.split === undefined && block.metrics.length < 2) return;
  const fix = optional(
    "fix",
    replaceValueFix(
      file.document,
      `${base}/stack`,
      percent,
      "unsafe",
      percent ? "set stack: true" : "set stack: false",
    ),
  );
  block.metrics.forEach((name, i) => {
    const metric = metrics.get(name);
    if (metric === undefined || groupAdditive(name, metrics)) return;
    const pointer = `${base}/metrics/${i}`;
    if (percent) {
      r.report("HM4001", pointer, `a 100% stack is not meaningful for "${name}"`, {
        label: notAdditiveLabel(metric),
        help: "shares need parts that add up to the total; stack a sum or a count, or use stack: true",
        ...fix,
      });
      return;
    }
    r.report(
      "HM4060",
      pointer,
      `stacked "${name}" does not add up, so the stack height means nothing`,
      {
        severity: "warning",
        label: notAdditiveLabel(metric),
        help: 'remove "stack" to draw the series side by side, or stack the sum or count it is built from',
        ...fix,
      },
    );
  });
  const units = block.metrics.flatMap((name) => {
    const metric = metrics.get(name);
    return metric ? [currencyUnit(metric, projectCurrency) ?? metric.format.type] : [];
  });
  const distinct = [...new Set(units)];
  if (distinct.length > 1) {
    r.report(
      "HM4062",
      `${base}/metrics`,
      `stacked metrics are in different units (${distinct.join(", ")})`,
      {
        label: percent
          ? "a share of values in different units means nothing"
          : "values in different units cannot be added",
        help: "stack metrics of one unit, or set stack: false and show them side by side or in separate charts",
        ...optional(
          "fix",
          replaceValueFix(file.document, `${base}/stack`, false, "unsafe", "set stack: false"),
        ),
      },
    );
  }
}

function checkScatter(r: Reporter, block: Block & { type: "scatter" }, base: string): void {
  if (block.x === block.y) {
    r.report(
      "HM5020",
      `${base}/y`,
      `both axes show "${block.x}", so every point sits on one diagonal`,
      {
        severity: "warning",
        help: "put a different metric on y, such as a ratio or average that may move with x",
      },
    );
  }
  if (block.size !== undefined && (block.size === block.x || block.size === block.y)) {
    const axis = block.size === block.x ? "x" : "y";
    r.report(
      "HM5021",
      `${base}/size`,
      `size repeats the ${axis} metric "${block.size}", so bubble size adds nothing`,
      {
        severity: "warning",
        help: 'size a third metric, such as revenue, or remove "size" to draw plain dots',
      },
    );
  }
}

function checkMap(
  r: Reporter,
  block: Block & { type: "map" },
  base: string,
  metrics: ReadonlyMap<string, Metric>,
): void {
  const metric = metrics.get(block.value);
  if (metric !== undefined && groupAdditive(block.value, metrics)) {
    r.report(
      "HM5040",
      `${base}/value`,
      `"${block.value}" adds up across rows, so a filled map of it mostly shows where most people or customers are`,
      {
        severity: "warning",
        label: "a sum or count colours large regions darkest",
        help: `map a ratio instead, such as "${block.value}" per customer or per capita (a ratio metric with numerator: ${block.value}); bubble maps, which suit totals, are not available yet`,
      },
    );
  }
  if (block.shape === "tiles" && block.geo !== "us-states") {
    r.report("HM2033", `${base}/shape`, `there is no tile layout for ${block.geo}`, {
      label: "tile maps are available for us-states only",
      help: "remove shape to draw the boundaries, or set geo: us-states",
    });
  }
  if (block.tile !== undefined && block.shape !== "tiles") {
    r.report("HM2034", `${base}/tile`, `tile "${block.tile}" has no effect without shape: tiles`, {
      severity: "warning",
      label: "this map draws boundaries",
      help: "add shape: tiles, or remove tile",
    });
  }
  const scale = block.scale;
  if (scale?.midpoint === undefined || scale.breaks === undefined) return;
  const { breaks, midpoint } = scale;
  const below = breaks.filter((b) => b < midpoint).length;
  const above = breaks.filter((b) => b > midpoint).length;
  const on = breaks.includes(midpoint);
  const centred = on ? below === above : below === above && breaks.length % 2 === 0;
  if (!centred) {
    r.report(
      "HM2032",
      `${base}/scale/midpoint`,
      `midpoint ${midpoint} does not sit in the middle of the breaks [${breaks.join(", ")}]`,
      {
        label: "a diverging scale needs as many classes on each side of its midpoint",
        help: "with an even number of classes make the midpoint the middle break; with an odd number put it inside the middle class, with as many breaks below it as above",
      },
    );
  }
}

function checkDashboard(project: Project, file: SpecFile<"dashboard">, out: Diagnostic[]): void {
  const dashboard = file.spec;
  if (dashboard === undefined) return;
  const r = reporter(file, out);
  const metrics = metricMap(project);
  const names = [...project.metrics.keys()];

  const checkRef = (pointer: string, name: string): boolean => {
    if (project.metrics.has(name)) return true;
    r.report("HM2003", pointer, `unknown metric "${name}"`, {
      label: `no file metrics/${name}.yaml`,
      expected: names,
      ...suggestion(file.document, name, names, pointer),
    });
    return false;
  };

  const layout = layoutItems(dashboard.blocks);
  const shared = new Set(layout.filter((item) => !item.alone).flatMap((item) => item.blocks));
  const drawnAt = new Map(layout.flatMap((item) => item.blocks.map((i) => [i, item] as const)));

  const blockIds = new Map<string, number>();
  dashboard.blocks.forEach((block, index) => {
    const base = `/blocks/${index}`;
    if (block.type === "table" && block.overflow === "page" && shared.has(index)) {
      r.report(
        "HM2026",
        `${base}/overflow`,
        "a table with overflow: page shares its grid row, so the other cards in the row stretch to its height",
        {
          severity: "warning",
          label: "the row grows with the table",
          help: 'remove "overflow" to scroll inside the card, or give the table its own row with span: 12',
        },
      );
    }
    if (block.type === "table" && block.overflow === "page" && block.height !== undefined) {
      r.report(
        "HM2031",
        `${base}/height`,
        'a table with overflow: page grows with its rows, so "height" has no effect',
        {
          severity: "warning",
          label: "ignored",
          help: 'remove "height", or remove "overflow" so the table scrolls inside a card of that height',
          ...optional(
            "fix",
            removePropertyFix(file.document, base, "height", "safe", 'remove "height"'),
          ),
        },
      );
    }
    const drawn = drawnAt.get(index);
    const height = "height" in block ? block.height : undefined;
    if (drawn && drawn.kind !== "table" && drawn.height !== (height ?? "default")) {
      const pointer = height === undefined ? base : `${base}/height`;
      const description = `set height: ${drawn.height}`;
      const fix =
        height === undefined
          ? addPropertyFix(file.document, base, "height", drawn.height, "unsafe", description)
          : replaceValueFix(file.document, pointer, drawn.height, "unsafe", description);
      r.report(
        "HM2028",
        pointer,
        drawn.kind === "strip"
          ? `KPIs in one strip are drawn at the tallest height among them, so this one is drawn ${drawn.height}`
          : `this chart shares a grid row with a ${drawn.height} chart, so it is drawn ${drawn.height} on wide screens`,
        {
          severity: "warning",
          label: `drawn ${drawn.height}`,
          help:
            drawn.kind === "strip"
              ? `set the same height on every KPI in the strip, such as height: ${drawn.height}`
              : `set the same height on every chart in the row, such as height: ${drawn.height}, or give this chart its own row with span: 12`,
          ...optional("fix", fix),
        },
      );
    }
    const id = blockId(block, index);
    const first = blockIds.get(id);
    if (first !== undefined) {
      r.report("HM2008", block.id ? `${base}/id` : base, `duplicate block id "${id}"`, {
        help: `block ${first} already uses this id${block.id ? "" : " (ids default to <type>_<index>)"}; give one of them a different id`,
      });
    } else {
      blockIds.set(id, index);
    }

    if (
      (block.type === "line" ||
        block.type === "area" ||
        block.type === "bar" ||
        block.type === "pie" ||
        block.type === "donut" ||
        block.type === "scatter" ||
        block.type === "map") &&
      block.span !== undefined &&
      block.span < MIN_CHART_SPAN
    ) {
      r.report(
        "HM2024",
        `${base}/span`,
        `a ${block.type} chart needs at least ${MIN_CHART_SPAN} of the 12 columns, but this one has span ${block.span}`,
        {
          severity: "warning",
          label: `drawn ${MIN_CHART_SPAN} columns wide`,
          help: `set span: ${MIN_CHART_SPAN} or more, or use a kpi block with sparkline: true for one number`,
          ...optional(
            "fix",
            replaceValueFix(
              file.document,
              `${base}/span`,
              MIN_CHART_SPAN,
              "safe",
              `set span: ${MIN_CHART_SPAN}`,
            ),
          ),
        },
      );
    }

    for (const ref of blockMetricRefs(block)) {
      const pointer = base + ref.pointer;
      if (!checkRef(pointer, ref.name)) continue;
      if (needsTime(block, dashboard) && !metricHasTime(ref.name, metrics)) {
        r.report(
          "HM2005",
          pointer,
          `metric "${ref.name}" has no time column, which this ${block.type} block needs`,
          {
            help:
              block.type === "kpi"
                ? `add "time" to metrics/${ref.name}.yaml, or set compare: none on this block`
                : `add time: <date column> to metrics/${ref.name}.yaml`,
          },
        );
      }
    }

    if ("target" in block && block.target !== undefined) {
      checkBlockTarget(r, project, file, block, index, metrics);
    }

    if (block.type === "table") {
      (block.percentOfTotal ?? []).forEach((name, i) => {
        const pointer = `${base}/percentOfTotal/${i}`;
        if (!checkRef(pointer, name)) return;
        if (!block.metrics.includes(name)) {
          r.report("HM2006", pointer, `"${name}" is in percentOfTotal but not in metrics`, {
            expected: block.metrics,
          });
          return;
        }
        const metric = metrics.get(name);
        if (metric && !groupAdditive(name, metrics)) {
          r.report("HM4001", pointer, `percent of total is not meaningful for "${name}"`, {
            label: notAdditiveLabel(metric),
            ...optional(
              "fix",
              removeItemFix(
                file.document,
                `${base}/percentOfTotal`,
                i,
                "unsafe",
                `remove "${name}" from percentOfTotal`,
              ),
            ),
          });
        }
      });
      (block.bars ?? []).forEach((name, i) => {
        const pointer = `${base}/bars/${i}`;
        if (!checkRef(pointer, name) || block.metrics.includes(name)) return;
        r.report("HM2006", pointer, `"${name}" is in bars but not in metrics`, {
          expected: block.metrics,
        });
      });
      if (block.other === true && block.limit !== undefined) {
        for (const name of block.metrics) {
          const metric = metrics.get(name);
          if (metric === undefined || groupFoldable(name, metrics)) continue;
          r.report("HM4063", `${base}/other`, `the Other row cannot be computed for "${name}"`, {
            severity: "warning",
            label: `${metric.type === "aggregate" ? metric.aggregate : metric.type} needs the rows themselves, so Other shows "—" for it`,
            help: `remove "other", or show a metric that adds up instead of "${name}"`,
            ...optional(
              "fix",
              replaceValueFix(file.document, `${base}/other`, false, "unsafe", "set other: false"),
            ),
          });
        }
      }
    }

    if (block.type === "pie" || block.type === "donut") {
      checkPie(r, file, block, base, metrics);
    }

    if ((block.type === "bar" || block.type === "area") && block.stack) {
      checkStack(r, file, block, base, metrics, project.config.spec?.currency ?? "USD");
    }

    if (block.type === "scatter") checkScatter(r, block, base);

    if (block.type === "line" || block.type === "area" || block.type === "bar") {
      checkGroups(r, file, block, base);
    }
    if (block.type === "map") checkMap(r, block, base, metrics);

    if ((block.type === "table" || block.type === "bar") && block.sort) {
      const allowed = [
        ...block.metrics,
        ...(block.type === "table" ? block.by : block.by ? [block.by] : []),
      ];
      if (!allowed.includes(block.sort.by)) {
        r.report("HM2009", `${base}/sort/by`, `cannot sort by "${block.sort.by}"`, {
          expected: allowed,
          ...suggestion(file.document, block.sort.by, allowed, `${base}/sort/by`),
        });
      }
    }

    if (block.type === "text") {
      const pointer = `${base}/markdown`;
      const node = file.document.locate(pointer)?.node;
      for (const match of block.markdown.matchAll(TEXT_REFERENCE)) {
        const index = match.index;
        const range =
          node && node.kind === "string"
            ? file.document.rangeAt(
                file.document.stringOffset(node, index),
                file.document.stringOffset(node, index + match[0].length, "end"),
              )
            : undefined;
        const at = range ? { range } : {};
        const body = (match[1] ?? "").trim();
        const parsed = TEXT_REFERENCE_BODY.exec(body);
        if (!parsed) {
          r.report("HM2007", pointer, `invalid metric reference "${match[0]}"`, {
            ...at,
            help: "write {{metric}} or {{metric.field}}, such as {{net_revenue.change_pct}}",
          });
          continue;
        }
        const [, name = "", field] = parsed;
        if (field !== undefined && !(TEXT_REFERENCE_FIELDS as readonly string[]).includes(field)) {
          r.report("HM2007", pointer, `unknown field ".${field}" in "${match[0]}"`, {
            ...at,
            expected: [...TEXT_REFERENCE_FIELDS],
          });
          continue;
        }
        if (!project.metrics.has(name)) {
          const close = closestMatch(name, names);
          r.report("HM2003", pointer, `unknown metric "${name}" in "${match[0]}"`, {
            ...at,
            label: `no file metrics/${name}.yaml`,
            expected: names,
            ...(close ? { help: `did you mean "${close}"?` } : {}),
          });
          continue;
        }
        if (field === undefined || field === "value") continue;
        if ((dashboard.period?.compare ?? DEFAULT_PERIOD.compare) === "none") {
          r.report(
            "HM2011",
            pointer,
            `"${match[0]}" needs a comparison, but the dashboard's period.compare is "none"`,
            {
              ...at,
              help: 'set period.compare to "previous_period" or "previous_year", or use {{metric}} alone',
            },
          );
          continue;
        }
        if (!metricHasTime(name, metrics)) {
          r.report(
            "HM2005",
            pointer,
            `"${match[0]}" needs a comparison, but metric "${name}" has no time column`,
            at,
          );
        }
      }
    }
  });

  const configured = project.config.spec?.sources ?? {};
  const blockSources = dashboard.blocks.map((block) => {
    const names =
      block.type === "text"
        ? [...block.markdown.matchAll(TEXT_REFERENCE)].flatMap(
            (m) => TEXT_REFERENCE_BODY.exec((m[1] ?? "").trim())?.[1] ?? [],
          )
        : blockMetricRefs(block).map((ref) => ref.name);
    return new Set(
      names
        .flatMap((name) => [...metricSources(project, name)])
        .filter((s) => Object.hasOwn(configured, s)),
    );
  });
  const read = [...new Set(blockSources.flatMap((s) => [...s]))].sort();
  const covers = (columns: string[]) => (source: string) =>
    columns.every((c) => columnsOf(project, source)?.has(foldColumn(c)) === true);
  if (read.length > 0 && read.every((s) => columnsOf(project, s) !== undefined)) {
    (dashboard.filters ?? []).forEach((filter, i) => {
      if (filter.type === "select" && !read.some(covers([filter.column]))) {
        r.report(
          "HM2030",
          `/filters/${i}/column`,
          `filter "${filter.id}" reads column "${filter.column}", which no source of this dashboard has (${read.join(", ")})`,
          {
            severity: "warning",
            help: "name a column one of the dashboard's sources has, or remove the filter",
          },
        );
      }
      if (filter.type !== "segment") return;
      filter.segments.forEach((name, j) => {
        const columns = (project.segments.get(name)?.spec?.filters ?? []).map((f) => f.column);
        if (columns.length === 0 || read.some(covers(columns))) return;
        r.report(
          "HM2030",
          `/filters/${i}/segments/${j}`,
          `segment "${name}" of filter "${filter.id}" filters on ${columns.map((c) => `"${c}"`).join(", ")}, which no source of this dashboard has (${read.join(", ")})`,
          {
            severity: "warning",
            help: "toggle segments whose columns a source of this dashboard has, or remove it",
          },
        );
      });
    });
  }

  dashboard.blocks.forEach((block, index) => {
    const sources = blockSources[index] ?? new Set<string>();
    if (sources.size < 2) return;
    const list = [...sources].sort();
    for (const filter of dashboard.filters ?? []) {
      if (filter.type !== "segment") continue;
      for (const name of filter.segments) {
        const columns = (project.segments.get(name)?.spec?.filters ?? []).map((f) => f.column);
        if (columns.length === 0) continue;
        const has = (source: string) => {
          const known = columnsOf(project, source);
          return known === undefined ? undefined : columns.every((c) => known.has(foldColumn(c)));
        };
        const unknown = list.filter((src) => has(src) === undefined);
        const lacking = list.filter((src) => has(src) === false);
        if (unknown.length === 0 && (lacking.length === 0 || lacking.length === list.length))
          continue;
        r.report(
          "HM2013",
          `/blocks/${index}`,
          unknown.length > 0
            ? `cannot confirm that every source of this block (${list.join(", ")}) has the columns of segment "${name}" for filter "${filter.id}"`
            : `segment "${name}" of filter "${filter.id}" would apply to ${list.filter((src) => !lacking.includes(src)).join(", ")} but not to ${lacking.join(", ")} in this block`,
          {
            help: "a segment must apply to every source a block reads, or its numbers mix segmented and unsegmented rows; split the block or drop the segment from the filter",
          },
        );
      }
    }
    for (const filter of dashboard.filters ?? []) {
      if (filter.type !== "select") continue;
      const list = [...sources].sort();
      const unknown = list.filter((s) => columnsOf(project, s) === undefined);
      const lacking = list.filter(
        (s) => columnsOf(project, s)?.has(foldColumn(filter.column)) === false,
      );
      if (unknown.length === 0 && (lacking.length === 0 || lacking.length === list.length))
        continue;
      r.report(
        "HM2013",
        `/blocks/${index}`,
        unknown.length > 0
          ? `cannot confirm that every source of this block (${list.join(", ")}) has column "${filter.column}" for filter "${filter.id}"`
          : `filter "${filter.id}" would apply to ${list.filter((s) => !lacking.includes(s)).join(", ")} but not to ${lacking.join(", ")} in this block`,
        {
          help:
            unknown.length > 0
              ? `Hatchmark could not read the column names of ${unknown.join(", ")}; check that the data files can be read, or keep metrics from different sources in separate blocks when the dashboard has select filters`
              : `a filter must apply to every source a block reads, or its numbers mix filtered and unfiltered rows; split the block or drop the filter`,
        },
      );
    }
  });

  const filterIds = new Set<string>();
  let periodFilter: string | undefined;
  const anchors = projectAnchors(project.config.spec);
  const resolvedKey = (g: Grain) => grainKey(resolveGrain(g, anchors));
  const checkGrains = (options: Grain[], base: string, shown: Grain, at: string, what: string) => {
    const keys = options.map(resolvedKey);
    keys.forEach((key, i) => {
      const first = keys.indexOf(key);
      if (first === i) return;
      r.report(
        "HM3007",
        `${base}/${i}`,
        `grain ${JSON.stringify(options[i])} makes the same buckets as ${JSON.stringify(options[first])} (${key}) at the project anchors`,
        { help: "list each grain once" },
      );
    });
    if (!keys.includes(resolvedKey(shown))) {
      r.report(
        "HM3007",
        at,
        `${what} ${JSON.stringify(shown)} is not one of ${base.endsWith("grains") ? "grains" : "options"} (${keys.join(", ")})`,
        { help: "add it to the list, or pick one of them" },
      );
    }
  };
  dashboard.blocks.forEach((block, i) => {
    if (!("grains" in block) || block.grains === undefined || block.grain === undefined) return;
    checkGrains(block.grains, `/blocks/${i}/grains`, block.grain, `/blocks/${i}/grain`, "grain");
  });
  (dashboard.filters ?? []).forEach((filter, i) => {
    if (filter.type !== "grain") return;
    checkGrains(
      filter.options,
      `/filters/${i}/options`,
      filter.default,
      `/filters/${i}/default`,
      "default",
    );
  });

  const switched = new Set(
    dashboard.blocks.flatMap((block) =>
      "grains" in block && block.grains !== undefined ? block.grains.map(resolvedKey) : [],
    ),
  );
  (dashboard.filters ?? []).forEach((filter, i) => {
    if (filter.type === "grain") {
      const keys = filter.options.map(resolvedKey);
      if (!keys.some((key) => switched.has(key))) {
        r.report("HM2025", `/filters/${i}`, `grain filter "${filter.id}" switches no block`, {
          severity: "warning",
          label: "no line, area or bar block lists these grains",
          help: `add "grains" with ${keys.map((k) => JSON.stringify(k)).join(", ")} to the blocks it should switch, or remove the filter`,
        });
        return;
      }
      keys.forEach((key, j) => {
        if (switched.has(key) || keys.indexOf(key) !== j) return;
        r.report(
          "HM2025",
          `/filters/${i}/options/${j}`,
          `grain filter "${filter.id}" offers ${JSON.stringify(filter.options[j])}, which no block lists in its grains`,
          {
            severity: "warning",
            help: "add it to the grains of the blocks it should switch, or remove the option",
          },
        );
      });
      return;
    }
    if (filter.type !== "period") return;
    const keys = filter.options.map(rangeKey);
    keys.forEach((key, j) => {
      const first = keys.indexOf(key);
      if (first === j) return;
      r.report(
        "HM3007",
        `/filters/${i}/options/${j}`,
        `preset ${JSON.stringify(filter.options[j])} reads the same dates as ${JSON.stringify(filter.options[first])} (${key})`,
        { help: "list each preset once" },
      );
    });
    if (!keys.includes(rangeKey(filter.default))) {
      r.report(
        "HM3007",
        `/filters/${i}/default`,
        `default ${JSON.stringify(filter.default)} is not one of options (${keys.join(", ")})`,
        { help: "add it to options, or pick one of them" },
      );
    }
    if (filter.custom === false) return;
    const presetOnly = new Set<string>();
    const visit = (name: string, seen: Set<string>) => {
      const metric = project.metrics.get(name)?.spec;
      if (metric === undefined || seen.has(name)) return;
      seen.add(name);
      if (metric.type === "ratio") {
        visit(metric.numerator, seen);
        visit(metric.denominator, seen);
        return;
      }
      if (metric.type !== "aggregate" && metric.type !== "sql") return;
      if (metric.time === undefined) return;
      const additive =
        metric.type === "sql"
          ? metric.additive === true
          : ["sum", "count", "min", "max", "avg"].includes(metric.aggregate);
      if (!additive) presetOnly.add(name);
    };
    for (const block of dashboard.blocks) {
      for (const ref of blockMetricRefs(block)) visit(ref.name, new Set());
    }
    for (const name of [...presetOnly].sort()) {
      r.report(
        "HM4041",
        `/filters/${i}`,
        `metric "${name}" cannot be added up from days, so a custom range shows it as "—" and asks for a preset`,
        {
          severity: "note",
          help: "every preset computes it exactly; set custom: false to offer presets only and silence this note",
        },
      );
    }
  });

  let grainFilter: string | undefined;
  let segmentFilter: string | undefined;
  (dashboard.filters ?? []).forEach((filter, i) => {
    if (filter.type === "segment") {
      if (segmentFilter !== undefined) {
        r.report(
          "HM3007",
          `/filters/${i}`,
          `a dashboard takes one segment filter, and "${segmentFilter}" is already one`,
          { help: "list every segment in one segment filter" },
        );
      }
      segmentFilter ??= filter.id;
      checkSegmentRefs(r, project, file, filter.segments, `/filters/${i}/segments`);
      filter.segments.forEach((name, j) => {
        const filters = project.segments.get(name)?.spec?.filters ?? [];
        const columns = filters.map((f) => f.column);
        const bound = read.filter((s) => columnsOf(project, s) === undefined || covers(columns)(s));
        for (const f of filters)
          for (const source of bound)
            checkKeyType(r, project, source, f, `/filters/${i}/segments/${j}`);
      });
      filter.segments.forEach((name, j) => {
        if (filter.segments.indexOf(name) !== j) {
          r.report("HM3007", `/filters/${i}/segments/${j}`, `segment "${name}" is listed twice`, {
            help: "list each segment once",
          });
        }
      });
      (filter.default ?? []).forEach((name, j) => {
        if (filter.segments.includes(name)) return;
        r.report(
          "HM3007",
          `/filters/${i}/default/${j}`,
          `default segment "${name}" is not one of segments (${filter.segments.join(", ")})`,
          { help: "add it to segments, or remove it from default" },
        );
      });
    }
    if (filter.type === "grain") {
      if (grainFilter !== undefined) {
        r.report(
          "HM3007",
          `/filters/${i}`,
          `a dashboard takes one grain filter, and "${grainFilter}" is already one`,
          { help: "merge the options into one grain filter" },
        );
      }
      grainFilter ??= filter.id;
    }
    if (filter.type === "period") {
      if (periodFilter !== undefined) {
        r.report(
          "HM3007",
          `/filters/${i}`,
          `a dashboard takes one period filter, and "${periodFilter}" is already one`,
          {
            help: "merge the options into one period filter; every block reads the same range",
          },
        );
      }
      periodFilter ??= filter.id;
    }
    if (filterIds.has(filter.id)) {
      r.report("HM2008", `/filters/${i}/id`, `duplicate filter id "${filter.id}"`);
    }
    filterIds.add(filter.id);
    if (filter.type !== "select" || filter.multiple === true || !Array.isArray(filter.default)) {
      return;
    }
    const values = filter.default;
    const [only] = values;
    const fix =
      values.length === 1 && only !== undefined
        ? replaceValueFix(
            file.document,
            `/filters/${i}/default`,
            only,
            "safe",
            `replace with ${JSON.stringify(only)}`,
          )
        : values.length > 1
          ? addPropertyFix(
              file.document,
              `/filters/${i}`,
              "multiple",
              true,
              "unsafe",
              "add multiple: true",
            )
          : undefined;
    r.report(
      "HM3008",
      `/filters/${i}/default`,
      `filter "${filter.id}" selects one value, but its default is a list`,
      {
        label:
          values.length === 0
            ? "an empty list"
            : `${values.length} value${values.length === 1 ? "" : "s"}`,
        help:
          values.length === 1
            ? "write the one value without brackets"
            : values.length === 0
              ? 'remove the default for "all", or set multiple: true'
              : "set multiple: true to select several values, or keep one value",
        ...optional("fix", fix),
      },
    );
  });
}

// DuckDB reads a source path with glob characters as several files.
function checkSourcePaths(project: Project, out: Diagnostic[]): void {
  const config = project.config;
  for (const [name, source] of Object.entries(config.spec?.sources ?? {})) {
    if (!isFileSource(source) || !GLOB_CHARACTERS.test(source.path)) continue;
    const pointer = `/sources/${name}/path`;
    const renamed = source.path.replace(/[*?[\]]/g, "_");
    const fix = replaceValueFix(
      config.document,
      pointer,
      renamed,
      "unsafe",
      `rename the file to "${renamed}" and point the source at it`,
    );
    out.push({
      code: "HM2016",
      severity: "error",
      message: `the path "${source.path}" of source "${name}" contains a glob character (*, ? or [)`,
      file: config.file,
      pointer,
      ...config.document.locationOf(pointer),
      help: "rename the file so its path has no *, ? or [",
      ...(fix ? { fix } : {}),
      docs: docsCommand("HM2016"),
    });
  }
}

function checkReservedColumns(project: Project, out: Diagnostic[]): void {
  const config = project.config;
  for (const [name, columns] of project.columns) {
    for (const column of columns.filter((c) => c.toLowerCase().startsWith("__hm_"))) {
      const pointer = `/sources/${name}/path`;
      out.push({
        code: "HM2017",
        severity: "error",
        message: `source "${name}" has a column "${column}"; names starting with __hm_ are reserved`,
        file: config.file,
        pointer,
        ...config.document.locationOf(pointer),
        help: "rename the column in the data file",
        docs: docsCommand("HM2017"),
      });
    }
  }
}

export function checkReferences(project: Project): Diagnostic[] {
  const out: Diagnostic[] = [];
  checkSourcePaths(project, out);
  checkReservedColumns(project, out);
  checkSources(project, out);
  checkSegments(project, out);
  checkMetrics(project, out);
  for (const file of project.dashboards.values()) checkDashboard(project, file, out);
  return out;
}
