import { describe, expect, it } from "vitest";
import { type Expr, exprRefs, parseExpr, shapeError } from "../../src/spec/index.js";

function show(e: Expr): string {
  switch (e.kind) {
    case "number":
      return String(e.value);
    case "string":
      return `'${e.value}'`;
    case "null":
      return "null";
    case "ref":
      return e.name;
    case "call":
      return `${e.fn}(${e.args.map(show).join(", ")})`;
    case "unary":
      return `(${e.op} ${show(e.arg)})`;
    case "binary":
      return `(${show(e.left)} ${e.op} ${show(e.right)})`;
  }
}

const ok = (text: string, mode: "formula" | "row" | "entity" = "formula"): string => {
  const r = parseExpr(text, mode);
  if (!r.ok) throw new Error(r.error.message);
  return show(r.expr);
};
const fail = (text: string, mode: "formula" | "row" | "entity" = "formula") => {
  const r = parseExpr(text, mode);
  if (r.ok) throw new Error(`parsed: ${show(r.expr)}`);
  return { ...r.error, text: text.slice(r.error.start, r.error.end) };
};

describe("parseExpr", () => {
  it("follows arithmetic precedence and associativity", () => {
    expect(ok("a + b * 0.6")).toBe("(a + (b * 0.6))");
    expect(ok("a - b - c")).toBe("((a - b) - c)");
    expect(ok("a / b / c")).toBe("((a / b) / c)");
    expect(ok("-a * b")).toBe("((- a) * b)");
    expect(ok("(a + b) * 12")).toBe("((a + b) * 12)");
    expect(ok("coalesce(a, 0) + max(b, c)")).toBe("(coalesce(a, 0) + max(b, c))");
  });

  it("puts not below comparisons and and below or-free terms", () => {
    expect(ok("prior > 0 and current >= prior or not current = 0", "entity")).toBe(
      "(((prior > 0) and (current >= prior)) or (not (current = 0)))",
    );
  });

  it("reads row expressions with lookups, strings, null and backquoted names", () => {
    expect(
      ok("match(interval, 'year', 1.0 / 12, 'month', 1) * `Unit Price` / currencies.minor", "row"),
    ).toBe("((match(interval, 'year', (1 / 12), 'month', 1) * Unit Price) / currencies.minor)");
    expect(ok("coalesce(valid_to, subscriptions.ended_at, null)", "row")).toBe(
      "coalesce(valid_to, subscriptions.ended_at, null)",
    );
    expect(ok("if(status = 'it''s', 1, 0)", "row")).toBe("if((status = 'it's'), 1, 0)");
  });

  it("keeps decoded offsets of every name", () => {
    const r = parseExpr("subscription_arr + credit_runrate * 0.6", "formula");
    expect(r.ok && exprRefs(r.expr)).toEqual([
      { name: "subscription_arr", start: 0, end: 16 },
      { name: "credit_runrate", start: 19, end: 33 },
    ]);
  });

  it("points at the offending token", () => {
    expect(fail("a + * b")).toMatchObject({ text: "*", message: 'unexpected "*"' });
    expect(fail("a + (b")).toMatchObject({ message: 'missing ")"' });
    expect(fail("a b")).toMatchObject({ text: "b", message: 'unexpected "b"' });
    expect(fail("")).toMatchObject({ message: "empty expression" });
    expect(fail("a + $b")).toMatchObject({ text: "$" });
    expect(fail("1.2.3")).toMatchObject({ text: ".3" });
    expect(fail("2x")).toMatchObject({ text: "x" });
  });

  it("allows only what each mode allows", () => {
    expect(fail("a > b")).toMatchObject({
      text: ">",
      message: "comparisons are not allowed in a formula",
    });
    expect(fail("Revenue + a")).toMatchObject({ text: "Revenue" });
    expect(fail("greatest(a, b)")).toMatchObject({ text: "greatest" });
    expect(fail("a + 'x'")).toMatchObject({ text: "'" });
    expect(fail("a + null")).toMatchObject({ text: "null" });
    expect(fail("date(x)", "row")).toMatchObject({
      text: "date",
      message: expect.stringContaining("unknown function"),
    });
    expect(fail("match(current, 1, 2)", "entity")).toMatchObject({ text: "match" });
    expect(fail("a <> b", "row")).toMatchObject({ message: 'write "!=" for "not equal"' });
    expect(fail("a < b < c", "row")).toMatchObject({
      text: "<",
      message: expect.stringContaining("chained"),
    });
  });

  it("keeps a name's location inside parentheses, and refuses numbers too large to hold", () => {
    const r = parseExpr("((revenu)) * 2", "formula");
    expect(r.ok && exprRefs(r.expr)).toEqual([{ name: "revenu", start: 2, end: 8 }]);
    expect(fail(`1${"0".repeat(309)}`)).toMatchObject({ message: "number too large" });
    expect(fail(`coalesce(${Array(17).fill("a").join(", ")})`)).toMatchObject({
      message: "coalesce takes 2 to 16 arguments, not 17",
    });
  });

  it("checks arity and date_diff units", () => {
    expect(fail("abs(a, b)")).toMatchObject({
      text: "abs(a, b)",
      message: "abs takes 1 arguments, not 2",
    });
    expect(fail("coalesce(a)")).toMatchObject({
      message: "coalesce takes 2 to 16 arguments, not 1",
    });
    expect(fail("if(a, b)", "row")).toMatchObject({ message: "if takes 3 arguments, not 2" });
    expect(fail("date_diff('week', a, b)", "row")).toMatchObject({ text: "'week'" });
    expect(ok("date_diff('day', period_start, period_end)", "row")).toBe(
      "date_diff('day', period_start, period_end)",
    );
  });
});

describe("shapeError", () => {
  const parse = (text: string, mode: "row" | "entity" = "entity") => {
    const r = parseExpr(text, mode);
    if (!r.ok) throw new Error(r.error.message);
    return r.expr;
  };

  it("wants a condition for where and a value for expr", () => {
    expect(shapeError(parse("prior > 0 and current > 0"), "condition")).toBeUndefined();
    expect(shapeError(parse("prior"), "condition")).toMatchObject({ start: 0, end: 5 });
    expect(shapeError(parse("prior > 0 and current"), "condition")).toMatchObject({
      start: 14,
      end: 21,
    });
    expect(shapeError(parse("least(current, prior)"), "value")).toBeUndefined();
    expect(shapeError(parse("current > prior"), "value")).toMatchObject({
      message: "expected a value, not a condition",
    });
    expect(shapeError(parse("if(prior > 0, current, 0)"), "value")).toBeUndefined();
    expect(shapeError(parse("if(prior, current, 0)"), "value")).toMatchObject({ start: 3, end: 8 });
  });
});
