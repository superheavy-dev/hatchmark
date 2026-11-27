import { type Expr, parseExpr } from "./expr.js";
import { type Metric, ownTimeNature, type TimeNature } from "./metric.js";

/** The metrics a metric refers to: ratio sides, formula names, or a per_entity metric's of. */
export function metricDeps(metric: Metric): string[] {
  switch (metric.type) {
    case "ratio":
      return [metric.numerator, metric.denominator];
    case "per_entity":
      return [metric.of];
    case "formula": {
      const parsed = parseExpr(metric.expr, "formula");
      return parsed.ok ? formulaRefs(parsed.expr) : [];
    }
    default:
      return [];
  }
}

function formulaRefs(expr: Expr): string[] {
  switch (expr.kind) {
    case "ref":
      return [expr.name];
    case "call":
      return expr.args.flatMap(formulaRefs);
    case "unary":
      return formulaRefs(expr.arg);
    case "binary":
      return [...formulaRefs(expr.left), ...formulaRefs(expr.right)];
    default:
      return [];
  }
}

/**
 * A metric's time nature, derived through ratios, formulas and per_entity. "mixed" when the
 * metrics it combines disagree (check reports that); undefined when a reference is unknown or
 * circular.
 */
export function timeNature(
  name: string,
  metrics: ReadonlyMap<string, Metric>,
  seen: ReadonlySet<string> = new Set(),
): TimeNature | "mixed" | undefined {
  const metric = metrics.get(name);
  if (metric === undefined || seen.has(name)) return undefined;
  if (metric.type === "aggregate" || metric.type === "sql") return ownTimeNature(metric);
  if (metric.type === "per_entity") return "point";
  const next = new Set(seen).add(name);
  const natures = new Set<TimeNature | "mixed" | undefined>();
  for (const dep of metricDeps(metric)) natures.add(timeNature(dep, metrics, next));
  if (natures.has(undefined)) return undefined;
  if (natures.size === 0) return "static";
  return natures.size === 1 ? [...natures][0] : "mixed";
}

/**
 * Whether summing the metric over groups gives the metric over all rows, at the same point in
 * time. Sums and counts are; distinct counts, averages, medians, ratios and non-linear formulas
 * are not. A formula is additive when it is a linear combination of additive metrics.
 */
export function groupAdditive(
  name: string,
  metrics: ReadonlyMap<string, Metric>,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const metric = metrics.get(name);
  if (metric === undefined || seen.has(name)) return false;
  switch (metric.type) {
    case "aggregate":
      return metric.aggregate === "sum" || metric.aggregate === "count";
    case "sql":
      return metric.additive;
    case "ratio":
      return false;
    case "per_entity":
      return true;
    case "formula": {
      const parsed = parseExpr(metric.expr, "formula");
      const next = new Set(seen).add(name);
      return (
        parsed.ok && linear(parsed.expr, (ref) => groupAdditive(ref, metrics, next)) === "linear"
      );
    }
  }
}

type Linearity = "const" | "linear" | "no";

function linear(expr: Expr, additive: (name: string) => boolean): Linearity {
  switch (expr.kind) {
    case "number":
      return "const";
    case "ref":
      return additive(expr.name) ? "linear" : "no";
    case "unary":
      return expr.op === "-" ? linear(expr.arg, additive) : "no";
    case "binary": {
      const a = linear(expr.left, additive);
      const b = linear(expr.right, additive);
      if (a === "no" || b === "no") return "no";
      if (expr.op === "+" || expr.op === "-")
        return a === "const" && b === "const" ? "const" : "linear";
      if (expr.op === "*")
        return a === "const" || b === "const" ? (a === b ? "const" : "linear") : "no";
      if (expr.op === "/") return b === "const" ? a : "no";
      return "no";
    }
    default:
      return "no";
  }
}

/** The currency a metric is shown in, or undefined when it is not a currency. */
export function currencyUnit(metric: Metric, projectCurrency: string): string | undefined {
  return metric.format.type === "currency"
    ? (metric.format.currency ?? projectCurrency)
    : undefined;
}
