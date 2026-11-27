/**
 * The expression grammar shared by formula metrics, row expressions and per_entity expressions.
 * One tokenizer and one precedence-climbing parser; the mode decides which names, literals,
 * operators and functions are allowed, so every error comes from one place and carries the
 * offsets of the offending token in the decoded string.
 */

export type ExprMode = "formula" | "row" | "entity";

export type BinaryOp = "+" | "-" | "*" | "/" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type Expr =
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "string"; value: string; start: number; end: number }
  | { kind: "null"; start: number; end: number }
  | { kind: "ref"; name: string; start: number; end: number }
  | { kind: "call"; fn: string; args: Expr[]; start: number; end: number }
  | { kind: "unary"; op: "-" | "not"; arg: Expr; start: number; end: number }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; start: number; end: number };

export interface ExprError {
  message: string;
  start: number;
  end: number;
}

export type ParseResult = { ok: true; expr: Expr } | { ok: false; error: ExprError };

/** Functions by mode, with their arity: [min, max]. */
const FUNCTIONS: Record<ExprMode, Record<string, [number, number]>> = {
  formula: { coalesce: [2, 16], min: [2, 16], max: [2, 16], abs: [1, 1] },
  row: {
    coalesce: [2, 16],
    greatest: [2, 16],
    least: [2, 16],
    abs: [1, 1],
    if: [3, 3],
    is_null: [1, 1],
    date_diff: [3, 3],
    match: [3, 65],
  },
  entity: { coalesce: [2, 16], greatest: [2, 16], least: [2, 16], abs: [1, 1], if: [3, 3] },
};

export const ENTITY_NAMES = ["current", "prior"] as const;
/** Words the parser reads as operators or literals, so no metric may be named after one. */
export const KEYWORDS: ReadonlySet<string> = new Set(["and", "or", "not", "null"]);
const DATE_DIFF_UNITS = ["day", "month"];

type Token =
  | { type: "number"; value: number; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  | { type: "name"; value: string; quoted: boolean; start: number; end: number }
  | { type: "op"; value: string; start: number; end: number }
  | { type: "end"; start: number; end: number };

class Failure extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
  }
}

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;

function tokenize(text: string, mode: ExprMode): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      while (/[0-9]/.test(text[i] ?? "")) i++;
      if (text[i] === "." && /[0-9]/.test(text[i + 1] ?? "")) {
        i++;
        while (/[0-9]/.test(text[i] ?? "")) i++;
      }
      if (start === i || text[start] === ".")
        throw new Failure(
          "a number needs a digit before the decimal point, such as 0.5",
          start,
          i + 1,
        );
      if (NAME_START.test(text[i] ?? ""))
        throw new Failure("unexpected letter after a number", i, i + 1);
      const value = Number(text.slice(start, i));
      if (!Number.isFinite(value)) throw new Failure("number too large", start, i);
      tokens.push({ type: "number", value, start, end: i });
      continue;
    }
    if (ch === "'") {
      if (mode !== "row")
        throw new Failure("strings are only allowed in row expressions", start, start + 1);
      let value = "";
      i++;
      for (;;) {
        if (i >= text.length) throw new Failure("string is not closed with '", start, text.length);
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i];
        i++;
      }
      tokens.push({ type: "string", value, start, end: i });
      continue;
    }
    if (ch === "`") {
      if (mode !== "row")
        throw new Failure("backquoted names are only allowed in row expressions", start, start + 1);
      const close = text.indexOf("`", i + 1);
      if (close < 0) throw new Failure("backquoted name is not closed with `", start, text.length);
      if (close === i + 1) throw new Failure("empty backquoted name", start, close + 1);
      tokens.push({
        type: "name",
        value: text.slice(i + 1, close),
        quoted: true,
        start,
        end: close + 1,
      });
      i = close + 1;
      continue;
    }
    if (NAME_START.test(ch)) {
      while (NAME_PART.test(text[i] ?? "")) i++;
      if (text[i] === "." && NAME_START.test(text[i + 1] ?? "")) {
        i++;
        while (NAME_PART.test(text[i] ?? "")) i++;
      }
      tokens.push({ type: "name", value: text.slice(start, i), quoted: false, start, end: i });
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "!=" || two === "<=" || two === ">=" || two === "<>") {
      if (two === "<>") throw new Failure('write "!=" for "not equal"', start, start + 2);
      tokens.push({ type: "op", value: two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if ("+-*/(),=<>".includes(ch)) {
      tokens.push({ type: "op", value: ch, start, end: i + 1 });
      i++;
      continue;
    }
    throw new Failure(`unexpected character "${ch}"`, start, start + 1);
  }
  tokens.push({ type: "end", start: text.length, end: text.length });
  return tokens;
}

const COMPARISONS = new Set(["=", "!=", "<", "<=", ">", ">="]);

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly mode: ExprMode,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.peek();
    if (token.type !== "end") this.pos++;
    return token;
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.type === "op" && t.value === value;
  }

  private op(): string {
    const t = this.next();
    return t.type === "op" ? t.value : "";
  }

  private isKeyword(value: string): boolean {
    const t = this.peek();
    return t.type === "name" && !t.quoted && t.value === value;
  }

  private logical(): boolean {
    return this.mode !== "formula";
  }

  parse(): Expr {
    const expr = this.or();
    const t = this.peek();
    if (t.type !== "end") throw new Failure(`unexpected "${describe(t)}"`, t.start, t.end);
    return expr;
  }

  private or(): Expr {
    let left = this.and();
    while (this.logical() && this.isKeyword("or")) {
      this.next();
      const right = this.and();
      left = { kind: "binary", op: "or", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.logical() && this.isKeyword("and")) {
      this.next();
      const right = this.not();
      left = { kind: "binary", op: "and", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private not(): Expr {
    if (this.logical() && this.isKeyword("not")) {
      const t = this.next();
      const arg = this.not();
      return { kind: "unary", op: "not", arg, start: t.start, end: arg.end };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    const left = this.additive();
    const t = this.peek();
    if (t.type === "op" && COMPARISONS.has(t.value)) {
      if (!this.logical())
        throw new Failure("comparisons are not allowed in a formula", t.start, t.end);
      this.next();
      const right = this.additive();
      const after = this.peek();
      if (after.type === "op" && COMPARISONS.has(after.value)) {
        throw new Failure(
          "comparisons cannot be chained; combine them with and",
          after.start,
          after.end,
        );
      }
      return {
        kind: "binary",
        op: t.value as BinaryOp,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.op() as "+" | "-";
      const right = this.multiplicative();
      left = { kind: "binary", op, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.op() as "*" | "/";
      const right = this.unary();
      left = { kind: "binary", op, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private unary(): Expr {
    if (this.isOp("-")) {
      const t = this.next();
      const arg = this.unary();
      return { kind: "unary", op: "-", arg, start: t.start, end: arg.end };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.next();
    if (t.type === "number") return { kind: "number", value: t.value, start: t.start, end: t.end };
    if (t.type === "string") return { kind: "string", value: t.value, start: t.start, end: t.end };
    if (t.type === "op" && t.value === "(") {
      const inner = this.or();
      const close = this.next();
      if (close.type !== "op" || close.value !== ")") {
        throw new Failure('missing ")"', close.start, close.end || close.start + 1);
      }
      return inner;
    }
    if (t.type === "name") return this.name(t);
    if (t.type === "end") throw new Failure("expression ends too early", t.start, t.end);
    throw new Failure(`unexpected "${describe(t)}"`, t.start, t.end);
  }

  private name(t: Extract<Token, { type: "name" }>): Expr {
    if (!t.quoted && t.value === "null") {
      if (this.mode !== "row")
        throw new Failure("null is only allowed in row expressions", t.start, t.end);
      return { kind: "null", start: t.start, end: t.end };
    }
    if (!t.quoted && KEYWORDS.has(t.value))
      throw new Failure(`unexpected "${t.value}"`, t.start, t.end);
    if (!t.quoted && this.isOp("(")) return this.call(t);
    if (this.mode === "formula" && !/^[a-z][a-z0-9_]*$/.test(t.value)) {
      throw new Failure(
        "metric names are lowercase snake_case, such as net_revenue",
        t.start,
        t.end,
      );
    }
    return { kind: "ref", name: t.value, start: t.start, end: t.end };
  }

  private call(t: Extract<Token, { type: "name" }>): Expr {
    const allowed = FUNCTIONS[this.mode];
    const arity = Object.hasOwn(allowed, t.value) ? allowed[t.value] : undefined;
    if (arity === undefined) {
      throw new Failure(
        `unknown function "${t.value}"; use one of ${Object.keys(allowed).join(", ")}`,
        t.start,
        t.end,
      );
    }
    this.next();
    const args: Expr[] = [];
    if (!this.isOp(")")) {
      for (;;) {
        args.push(this.or());
        if (!this.isOp(",")) break;
        this.next();
      }
    }
    const close = this.next();
    if (close.type !== "op" || close.value !== ")") {
      throw new Failure(
        `missing ")" after the arguments of ${t.value}`,
        close.start,
        close.end || close.start + 1,
      );
    }
    const [min, max] = arity;
    if (args.length < min || args.length > max) {
      const count = min === max ? `${min}` : `${min} to ${max}`;
      throw new Failure(
        `${t.value} takes ${count} arguments, not ${args.length}`,
        t.start,
        close.end,
      );
    }
    if (t.value === "date_diff") {
      const unit = args[0];
      if (unit?.kind !== "string" || !DATE_DIFF_UNITS.includes(unit.value)) {
        const at = unit ?? t;
        throw new Failure("the first argument of date_diff is 'day' or 'month'", at.start, at.end);
      }
    }
    return { kind: "call", fn: t.value, args, start: t.start, end: close.end };
  }
}

function describe(t: Token): string {
  if (t.type === "end") return "end";
  if (t.type === "string") return `'${t.value}'`;
  return String(t.value);
}

/** Parses an expression; offsets are indexes into the decoded string. */
export function parseExpr(text: string, mode: ExprMode): ParseResult {
  try {
    if (text.trim() === "")
      return { ok: false, error: { message: "empty expression", start: 0, end: text.length } };
    const expr = new Parser(tokenize(text, mode), mode).parse();
    return { ok: true, expr };
  } catch (e) {
    if (e instanceof Failure)
      return { ok: false, error: { message: e.message, start: e.start, end: e.end } };
    throw e;
  }
}

/** Every name an expression refers to, in order of appearance. */
export function exprRefs(expr: Expr): { name: string; start: number; end: number }[] {
  switch (expr.kind) {
    case "ref":
      return [{ name: expr.name, start: expr.start, end: expr.end }];
    case "call":
      return expr.args.flatMap(exprRefs);
    case "unary":
      return exprRefs(expr.arg);
    case "binary":
      return [...exprRefs(expr.left), ...exprRefs(expr.right)];
    default:
      return [];
  }
}

const BOOLEAN_FUNCTIONS = new Set(["is_null"]);

/** Whether the expression yields true/false rather than a number, a string or an instant. */
export function isCondition(expr: Expr): boolean {
  if (expr.kind === "unary") return expr.op === "not";
  if (expr.kind === "binary")
    return expr.op === "and" || expr.op === "or" || COMPARISONS.has(expr.op);
  if (expr.kind === "call") return BOOLEAN_FUNCTIONS.has(expr.fn);
  return false;
}

/** The first condition used where a value is expected, or a value used where a condition is. */
export function shapeError(expr: Expr, want: "value" | "condition"): ExprError | undefined {
  const at = (e: Expr, message: string): ExprError => ({ message, start: e.start, end: e.end });
  if (want === "condition") {
    if (!isCondition(expr)) return at(expr, "expected a condition, such as prior > 0");
    if (expr.kind === "binary" && (expr.op === "and" || expr.op === "or")) {
      return shapeError(expr.left, "condition") ?? shapeError(expr.right, "condition");
    }
    if (expr.kind === "unary") return shapeError(expr.arg, "condition");
    if (expr.kind === "binary")
      return shapeError(expr.left, "value") ?? shapeError(expr.right, "value");
    return undefined;
  }
  if (isCondition(expr)) return at(expr, "expected a value, not a condition");
  switch (expr.kind) {
    case "binary":
      return shapeError(expr.left, "value") ?? shapeError(expr.right, "value");
    case "unary":
      return shapeError(expr.arg, "value");
    case "call":
      if (expr.fn === "if") {
        const [cond, a, b] = expr.args as [Expr, Expr, Expr];
        return shapeError(cond, "condition") ?? shapeError(a, "value") ?? shapeError(b, "value");
      }
      if (expr.fn === "match") {
        return expr.args.map((a) => shapeError(a, "value")).find((e) => e !== undefined);
      }
      return expr.args.map((a) => shapeError(a, "value")).find((e) => e !== undefined);
    default:
      return undefined;
  }
}
