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
import { type Block, blockId, type Dashboard, DEFAULT_PERIOD } from "./dashboard.js";
import { isAdditive, type Metric } from "./metric.js";
import type { Project, SpecFile } from "./project.js";

export const TEXT_REFERENCE_FIELDS = ["value", "previous", "change", "change_pct"] as const;
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
      const range = extra.range ?? spec.document.rangeOf(pointer);
      out.push({
        code,
        severity: "error",
        message,
        file: spec.file,
        pointer,
        ...(range ? { range } : {}),
        ...extra,
        docs: docsCommand(code),
      });
    },
  };
}

function suggestion(
  input: string,
  options: string[],
  pointer: string,
): { help?: string; fix?: Fix } {
  const match = closestMatch(input, options);
  if (match === undefined) return {};
  return {
    help: `did you mean "${match}"?`,
    fix: {
      op: "replace",
      pointer,
      value: match,
      applicability: match.toLowerCase() === input.toLowerCase() ? "safe" : "unsafe",
      description: `replace with "${match}"`,
    },
  };
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
    if (metric.type !== "ratio") {
      if (project.config.spec && !sources.includes(metric.table)) {
        r.report("HM2001", "/table", `unknown source "${metric.table}"`, {
          label: "not a key of sources in hatchmark.json",
          expected: sources,
          ...suggestion(metric.table, sources, "/table"),
        });
      }
      continue;
    }
    for (const side of ["numerator", "denominator"] as const) {
      const ref = metric[side];
      if (!project.metrics.has(ref)) {
        r.report("HM2003", `/${side}`, `unknown metric "${ref}"`, {
          label: `no file metrics/${ref}.json`,
          expected: names,
          ...suggestion(ref, names, `/${side}`),
        });
      } else if (reaches(ref, name, metrics)) {
        r.report("HM2004", `/${side}`, `metric "${name}" refers back to itself through "${ref}"`);
      }
    }
  }
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
      ...suggestion(name, names, pointer),
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
            fix: {
              op: "remove",
              pointer,
              applicability: "unsafe",
              description: `remove "${name}" from percentOfTotal`,
            },
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
          ...suggestion(block.sort.by, allowed, `${base}/sort/by`),
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
        if (field !== undefined && field !== "value" && !metricHasTime(name, metrics)) {
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

  const filterIds = new Set<string>();
  (dashboard.filters ?? []).forEach((filter, i) => {
    if (filterIds.has(filter.id)) {
      r.report("HM2008", `/filters/${i}/id`, `duplicate filter id "${filter.id}"`);
    }
    filterIds.add(filter.id);
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
