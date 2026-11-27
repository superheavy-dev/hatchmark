import type { z } from "zod";
import {
  closestMatch,
  type Diagnostic,
  type DiagnosticCode,
  docsCommand,
  type Fix,
  type JsonDocument,
  toPointer,
} from "../diagnostics/index.js";
import { addPropertyFix, replaceValueFix } from "./fixes.js";

type Path = (string | number)[];
// biome-ignore lint/suspicious/noExplicitAny: walking Zod's internal definitions
type AnyDef = any;

function defOf(schema: z.ZodType): AnyDef {
  return (schema as unknown as { _zod: { def: AnyDef } })._zod.def;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = defOf(current);
    if (
      ["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional"].includes(
        def.type,
      )
    ) {
      current = def.innerType;
    } else if (def.type === "pipe") {
      current = def.in;
    } else {
      return current;
    }
  }
}

function literalValues(schema: z.ZodType): unknown[] {
  const def = defOf(unwrap(schema));
  if (def.type === "literal") return def.values;
  if (def.type === "enum") return Object.values(def.entries);
  return [];
}

/** The schema that validates the value at path, following discriminated unions by the value. */
function schemaAt(root: z.ZodType, value: unknown, path: Path): z.ZodType | undefined {
  let schema: z.ZodType | undefined = root;
  let current = value;
  for (let i = 0; i <= path.length; i++) {
    if (schema === undefined) return undefined;
    schema = unwrap(schema);
    let def = defOf(schema);
    if (def.type === "union") {
      const disc: string | undefined = def.discriminator;
      const options: z.ZodType[] = def.options;
      const tag =
        disc && current && typeof current === "object"
          ? (current as Record<string, unknown>)[disc]
          : undefined;
      const picked = options.find((option) => {
        if (!disc) return defOf(unwrap(option)).type === "object";
        const shape = defOf(unwrap(option)).shape;
        return shape && literalValues(shape[disc]).includes(tag);
      });
      if (picked === undefined) return i === path.length ? schema : undefined;
      schema = unwrap(picked);
      def = defOf(schema);
    }
    if (i === path.length) return schema;
    const key = path[i] as string | number;
    if (def.type === "object") schema = def.shape[key];
    else if (def.type === "array") schema = def.element;
    else if (def.type === "record") schema = def.valueType;
    else return undefined;
    current =
      current && typeof current === "object"
        ? (current as Record<string | number, unknown>)[key]
        : undefined;
  }
  return schema;
}

function objectKeys(root: z.ZodType, value: unknown, path: Path): string[] {
  const schema = schemaAt(root, value, path);
  if (schema === undefined) return [];
  const def = defOf(schema);
  return def.type === "object" ? Object.keys(def.shape) : [];
}

function valueAt(
  value: unknown,
  path: Path,
): { found: boolean; value?: unknown; parent?: unknown } {
  let current = value;
  let parent: unknown;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      return { found: false, parent: current };
    }
    parent = current;
    current = (current as Record<string | number, unknown>)[key];
  }
  return { found: true, value: current, parent };
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function closestFix(
  document: JsonDocument,
  input: unknown,
  options: string[],
  pointer: string,
): { help?: string; fix?: Fix } {
  if (typeof input !== "string") return {};
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

export interface IssueContext {
  root: z.ZodType;
  document: JsonDocument;
  /** Values for missing required properties that are safe to add, keyed by property name. */
  defaults?: Readonly<Record<string, unknown>>;
}

/** Turns Zod issues into Hatchmark diagnostics with positions, expected values and fixes. */
export function issuesToDiagnostics(
  issues: readonly z.core.$ZodIssue[],
  ctx: IssueContext,
): Diagnostic[] {
  const { document, root } = ctx;
  const value = document.value;
  const file = document.file;
  const out: Diagnostic[] = [];

  const push = (
    code: DiagnosticCode,
    path: Path,
    message: string,
    extra: Partial<Diagnostic> & { target?: "key" | "value" } = {},
  ): void => {
    const { target, ...rest } = extra;
    const pointer = toPointer(path);
    const location = document.locationOf(pointer, target);
    out.push({
      code,
      severity: "error",
      message,
      file,
      pointer,
      ...location,
      ...rest,
      docs: docsCommand(code),
    });
  };

  for (const issue of issues) {
    const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    const at = valueAt(value, path);
    const key = path.at(-1);

    if (issue.code === "custom") {
      const code =
        (issue.params as { hatchmark?: DiagnosticCode } | undefined)?.hatchmark ?? "HM3005";
      push(code, path, issue.message);
      continue;
    }

    if (
      !at.found &&
      key !== undefined &&
      (issue.code === "invalid_type" ||
        issue.code === "invalid_union" ||
        issue.code === "invalid_value")
    ) {
      const name = String(key);
      const options =
        issue.code === "invalid_union" && "options" in issue
          ? (issue.options as unknown[]).map(String)
          : undefined;
      const fallback =
        path.length === 1 && ctx.defaults && Object.hasOwn(ctx.defaults, name)
          ? ctx.defaults[name]
          : undefined;
      const fix =
        fallback === undefined
          ? undefined
          : addPropertyFix(
              document,
              toPointer(path.slice(0, -1)),
              name,
              fallback,
              "safe",
              `add "${name}": ${JSON.stringify(fallback)} (the default)`,
            );
      push("HM3001", path, `missing required property "${name}"`, {
        label: `add "${name}"`,
        ...(options ? { expected: options } : {}),
        ...(fix ? { fix } : {}),
      });
      continue;
    }

    switch (issue.code) {
      case "unrecognized_keys": {
        const allowed = objectKeys(root, value, path);
        for (const extraKey of issue.keys) {
          const keyPath = [...path, extraKey];
          const match = closestMatch(
            extraKey,
            allowed.filter((k) => !(at.value && Object.hasOwn(at.value, k))),
          );
          const found = document.locate(toPointer(keyPath));
          const keyRange = found?.member
            ? document.rangeAt(found.member.keyStart, found.member.keyEnd)
            : undefined;
          push("HM3002", keyPath, `unknown property "${extraKey}"`, {
            target: "key",
            expected: allowed,
            ...(match ? { help: `did you mean "${match}"?` } : {}),
            ...(match && keyRange
              ? {
                  fix: {
                    range: keyRange,
                    text: JSON.stringify(match),
                    applicability:
                      match.toLowerCase() === extraKey.toLowerCase() ? "safe" : "unsafe",
                    description: `rename to "${match}"`,
                  } satisfies Fix,
                }
              : {}),
          });
        }
        break;
      }
      case "invalid_type":
        push("HM3003", path, `expected ${issue.expected}, found ${describeType(at.value)}`);
        break;
      case "invalid_value": {
        const expected = issue.values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
        push("HM3004", path, `invalid value ${JSON.stringify(at.value)}`, {
          expected,
          ...closestFix(document, at.value, expected, toPointer(path)),
        });
        break;
      }
      case "invalid_union": {
        if ("discriminator" in issue && issue.discriminator !== undefined) {
          const options = ((issue as { options?: unknown[] }).options ?? []).map(String);
          push("HM3004", path, `invalid ${String(key)} ${JSON.stringify(at.value)}`, {
            expected: options,
            ...closestFix(document, at.value, options, toPointer(path)),
          });
          break;
        }
        const branches = issue.errors.map((branch) => branch.find((e) => e.path.length === 0));
        const types = branches.flatMap((b) =>
          b?.code === "invalid_type"
            ? [b.expected]
            : b?.code === "invalid_value"
              ? b.values.map((v) => JSON.stringify(v))
              : [],
        );
        push(
          "HM3003",
          path,
          types.length === branches.length
            ? `expected ${[...new Set(types)].join(" or ")}, found ${describeType(at.value)}`
            : "value does not match any allowed form",
        );
        break;
      }
      case "too_small":
      case "too_big": {
        const small = issue.code === "too_small";
        const bound = Number(small ? issue.minimum : issue.maximum);
        const inclusive = issue.inclusive ?? true;
        const noun =
          issue.origin === "array" ? "item" : issue.origin === "string" ? "character" : undefined;
        const message = noun
          ? `must have ${small ? "at least" : "at most"} ${bound} ${noun}${bound === 1 ? "" : "s"}`
          : `must be ${small ? (inclusive ? "at least" : "more than") : inclusive ? "at most" : "less than"} ${bound}`;
        push("HM3005", path, message);
        break;
      }
      case "invalid_format":
      case "not_multiple_of":
        push("HM3005", path, issue.message);
        break;
      case "invalid_key":
        push(
          "HM3005",
          path,
          `invalid name "${String(key)}": ${issue.issues[0]?.message ?? issue.message}`,
          { target: "key" },
        );
        break;
      default:
        push("HM3005", path, issue.message);
    }
  }
  return out;
}
