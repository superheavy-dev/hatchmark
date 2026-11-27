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
import { hasColumn, sameColumn } from "./common.js";
import { type Block, blockId, type Dashboard, DEFAULT_PERIOD } from "./dashboard.js";
import { addPropertyFix, removeItemFix, replaceValueFix } from "./fixes.js";
import { metricSources } from "./graph.js";
import { isAdditive, type Metric } from "./metric.js";
import type { Project, SpecFile } from "./project.js";
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
export function metricHasTime(
  name: string,
  metrics: ReadonlyMap<string, Metric>,
  seen = new Set<string>(),
): boolean {
  const metric = metrics.get(name);
  if (metric === undefined || seen.has(name)) return false;
  if (metric.type !== "ratio") return metric.time !== undefined;
  seen.add(name);
  return (
    metricHasTime(metric.numerator, metrics, new Set(seen)) &&
    metricHasTime(metric.denominator, metrics, new Set(seen))
  );
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

function checkMetrics(project: Project, out: Diagnostic[]): void {
  const sources = Object.keys(project.config.spec?.sources ?? {});
  const metrics = metricMap(project);
  const names = [...project.metrics.keys()];
  for (const [name, file] of project.metrics) {
    const metric = file.spec;
    if (metric === undefined) continue;
    const r = reporter(file, out);
    if (metric.type !== "ratio") checkTimeFilters(file, metric, r);
    if (metric.type !== "ratio") {
      if (project.config.spec && !sources.includes(metric.table)) {
        r.report("HM2001", "/table", `unknown source "${metric.table}"`, {
          label: "not a key of sources in hatchmark.json",
          expected: sources,
          ...suggestion(file.document, metric.table, sources, "/table"),
        });
      }
      continue;
    }
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
  if (metric?.type !== "ratio") return false;
  return (
    reaches(metric.numerator, target, metrics, seen) ||
    reaches(metric.denominator, target, metrics, seen)
  );
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
        if (metric && !isAdditive(metric)) {
          r.report("HM4001", pointer, `percent of total is not meaningful for "${name}"`, {
            label: `${metric.type === "aggregate" ? metric.aggregate : metric.type} does not add up across rows`,
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
      const unknown = list.filter((s) => !project.columns.has(s));
      const lacking = list.filter(
        (s) => hasColumn(project.columns.get(s), filter.column) === false,
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
export function checkReferences(project: Project): Diagnostic[] {
  const out: Diagnostic[] = [];
  checkMetrics(project, out);
  for (const file of project.dashboards.values()) checkDashboard(project, file, out);
  return out;
}
