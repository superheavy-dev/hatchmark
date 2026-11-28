import type { core, z } from "zod";
import {
  closestMatch,
  type Diagnostic,
  type DiagnosticCode,
  docsCommand,
  type Fix,
  type SpecDocument,
  toPointer,
} from "../diagnostics/index.js";
import tokens from "../render/themes/default.json" with { type: "json" };
import { addPropertyFix, removePropertyFix, replaceValueFix, yamlText } from "./fixes.js";
import { HEIGHT_PRESETS } from "./layout.js";

type Path = (string | number)[];
type Schema = core.$ZodType;

const defOf = (schema: Schema) => (schema as core.$ZodTypes)._zod.def;

function unwrap(schema: Schema): Schema {
  let current = schema;
  for (;;) {
    const def = defOf(current);
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "readonly":
      case "catch":
      case "nonoptional":
        current = def.innerType;
        break;
      case "pipe":
        current = def.in;
        break;
      default:
        return current;
    }
  }
}

function literalValues(schema: Schema | undefined): unknown[] {
  if (schema === undefined) return [];
  const def = defOf(unwrap(schema));
  if (def.type === "literal") return [...def.values];
  if (def.type === "enum") return Object.values(def.entries);
  return [];
}

function schemaAt(root: Schema, value: unknown, path: Path): Schema | undefined {
  let schema: Schema | undefined = root;
  let current = value;
  for (let i = 0; i <= path.length; i++) {
    if (schema === undefined) return undefined;
    schema = unwrap(schema);
    let def = defOf(schema);
    if (def.type === "union") {
      const disc =
        "discriminator" in def && typeof def.discriminator === "string"
          ? def.discriminator
          : undefined;
      const tag =
        disc && current && typeof current === "object"
          ? (current as Record<string, unknown>)[disc]
          : undefined;
      const picked = def.options.find((option) => {
        const optionDef = defOf(unwrap(option));
        if (!disc) return optionDef.type === "object";
        return optionDef.type === "object" && literalValues(optionDef.shape[disc]).includes(tag);
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

const HEIGHTLESS_TYPES = new Set(["text", "bar_list"]);

const optionalFix = (fix: Fix | undefined): { fix?: Fix } => (fix ? { fix } : {});

function pixels(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value) : null;
  return match ? Number(match[1]) : undefined;
}

const desktopChart = (preset: (typeof HEIGHT_PRESETS)[number]) =>
  tokens.blockHeight[preset].desktop.chart;

const PAGING_KEYS = new Set([
  "pagination",
  "paginate",
  "paginated",
  "page",
  "pages",
  "pagesize",
  "page_size",
  "perpage",
  "per_page",
  "offset",
]);

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
  document: SpecDocument,
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

function quoteFix(document: SpecDocument, pointer: string): { help?: string; fix?: Fix } {
  const node = document.locate(pointer);
  if (!node?.exact || (node.node.kind !== "number" && node.node.kind !== "boolean")) return {};
  const source = document.text.slice(node.node.start, node.node.end);
  const quoted = JSON.stringify(source);
  return {
    help: `YAML reads ${source} as a ${node.node.kind}; quote it to keep it a string: ${quoted}`,
    fix: {
      range: document.rangeAt(node.node.start, node.node.end),
      text: quoted,
      applicability: "safe",
      description: `quote ${source}`,
    },
  };
}

export interface IssueContext {
  root: z.ZodType;
  document: SpecDocument;
  defaults?: Readonly<Record<string, unknown>>;
}

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

    const px = key === "height" ? pixels(at.value) : undefined;
    if (px !== undefined && (issue.code === "invalid_value" || issue.code === "invalid_type")) {
      const nearest = HEIGHT_PRESETS.reduce((a, b) =>
        Math.abs(desktopChart(b) - px) < Math.abs(desktopChart(a) - px) ? b : a,
      );
      push("HM3004", path, "height takes a preset name, not pixels", {
        expected: [...HEIGHT_PRESETS],
        help: `use ${HEIGHT_PRESETS.map((h) => `${h} (${desktopChart(h)} px for a chart on desktop)`).join(", ")}; the theme sets each one for desktop and phone so axis labels, keys and tooltips stay legible`,
        ...optionalFix(
          replaceValueFix(
            document,
            toPointer(path),
            nearest,
            "unsafe",
            `set height: ${nearest}, the nearest preset`,
          ),
        ),
      });
      continue;
    }

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
          const paging =
            PAGING_KEYS.has(extraKey.toLowerCase()) &&
            (at.value as { type?: unknown } | undefined)?.type === "table";
          const blockType = (at.value as { type?: unknown } | undefined)?.type;
          if (extraKey === "height" && HEIGHTLESS_TYPES.has(String(blockType))) {
            push("HM3002", keyPath, `a ${String(blockType)} block takes no height`, {
              target: "key",
              expected: allowed,
              help: `a ${String(blockType)} block is as tall as its content; height applies to kpi, line, area, bar, pie, donut, scatter and table blocks`,
              ...optionalFix(
                removePropertyFix(document, toPointer(path), "height", "safe", 'remove "height"'),
              ),
            });
            continue;
          }
          push("HM3002", keyPath, `unknown property "${extraKey}"`, {
            target: "key",
            expected: allowed,
            ...(paging
              ? {
                  help: 'tables do not paginate: a dashboard is read at a glance, and rows on a later page are easy to miss. Show the top rows with "limit" and fold the rest into one row with other: true',
                }
              : match
                ? { help: `did you mean "${match}"?` }
                : {}),
            ...(!paging && match && keyRange
              ? {
                  fix: {
                    range: keyRange,
                    text: yamlText(match),
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
        push("HM3003", path, `expected ${issue.expected}, found ${describeType(at.value)}`, {
          ...(issue.expected === "string" ? quoteFix(document, toPointer(path)) : {}),
        });
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
        const typed = issue.errors.filter(
          (branch) => !branch.some((e) => e.path.length === 0 && e.code === "invalid_type"),
        );
        if (typed.length > 0) {
          const best = typed.reduce((a, b) => (b.length < a.length ? b : a));
          const nested = best.map((e) => ({ ...e, path: [...issue.path, ...e.path] }));
          out.push(...issuesToDiagnostics(nested as z.core.$ZodIssue[], ctx));
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
          types.includes("string") ? quoteFix(document, toPointer(path)) : {},
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
