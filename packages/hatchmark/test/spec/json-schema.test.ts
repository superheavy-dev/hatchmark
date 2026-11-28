import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonSchema, SCHEMA_FILES, type SpecKind } from "../../src/spec/index.js";

const DEFINITIONS: Record<SpecKind, string[]> = {
  project: ["Source", "Weekday"],
  metric: [
    "AggregateMetric",
    "Duration",
    "Filter",
    "Format",
    "FormulaMetric",
    "MetricTest",
    "PerEntityMetric",
    "RatioMetric",
    "SqlMetric",
    "Target",
  ],
  segment: ["Filter"],
  dashboard: [
    "AreaBlock",
    "BarBlock",
    "BarListBlock",
    "DonutBlock",
    "PieBlock",
    "Block",
    "Comparison",
    "DashboardFilter",
    "Grain",
    "KpiBlock",
    "LineBlock",
    "Period",
    "PeriodRange",
    "Range",
    "ScatterBlock",
    "SeriesGroup",
    "Sort",
    "TableBlock",
    "TextBlock",
    "TimeGrain",
    "Weekday",
  ],
};

const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

function collectRefs(node: unknown, refs: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") refs.push(String(value));
    else if (NAME_MAPS.has(key) && value !== null && typeof value === "object") {
      for (const child of Object.values(value)) collectRefs(child, refs);
    } else collectRefs(value, refs);
  }
}

describe("committed JSON Schemas", () => {
  for (const kind of Object.keys(SCHEMA_FILES) as SpecKind[]) {
    it(`${SCHEMA_FILES[kind]} matches the Zod schema (run pnpm gen:schema)`, () => {
      const committed = readFileSync(
        new URL(`../../schema/${SCHEMA_FILES[kind]}`, import.meta.url),
        "utf8",
      );
      expect(committed).toBe(`${JSON.stringify(jsonSchema(kind), null, 2)}\n`);
    });
  }

  for (const kind of Object.keys(SCHEMA_FILES) as SpecKind[]) {
    it(`${SCHEMA_FILES[kind]} keeps its named definitions (name a schema with .meta({ id }))`, () => {
      const schema = jsonSchema(kind);
      const names = Object.keys((schema.$defs ?? {}) as Record<string, unknown>);
      for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
      expect(names.sort()).toEqual([...DEFINITIONS[kind]].sort());
      const refs: string[] = [];
      collectRefs(schema, refs);
      for (const ref of refs) {
        expect(ref).toMatch(/^#\/\$defs\/[^/]+$/);
        expect(names).toContain(ref.slice("#/$defs/".length));
      }
    });
  }

  it("closes every object so typos are rejected by editors too", () => {
    const text = JSON.stringify(jsonSchema("dashboard"));
    const objects = text.match(/"type":"object"/g)?.length ?? 0;
    const closed = text.match(/"additionalProperties":false/g)?.length ?? 0;
    expect(closed).toBe(objects);
  });
});
