import { z } from "zod";
import { SPEC_SCHEMAS, type SpecKind } from "./project.js";

export const SCHEMA_FILES: Record<SpecKind, string> = {
  project: "project.schema.json",
  metric: "metric.schema.json",
  dashboard: "dashboard.schema.json",
};

/** JSON Schema (draft 2020-12) for each spec file, generated from the Zod schemas. */
export function jsonSchema(kind: SpecKind): Record<string, unknown> {
  return z.toJSONSchema(SPEC_SCHEMAS[kind], {
    io: "input",
    unrepresentable: "any",
    reused: "ref",
  }) as Record<string, unknown>;
}
