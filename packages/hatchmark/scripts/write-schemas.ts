import { mkdirSync, writeFileSync } from "node:fs";
import type * as spec from "../src/spec/index.js";

const { jsonSchema, SCHEMA_FILES }: typeof spec = await import(
  new URL("../dist/spec/index.js", import.meta.url).href
);

const dir = new URL("../schema/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [kind, file] of Object.entries(SCHEMA_FILES)) {
  writeFileSync(
    new URL(file, dir),
    `${JSON.stringify(jsonSchema(kind as spec.SpecKind), null, 2)}\n`,
  );
}
