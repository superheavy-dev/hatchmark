import { type Expr, parseExpr } from "./expr.js";
import type { Metric } from "./metric.js";
import { ownTimeNature, type TimeNature } from "./units.js";

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
 * time. Sums and counts are, read at any instant or over any period, including over_time last,
 * first and avg (the snapshot dates are the source's, not each group's). over_time min and max are
 * not: each group can peak on a different date. Distinct counts, averages, medians and ratios are
 * not. A formula is additive when it is a linear combination of additive metrics with no constant
 * term (a + 1 adds 1 to every group but only once to the total).
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
      return (
        (metric.aggregate === "sum" || metric.aggregate === "count") &&
        metric.over_time !== "min" &&
        metric.over_time !== "max"
      );
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

/**
 * Whether the metric over a set of groups can be recomputed from the groups' own parts, the way a
 * table's Other row folds the rows past its limit: sums and counts add up, min and max take the
 * extreme, an average divides its summed sum by its summed count, and a ratio divides two foldable
 * metrics. Distinct counts, medians, SQL metrics declared additive: false, sums read with over_time
 * min or max, and formulas cannot: they need the rows again.
 */
export function groupFoldable(
  name: string,
  metrics: ReadonlyMap<string, Metric>,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const metric = metrics.get(name);
  if (metric === undefined || seen.has(name)) return false;
  const next = new Set(seen).add(name);
  switch (metric.type) {
    case "aggregate":
      return (
        ["sum", "count", "avg", "min", "max"].includes(metric.aggregate) &&
        metric.over_time !== "min" &&
        metric.over_time !== "max"
      );
    case "sql":
      return metric.additive;
    case "ratio":
      return (
        groupFoldable(metric.numerator, metrics, next) &&
        groupFoldable(metric.denominator, metrics, next)
      );
    default:
      return false;
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
      if (expr.op === "+" || expr.op === "-") {
        if (a === "const" && b === "const") return "const";
        return a === "linear" && b === "linear" ? "linear" : "no";
      }
      if (expr.op === "*")
        return a === "const" || b === "const" ? (a === b ? "const" : "linear") : "no";
      if (expr.op === "/") return b === "const" ? a : "no";
      return "no";
    }
    default:
      return "no";
  }
}

/** A value's currency: a code, null for a known non-currency value, undefined when unknown. */
export type CurrencyUnit = string | null | undefined;

function divideUnits(a: CurrencyUnit, b: CurrencyUnit): CurrencyUnit {
  if (a === undefined || b === undefined) return undefined;
  if (typeof b === "string") return typeof a === "string" ? null : undefined;
  return a;
}

function multiplyUnits(a: CurrencyUnit, b: CurrencyUnit): CurrencyUnit {
  if (a === null) return b;
  if (b === null) return a;
  return undefined;
}

/**
 * The currency of a formula expression. A number has none; +, - and the choosing functions
 * (coalesce, min, max, if) need one currency and report two with mismatch; a non-currency factor or
 * divisor keeps its operand's currency, and a currency divided by a currency has none.
 */
export function exprCurrency(
  expr: Expr,
  unitOf: (name: string) => CurrencyUnit,
  mismatch: (at: Expr, a: string, b: string) => void = () => {},
): CurrencyUnit {
  const same = (at: Expr, units: CurrencyUnit[]): CurrencyUnit => {
    const codes = [...new Set(units.filter((u): u is string => typeof u === "string"))];
    const [first, second] = codes;
    if (first !== undefined && second !== undefined) {
      mismatch(at, first, second);
      return undefined;
    }
    if (first !== undefined) return first;
    return units.includes(undefined) ? undefined : null;
  };
  const unit = (e: Expr): CurrencyUnit => {
    switch (e.kind) {
      case "number":
        return null;
      case "ref":
        return unitOf(e.name);
      case "unary":
        return unit(e.arg);
      case "call": {
        const units = e.args.map(unit);
        if (e.fn === "abs") return units[0];
        return same(e, e.fn === "if" ? units.slice(1) : units);
      }
      case "binary": {
        const a = unit(e.left);
        const b = unit(e.right);
        if (e.op === "+" || e.op === "-") return same(e, [a, b]);
        if (e.op === "*") return multiplyUnits(a, b);
        if (e.op === "/") return divideUnits(a, b);
        return undefined;
      }
      default:
        return undefined;
    }
  };
  return unit(expr);
}

/**
 * The currency a metric's values are in, derived through ratios, formulas and per_entity rather
 * than read from its format, so a format cannot relabel one currency as another.
 */
export function metricCurrency(
  name: string,
  metrics: ReadonlyMap<string, Metric>,
  projectCurrency: string,
  seen: ReadonlySet<string> = new Set(),
): CurrencyUnit {
  const metric = metrics.get(name);
  if (metric === undefined || seen.has(name)) return undefined;
  const next = new Set(seen).add(name);
  const of = (dep: string) => metricCurrency(dep, metrics, projectCurrency, next);
  switch (metric.type) {
    case "aggregate":
    case "sql":
      return currencyUnit(metric, projectCurrency) ?? null;
    case "per_entity":
      return metric.aggregate === "count" ? null : of(metric.of);
    case "ratio":
      return divideUnits(of(metric.numerator), of(metric.denominator));
    case "formula": {
      const parsed = parseExpr(metric.expr, "formula");
      return parsed.ok ? exprCurrency(parsed.expr, of) : undefined;
    }
  }
}

/** The currency a metric is shown in, or undefined when it is not a currency. */
export function currencyUnit(metric: Metric, projectCurrency: string): string | undefined {
  return metric.format.type === "currency"
    ? (metric.format.currency ?? projectCurrency)
    : undefined;
}
