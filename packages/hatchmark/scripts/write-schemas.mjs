import { mkdirSync, writeFileSync } from "node:fs";
import { jsonSchema, SCHEMA_FILES } from "../dist/spec/index.js";

const dir = new URL("../schema/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [kind, file] of Object.entries(SCHEMA_FILES)) {
  writeFileSync(new URL(file, dir), `${JSON.stringify(jsonSchema(kind), null, 2)}\n`);
}
