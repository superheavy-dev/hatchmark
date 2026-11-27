import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonSchema, SCHEMA_FILES, type SpecKind } from "../../src/spec/index.js";

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

  it("closes every object so typos are rejected by editors too", () => {
    const text = JSON.stringify(jsonSchema("dashboard"));
    const objects = text.match(/"type":"object"/g)?.length ?? 0;
    const closed = text.match(/"additionalProperties":false/g)?.length ?? 0;
    expect(closed).toBe(objects);
  });
});
