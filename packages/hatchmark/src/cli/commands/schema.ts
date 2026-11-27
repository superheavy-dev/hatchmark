import { jsonSchema, SCHEMA_FILES, type SpecKind } from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";

export const schemaHelp: CommandHelp = {
  name: "schema",
  summary: "Print the JSON Schema for hatchmark.yaml, metric files or dashboard files.",
  usage: "hatchmark schema [project|metric|dashboard]",
  options: [
    { flag: "[kind]", description: "Which schema. Without it, prints all three keyed by kind." },
  ],
  example: {
    command: "hatchmark schema dashboard",
    description: "The same schema ships at node_modules/hatchmark/schema/dashboard.schema.json.",
  },
};

const KINDS = Object.keys(SCHEMA_FILES) as SpecKind[];

export function schema(_ctx: CommandContext, positionals: string[]): CommandResult {
  const [kind, ...rest] = positionals;
  if (rest.length > 0)
    return usageError("HM0002", `unexpected argument "${rest[0]}"`, {
      help: "pass at most one kind",
    });
  if (kind !== undefined && !(KINDS as string[]).includes(kind)) {
    return usageError("HM0002", `unknown schema kind "${kind}"`, { expected: KINDS, input: kind });
  }
  const value =
    kind === undefined
      ? Object.fromEntries(KINDS.map((k) => [k, jsonSchema(k)]))
      : jsonSchema(kind as SpecKind);
  return { exitCode: EXIT.ok, json: value, human: JSON.stringify(value, null, 2) };
}
