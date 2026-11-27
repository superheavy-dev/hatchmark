import {
  closestMatch,
  type Diagnostic,
  type DiagnosticCode,
  docsCommand,
  type Fix,
  type JsonDocument,
  type JsonNode,
  type Severity,
} from "../diagnostics/index.js";
import { foldColumn, GLOB_CHARACTERS, sameColumn } from "./common.js";
import type { Source } from "./config.js";
import { type Block, blockId, type Dashboard, DEFAULT_PERIOD } from "./dashboard.js";
import { ENTITY_NAMES, type Expr, exprRefs, parseExpr, shapeError } from "./expr.js";
import { addPropertyFix, removeItemFix, replaceValueFix } from "./fixes.js";
import { filterTables, metricSources, readSources, sourceTables } from "./graph.js";
import type { Filter, Metric, TableMetric } from "./metric.js";
import type { Project, SpecFile } from "./project.js";
import {
  currencyUnit,
  exprCurrency,
  groupAdditive,
  metricCurrency,
  metricDeps,
  timeNature,
} from "./semantics.js";
import { parseTemporal, temporalRepair } from "./temporal.js";

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
  document: JsonDocument,
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

/** Maps an index in a decoded JSON string to its offset in the source text. */
function stringSourceOffset(document: JsonDocument, node: JsonNode, index: number): number {
  const text = document.text;
  let decoded = 0;
  let pos = node.start + 1;
  while (decoded < index && pos < node.end - 1) {
    if (text[pos] === "\\") pos += text[pos + 1] === "u" ? 6 : 2;
    else pos += 1;
    decoded += 1;
  }
  return pos;
}

/** Column names of a source, lowercased (DuckDB matches case-insensitively); undefined when unknown. */
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

/** Reports problems inside an expression string at the exact characters, not the whole value. */
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
      stringSourceOffset(file.document, node, start),
      stringSourceOffset(file.document, node, Math.max(end, start + 1)),
    ),
  };
}

/** Parses an expression field, reporting HM3010 at the offending token. */
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
    label: "not a key of sources in hatchmark.json",
    expected: sources,
    ...suggestion(file.document, name, sources, pointer),
  });
  return false;
}

/** Checks that each named column exists when the source's columns are known (HM2018). */
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
      label: `no file segments/${name}.json`,
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

function checkSegments(project: Project, out: Diagnostic[]): void {
  const sources = Object.keys(project.config.spec?.sources ?? {});
  for (const file of project.segments.values()) {
    if (file.spec === undefined) continue;
    checkFilterTables(reporter(file, out), project, file, file.spec.filters, "/filters", sources);
  }
}

/** Every column a table metric names, for HM2018, with exact ranges inside expressions. */
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
      if (project.config.spec && !sourceSuggestion(r, file, "/table", metric.table, sources))
        continue;
      checkColumns(r, project, metric.table, tableMetricColumns(r, file, metric, project));
      checkSnapshot(r, metric, configured);
      checkEvaluationLookups(r, name, metric, configured, metrics);
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
            help: `set "ends": "exclusive" to drop it from that bucket; set "ends": "inclusive" to keep the default and silence this note`,
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
            label: `no file metrics/${ref}.json`,
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
            help: `add "time" to metrics/${metric[side]}.json, or remove it from the other side`,
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
            label: `no file metrics/${ref.name}.json`,
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
              help: `add "time" to metrics/${untimed.name}.json, or keep timed and untimed metrics apart`,
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

    // per_entity
    checkFormatCurrency(r, name, metric, metrics, projectCurrency);
    if (!project.metrics.has(metric.of)) {
      r.report("HM2003", "/of", `unknown metric "${metric.of}"`, {
        label: `no file metrics/${metric.of}.json`,
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
          help: `set "group_at": "prior" to group by the reference instant (a cohort view); set "group_at": "current" to keep the default and silence this note`,
        },
      );
    }
  }
}

/**
 * HM3009: a filter on the metric's time column must be a strict ISO 8601 date or date-time, so its
 * meaning never depends on a database's cast rules (see parseTemporal).
 */
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

/** HM4009: a flow and a point-in-time value can't be combined; they measure different things. */
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
      help: `give "${flow.name}" a "trailing" window (such as {"days": 30}) so it is read at an instant too`,
    },
  );
}

/** HM4007: an aggregate over a snapshot table must read one snapshot date at a time. */
function checkSnapshot(r: Reporter, metric: TableMetric, configured: Record<string, Source>): void {
  const declared = configured[metric.table];
  const base = declared?.type === "lookup" ? configured[declared.from] : declared;
  if (base === undefined || base.type === "lookup" || base.snapshot === undefined) return;
  const column = base.snapshot;
  const help = `read one snapshot date at a time: "time": "${column}" with "over_time": "last" (or "first", "avg", "min", "max")`;
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

/** HM4019: an as-of lookup at "$evaluation" only has an instant to join at for point-in-time metrics. */
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
      label: '"at": "$evaluation" needs a point-in-time metric',
      help: 'join at each row\'s own time with "at": "<time column>" in a separate lookup source, or read the metric at an instant (over_time, active or trailing)',
    },
  );
}

/**
 * HM4005: adding, subtracting or choosing between values in different currencies (see
 * exprCurrency), with each operand's currency derived rather than read from its format.
 */
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

/** HM4005: a derived metric whose format names another currency than the one its values are in. */
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
    help: `set "currency": "${derived}" in format, or convert the operands to ${shown}`,
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
          help: 'set "prorate": "none", which is the default for this metric',
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
        help: 'replace "window" with "at": "<date>"',
      });
    }
    if (nature === "flow" && test.at !== undefined) {
      r.report(
        "HM3007",
        `${base}/at`,
        'this metric is summed over a period; test it with "window"',
        { help: 'replace "at" with "window": ["<start>", "<end>"]' },
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

function blockMetricRefs(block: Block): { pointer: string; name: string }[] {
  switch (block.type) {
    case "kpi":
    case "bar_list":
      return [{ pointer: "/metric", name: block.metric }];
    case "line":
    case "area":
    case "bar":
    case "table":
      return block.metrics.map((name, i) => ({ pointer: `/metrics/${i}`, name }));
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

function checkDashboard(project: Project, file: SpecFile<"dashboard">, out: Diagnostic[]): void {
  const dashboard = file.spec;
  if (dashboard === undefined) return;
  const r = reporter(file, out);
  const metrics = metricMap(project);
  const names = [...project.metrics.keys()];

  const checkRef = (pointer: string, name: string): boolean => {
    if (project.metrics.has(name)) return true;
    r.report("HM2003", pointer, `unknown metric "${name}"`, {
      label: `no file metrics/${name}.json`,
      expected: names,
      ...suggestion(file.document, name, names, pointer),
    });
    return false;
  };

  const blockIds = new Map<string, number>();
  dashboard.blocks.forEach((block, index) => {
    const base = `/blocks/${index}`;
    const id = blockId(block, index);
    const first = blockIds.get(id);
    if (first !== undefined) {
      r.report("HM2008", block.id ? `${base}/id` : base, `duplicate block id "${id}"`, {
        help: `block ${first} already uses this id${block.id ? "" : " (ids default to <type>_<index>)"}; give one of them a different id`,
      });
    } else {
      blockIds.set(id, index);
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
                ? `add "time" to metrics/${ref.name}.json, or set "compare": "none" on this block`
                : `add "time": "<date column>" to metrics/${ref.name}.json`,
          },
        );
      }
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
            label: `${metric.type === "aggregate" ? metric.aggregate : metric.type === "formula" ? "a non-linear formula" : metric.type} does not add up across rows`,
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
    }

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
                stringSourceOffset(file.document, node, index),
                stringSourceOffset(file.document, node, index + match[0].length),
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
            label: `no file metrics/${name}.json`,
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

  dashboard.blocks.forEach((block, index) => {
    const names =
      block.type === "text"
        ? [...block.markdown.matchAll(TEXT_REFERENCE)].flatMap(
            (m) => TEXT_REFERENCE_BODY.exec((m[1] ?? "").trim())?.[1] ?? [],
          )
        : blockMetricRefs(block).map((ref) => ref.name);
    const configured = project.config.spec?.sources ?? {};
    const sources = new Set(
      names
        .flatMap((name) => [...metricSources(project, name)])
        .filter((s) => Object.hasOwn(configured, s)),
    );
    if (sources.size < 2) return;
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
  (dashboard.filters ?? []).forEach((filter, i) => {
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
              'add "multiple": true',
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
              ? 'remove the default for "all", or set "multiple": true'
              : 'set "multiple": true to select several values, or keep one value',
        ...optional("fix", fix),
      },
    );
  });
}

/**
 * Checks references between files: metric to source, ratio to metric, dashboard to metric,
 * text references, ids and table options. Pure and cheap, so it can run on every edit.
 */
/** HM2016: a source path with glob characters, which DuckDB would read as several files. */
function checkSourcePaths(project: Project, out: Diagnostic[]): void {
  const config = project.config;
  for (const [name, source] of Object.entries(config.spec?.sources ?? {})) {
    if (source.type === "lookup" || !GLOB_CHARACTERS.test(source.path)) continue;
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

/** HM2017: a source column whose name starts with __hm_, which the engine reserves for its own. */
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
