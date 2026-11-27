import type { Applicability, Fix, JsonDocument } from "../diagnostics/index.js";

export function replaceValueFix(
  document: JsonDocument,
  pointer: string,
  value: unknown,
  applicability: Applicability,
  description: string,
): Fix | undefined {
  const found = document.locate(pointer);
  if (!found?.exact) return undefined;
  return {
    range: document.rangeAt(found.node.start, found.node.end),
    text: JSON.stringify(value),
    applicability,
    description,
  };
}

export function addPropertyFix(
  document: JsonDocument,
  objectPointer: string,
  key: string,
  value: unknown,
  applicability: Applicability,
  description: string,
): Fix | undefined {
  const found = document.locate(objectPointer);
  if (!found?.exact || found.node.kind !== "object") return undefined;
  const object = found.node;
  const property = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const last = object.members.at(-1);
  if (last === undefined) {
    return {
      range: document.rangeAt(object.start + 1, object.start + 1),
      text: ` ${property} `,
      applicability,
      description,
    };
  }
  const first = object.members[0] ?? last;
  const firstLine = document.positionAt(first.keyStart).line;
  const objectLine = document.positionAt(object.start).line;
  const separator =
    firstLine === objectLine
      ? ", "
      : `,\n${document.lineText(firstLine).slice(0, document.lineText(firstLine).search(/\S|$/))}`;
  return {
    range: document.rangeAt(last.value.end, last.value.end),
    text: `${separator}${property}`,
    applicability,
    description,
  };
}

export function removeItemFix(
  document: JsonDocument,
  arrayPointer: string,
  index: number,
  applicability: Applicability,
  description: string,
): Fix | undefined {
  const found = document.locate(arrayPointer);
  if (!found?.exact || found.node.kind !== "array") return undefined;
  const items = found.node.items;
  const item = items[index];
  if (item === undefined) return undefined;
  const next = items[index + 1];
  const previous = items[index - 1];
  const [start, end] = next
    ? [item.start, next.start]
    : previous
      ? [previous.end, item.end]
      : [item.start, item.end];
  return { range: document.rangeAt(start, end), text: "", applicability, description };
}
