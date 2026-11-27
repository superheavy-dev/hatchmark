import { parse, stringify } from "yaml";

export function toYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
}

export function fromYaml(text: string): ReturnType<typeof JSON.parse> {
  return parse(text, { version: "1.2", schema: "core", merge: false });
}
