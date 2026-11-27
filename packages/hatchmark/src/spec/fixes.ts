import type { Applicability, Fix, SpecDocument } from "../diagnostics/index.js";

export function replaceValueFix(
  document: SpecDocument,
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
  document: SpecDocument,
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
  if (object.flow) {
    if (last === undefined) {
      return {
        range: document.rangeAt(object.start + 1, object.start + 1),
        text: ` ${property} `,
        applicability,
        description,
      };
    }
    return {
      range: document.rangeAt(last.value.end, last.value.end),
      text: `, ${property}`,
      applicability,
      description,
    };
  }
  if (last === undefined) return undefined;
  const first = object.members[0] ?? last;
  const indent = document.positionAt(first.keyStart).column - 1;
  const end = last.value.end;
  return {
    range: document.rangeAt(end, end),
    text: `\n${" ".repeat(indent)}${property}`,
    applicability,
    description,
  };
}

export function removeItemFix(
  document: SpecDocument,
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
  if (found.node.flow) {
    const [start, end] = next
      ? [item.start, next.start]
      : previous
        ? [previous.end, item.end]
        : [item.start, item.end];
    return { range: document.rangeAt(start, end), text: "", applicability, description };
  }
  const dash = document.text.lastIndexOf("-", item.start - 1);
  if (items.length === 1) {
    return {
      range: document.rangeAt(dash, item.end),
      text: "[]",
      applicability,
      description,
    };
  }
  if (next) {
    const nextDash = document.text.lastIndexOf("-", next.start - 1);
    return { range: document.rangeAt(dash, nextDash), text: "", applicability, description };
  }
  const previousEnd = (previous ?? item).end;
  return {
    range: document.rangeAt(previousEnd, item.end),
    text: "",
    applicability,
    description,
  };
}
