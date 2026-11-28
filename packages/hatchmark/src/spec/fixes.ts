import { parse, stringify } from "yaml";
import type { Applicability, Fix, SpecDocument } from "../diagnostics/index.js";

/** A value as YAML flow text that reads back as the same value at any key, list item or flow position. */
export function yamlText(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof value === "string" && /[,[\]{}\r\n]/.test(value)) return json;
  const options = { version: "1.2", schema: "core" } as const;
  const text = stringify(value, {
    ...options,
    collectionStyle: "flow",
    flowCollectionPadding: false,
    lineWidth: 0,
  }).replace(/\n$/, "");
  if (/[\r\n]/.test(text)) return json;
  return JSON.stringify(parse(text, options)) === json ? text : json;
}

export function replaceValueFix(
  document: SpecDocument,
  pointer: string,
  value: unknown,
  applicability: Applicability,
  description: string,
): Fix | undefined {
  const found = document.locate(pointer);
  if (!found?.exact) return undefined;
  const before = document.text.slice(0, found.node.start);
  const tag = /![^\s,[\]{}]*[ \t]+$/.exec(before.slice(before.search(/[^\r\n]*$/)));
  const start = tag ? found.node.start - tag[0].length : found.node.start;
  return {
    range: document.rangeAt(start, found.node.end),
    text: yamlText(value),
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
  const property = `${yamlText(key)}: ${yamlText(value)}`;
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
  const firstLine =
    document.text
      .slice(0, first.keyStart)
      .split(/\r\n|\r|\n/)
      .at(-1) ?? "";
  const indent = firstLine.replace(/\?[ \t]+$/, "").length;
  const end = last.value.end;
  const lastValue = last.value;
  const kept =
    lastValue.kind === "string" &&
    (lastValue.style === "literal" || lastValue.style === "folded") &&
    /^[|>](?:[1-9]?\+|\+[1-9]?)/.test(document.text.slice(lastValue.start));
  if (kept) {
    const rest = /^[^\r\n]*(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*/.exec(document.text.slice(end));
    if (rest === null) {
      return {
        range: document.rangeAt(end, end),
        text: `\n${" ".repeat(indent)}${property}`,
        applicability: "unsafe",
        description: `${description}; review it first, because it adds a line break to the kept block scalar before it`,
      };
    }
    const at = end + rest[0].length;
    return {
      range: document.rangeAt(at, at),
      text: `${" ".repeat(indent)}${property}\n`,
      applicability,
      description,
    };
  }
  return {
    range: document.rangeAt(end, end),
    text: `\n${" ".repeat(indent)}${property}`,
    applicability,
    description,
  };
}

export function removePropertyFix(
  document: SpecDocument,
  objectPointer: string,
  key: string,
  applicability: Applicability,
  description: string,
): Fix | undefined {
  const found = document.locate(objectPointer);
  if (!found?.exact || found.node.kind !== "object") return undefined;
  const members = found.node.members;
  const at = members.findLastIndex((m) => m.key === key);
  const member = members[at];
  if (member === undefined) return undefined;
  const next = members[at + 1];
  const previous = members[at - 1];
  const [start, end] = next
    ? [member.keyStart, next.keyStart]
    : previous
      ? [previous.value.end, member.value.end]
      : [member.keyStart, member.value.end];
  return { range: document.rangeAt(start, end), text: "", applicability, description };
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
