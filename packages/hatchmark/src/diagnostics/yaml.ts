import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Node,
  Parser,
  parseAllDocuments,
  Scalar,
} from "yaml";
import type { Frame, Position, Range } from "./diagnostic.js";
import { parsePointer } from "./pointer.js";

interface NodeBase {
  /** UTF-16 offset of the first character of the value. */
  start: number;
  /** UTF-16 offset just past the last character of the value. */
  end: number;
}

export interface SpecMember {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: SpecNode;
}

export type ScalarStyle = "plain" | "single" | "double" | "literal" | "folded";

export type SpecNode =
  | (NodeBase & { kind: "object"; flow: boolean; members: SpecMember[] })
  | (NodeBase & { kind: "array"; flow: boolean; items: SpecNode[] })
  | (NodeBase & { kind: "string"; value: string; style: ScalarStyle })
  | (NodeBase & { kind: "number"; value: number })
  | (NodeBase & { kind: "boolean"; value: boolean })
  | (NodeBase & { kind: "null"; value: null });

export type SpecSyntaxErrorKind = "syntax" | "duplicate-key" | "unsupported";

export interface SpecSyntaxError {
  kind: SpecSyntaxErrorKind;
  message: string;
  start: number;
  end: number;
  /** Offset of the first occurrence, for duplicate keys. */
  related?: number;
  help?: string;
  /** A safe replacement for the text from start to end. */
  fix?: { text: string; description: string };
}

const FRAME_BEFORE = 80;
const FRAME_AFTER = 160;

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

const CORE_TAGS = new Set(
  ["str", "int", "float", "bool", "null", "map", "seq"].map((t) => `tag:yaml.org,2002:${t}`),
);

const STYLES: Readonly<Record<string, ScalarStyle>> = {
  PLAIN: "plain",
  QUOTE_SINGLE: "single",
  QUOTE_DOUBLE: "double",
  BLOCK_LITERAL: "literal",
  BLOCK_FOLDED: "folded",
};

const HELP: Readonly<Record<string, string>> = {
  TAB_AS_INDENT: "indent with spaces; YAML does not allow tabs in indentation",
  BLOCK_AS_IMPLICIT_KEY:
    'a value that contains ": " needs quotes, such as "Revenue: last quarter"; a nested mapping goes on its own indented lines',
  MULTILINE_IMPLICIT_KEY:
    'a key fits on one line and ends with ": "; quote a value that contains ": "',
  BAD_INDENT: "items of one mapping or list start at the same column",
  BAD_SCALAR_START: "a plain value cannot start with this character; put the value in quotes",
};

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]?.toLowerCase() + text.slice(1) : text;
}

type Built = { node: SpecNode; value: unknown };

type PropToken = { type: "anchor" | "tag"; offset: number; source: string };

function propTokens(text: string): PropToken[] {
  const found: PropToken[] = [];
  const walk = (token: unknown): void => {
    if (Array.isArray(token)) {
      for (const t of token) walk(t);
      return;
    }
    if (token === null || typeof token !== "object") return;
    const t = token as Record<string, unknown>;
    if (
      (t.type === "anchor" || t.type === "tag") &&
      typeof t.offset === "number" &&
      typeof t.source === "string"
    )
      found.push({ type: t.type, offset: t.offset, source: t.source });
    for (const value of Object.values(t)) if (typeof value === "object") walk(value);
  };
  for (const token of new Parser().parse(text)) walk(token);
  return found.sort((a, b) => a.offset - b.offset);
}

class Builder {
  readonly errors: SpecSyntaxError[] = [];
  private readonly props: PropToken[];

  constructor(private readonly text: string) {
    this.props = propTokens(text);
  }

  private propBefore(type: PropToken["type"], at: number, source?: string): PropToken | undefined {
    return this.props.findLast(
      (p) => p.type === type && p.offset <= at && (source === undefined || p.source === source),
    );
  }

  parse(): Built | undefined {
    const docs = parseAllDocuments(this.text, {
      version: "1.2",
      schema: "core",
      strict: true,
      uniqueKeys: false,
      merge: false,
      prettyErrors: false,
      intAsBigInt: false,
    });
    const list = Array.isArray(docs) ? docs : [];
    const syntax = list
      .flatMap((doc) => [
        ...doc.errors,
        ...doc.warnings.filter((w) => w.code !== "TAG_RESOLVE_FAILED"),
      ])
      .sort((a, b) => a.pos[0] - b.pos[0]);
    for (const warning of list.flatMap((doc) => doc.warnings)) {
      if (warning.code !== "TAG_RESOLVE_FAILED") continue;
      if (![...CORE_TAGS].some((tag) => warning.message.endsWith(tag))) continue;
      const [start, end] = warning.pos;
      const tag = this.text.slice(start, end);
      this.unsupported(
        `the tag ${tag} does not fit this value`,
        start,
        end,
        "remove the tag; quote the value if it must stay a string",
      );
    }
    const first = syntax[0];
    if (first !== undefined) {
      const help = HELP[first.code];
      this.errors.push({
        kind: "syntax",
        message: lowerFirst(first.message.split("\n")[0] ?? first.message),
        start: first.pos[0],
        end: first.pos[1],
        ...(help ? { help } : {}),
      });
    }
    const second = list[1];
    if (second !== undefined) {
      const start = second.range[0];
      this.errors.push({
        kind: "unsupported",
        message: "a spec file holds one YAML document, but this file has another after ---",
        start,
        end: Math.min(this.text.length, start + 3),
        help: "remove the second document, or move it to a file of its own",
      });
    }
    const doc = list[0];
    const directive = doc?.directives?.yaml;
    if (directive?.explicit && directive.version !== "1.2") {
      const start = Math.max(0, this.text.search(/^%YAML/m));
      const lineEnd = this.text.slice(start).search(/\r\n|\r|\n|$/);
      this.unsupported(
        `spec files are YAML 1.2, but this file declares %YAML ${directive.version}`,
        start,
        start + lineEnd,
        "remove the %YAML line",
      );
    }
    if (doc === undefined || doc.contents === null) {
      const end = this.text.length;
      if (first === undefined) {
        this.errors.push({
          kind: "syntax",
          message: "the file is empty",
          start: end,
          end,
          help: "a spec file holds one YAML mapping, such as title: Sales",
        });
      }
      return undefined;
    }
    return this.build(doc.contents, doc.range[0]);
  }

  private unsupported(
    message: string,
    start: number,
    end: number,
    help?: string,
    fix?: SpecSyntaxError["fix"],
  ): void {
    this.errors.push({
      kind: "unsupported",
      message,
      start,
      end,
      ...(help ? { help } : {}),
      ...(fix ? { fix } : {}),
    });
  }

  private checkNode(node: Node): void {
    if (node.anchor) {
      const at = node.range?.[0] ?? 0;
      const start = this.propBefore("anchor", at, `&${node.anchor}`)?.offset ?? at;
      this.unsupported(
        `anchors (&${node.anchor}) are not allowed in spec files`,
        start,
        start + node.anchor.length + 1,
        "write the value out in full where it is used",
      );
    }
    if (node.tag && !CORE_TAGS.has(node.tag)) {
      const at = node.range?.[0] ?? 0;
      const token = this.propBefore("tag", at);
      const start = token?.offset ?? at;
      this.unsupported(
        `the tag ${node.tag} is not allowed in spec files`,
        start,
        token ? start + token.source.length : (node.range?.[1] ?? start),
        "remove the tag; quote the value if it must stay a string",
      );
    }
  }

  private checkSql(node: SpecNode): void {
    if (node.kind !== "string" || node.style === "literal") return;
    if (node.style !== "folded" && !/[\r\n]/.test(this.text.slice(node.start, node.end))) return;
    this.unsupported(
      "SQL here is folded: YAML joins its lines with spaces, so a -- comment would hide the lines after it",
      node.start,
      node.style === "folded" ? node.start + 1 : node.end,
      "write the SQL as a literal block: sql: | with the query on the indented lines below",
    );
  }

  private build(node: Node | null, at: number): Built {
    if (node === null || node === undefined) {
      return { node: { kind: "null", value: null, start: at, end: at }, value: null };
    }
    const [start, end] = node.range ?? [at, at];
    if (isAlias(node)) {
      this.unsupported(
        `aliases (*${node.source}) are not allowed in spec files`,
        start,
        end,
        "write the value out in full instead of referring to an anchor",
      );
      return { node: { kind: "null", value: null, start, end }, value: null };
    }
    this.checkNode(node);
    if (isMap(node)) {
      const members: SpecMember[] = [];
      const value: Record<string, unknown> = {};
      const firstSeen = new Map<string, number>();
      for (const pair of node.items) {
        const key = pair.key as Node | null;
        if (!isScalar(key) || key.range === undefined || key.range === null) {
          const keyStart = (key as Node | null)?.range?.[0] ?? start;
          this.unsupported(
            "complex mapping keys are not allowed in spec files",
            keyStart,
            (key as Node | null)?.range?.[1] ?? keyStart,
            "use a plain name as the key",
          );
          continue;
        }
        const [keyStart, keyEnd] = key.range;
        this.checkNode(key);
        if (typeof key.value !== "string") {
          const source = this.text.slice(keyStart, keyEnd);
          this.unsupported(
            `the key ${source} is read as ${key.value === null ? "null" : typeof key.value}, not a name`,
            keyStart,
            keyEnd,
            `quote it: ${JSON.stringify(source)}`,
          );
          continue;
        }
        const name = key.value;
        if (name === "<<" && key.type === Scalar.PLAIN) {
          this.unsupported(
            "merge keys (<<) are not allowed in spec files",
            keyStart,
            keyEnd,
            "write the properties out in full",
          );
          continue;
        }
        const previous = firstSeen.get(name);
        if (previous === undefined) firstSeen.set(name, keyStart);
        else {
          this.errors.push({
            kind: "duplicate-key",
            message: `duplicate key ${JSON.stringify(name)}`,
            start: keyStart,
            end: keyEnd,
            related: previous,
          });
        }
        const built = this.build(pair.value as Node | null, keyEnd);
        if (name === "sql") this.checkSql(built.node);
        members.push({ key: name, keyStart, keyEnd, value: built.node });
        Object.defineProperty(value, name, {
          value: built.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const flow = node.flow === true;
      const last = members.at(-1)?.value.end;
      return {
        node: {
          kind: "object",
          flow,
          members,
          start,
          end: flow || last === undefined ? end : last,
        },
        value,
      };
    }
    if (isSeq(node)) {
      const items: SpecNode[] = [];
      const value: unknown[] = [];
      for (const item of node.items) {
        const built = this.build(item as Node | null, end);
        items.push(built.node);
        value.push(built.value);
      }
      const flow = node.flow === true;
      const last = items.at(-1)?.end;
      return {
        node: { kind: "array", flow, items, start, end: flow || last === undefined ? end : last },
        value,
      };
    }
    if (isScalar(node)) {
      const v = node.value;
      if (typeof v === "string") {
        const style = STYLES[node.type ?? "PLAIN"] ?? "plain";
        const block = style === "literal" || style === "folded";
        const contentEnd = block ? start + this.text.slice(start, end).trimEnd().length : end;
        return { node: { kind: "string", value: v, style, start, end: contentEnd }, value: v };
      }
      if (typeof v === "number") {
        const source = this.text.slice(start, end);
        if (node.type === Scalar.PLAIN && !JSON_NUMBER.test(source)) {
          const quoted = JSON.stringify(source);
          this.unsupported(
            `YAML reads ${source} as the number ${v}, but spec files write numbers as JSON does`,
            start,
            end,
            `quote it to keep it a string: ${quoted}${Number.isFinite(v) ? `, or write the number as ${v}` : ""}`,
            { text: quoted, description: `quote ${source}` },
          );
        }
        return { node: { kind: "number", value: v, start, end }, value: v };
      }
      if (typeof v === "boolean")
        return { node: { kind: "boolean", value: v, start, end }, value: v };
      if (v === null) return { node: { kind: "null", value: null, start, end }, value: null };
      const text = String(v);
      return { node: { kind: "string", value: text, style: "plain", start, end }, value: text };
    }
    return { node: { kind: "null", value: null, start, end }, value: null };
  }
}

/** A parsed YAML spec file that can map offsets and JSON Pointers back to line and column. */
export class SpecDocument {
  readonly root: SpecNode | undefined;
  /** The parsed value as plain data (YAML 1.2 core schema); undefined when the file did not parse. */
  readonly value: unknown;
  readonly errors: readonly SpecSyntaxError[];
  private readonly lineStarts: number[] = [0];
  private readonly astral: number[] = [];

  constructor(
    readonly file: string,
    readonly text: string,
  ) {
    const builder = new Builder(text);
    const built = builder.parse();
    this.root = built?.node;
    this.value = built?.value;
    this.errors = builder.errors;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 10) this.lineStarts.push(i + 1);
      else if (code === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.lineStarts.push(i + 1);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) this.astral.push(i);
      }
    }
  }

  /** 1-based line and column; columns count Unicode code points, so emoji count once. O(log n). */
  positionAt(offset: number): Position {
    const line = upperBound(this.lineStarts, offset) - 1;
    const lineStart = this.lineStarts[line] ?? 0;
    const pairs = lowerBound(this.astral, offset) - lowerBound(this.astral, lineStart);
    return { line: line + 1, column: offset - lineStart - pairs + 1 };
  }

  private snap(offset: number): number {
    const low = this.text.charCodeAt(offset);
    const high = this.text.charCodeAt(offset - 1);
    return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? offset - 1 : offset;
  }

  private clamp(start: number, end: number): [number, number] {
    const length = this.text.length;
    const s = this.snap(Math.min(Math.max(Math.trunc(start) || 0, 0), length));
    let e = Math.min(Math.max(Math.trunc(end) || 0, s), length);
    if (e > s && e < length && this.snap(e) !== e) e++;
    return [s, e];
  }

  /** A range for a fix: clamped to the text, and empty when the fix inserts. */
  rangeAt(start: number, end: number): Range {
    const [s, e] = this.clamp(start, end);
    return { start: this.positionAt(s), end: this.positionAt(e) };
  }

  /**
   * The range and frame for a diagnostic: clamped to the text and never empty, except in an empty
   * text, where it is the zero-width span at end of input. An empty span widens to the code point
   * it points at, or the last one at end of file.
   */
  location(start: number, end: number): { range: Range; frame: Frame } {
    const length = this.text.length;
    let [s, e] = this.clamp(start, end);
    if (e === s && length > 0) {
      if (s < length) e = this.clamp(s, s + 1)[1];
      else s = this.snap(length - 1);
    }
    const range = { start: this.positionAt(s), end: this.positionAt(e) };
    return { range, frame: this.frameAt(s, range.start) };
  }

  /** Like rangeOf, with the frame captured from this text. */
  locationOf(
    pointer: string,
    target: "value" | "key" = "value",
  ): { range: Range; frame: Frame } | undefined {
    const found = this.locate(pointer);
    if (found === undefined) return undefined;
    const { node, member } = found;
    if (!found.exact) {
      return member
        ? this.location(member.keyStart, member.keyEnd)
        : this.location(node.start, node.start + 1);
    }
    if (target === "key" && member) return this.location(member.keyStart, member.keyEnd);
    return this.location(node.start, node.end);
  }

  private frameAt(offset: number, position: Position): Frame {
    const lineStart = this.lineStarts[position.line - 1] ?? 0;
    const lineEnd = this.lineEnd(position.line);
    const from = this.snap(Math.min(lineEnd, Math.max(lineStart, offset - FRAME_BEFORE)));
    const to = Math.min(lineEnd, this.snap(offset + FRAME_AFTER));
    return {
      text: this.text.slice(from, to),
      column: from === lineStart ? 1 : this.positionAt(from).column,
      more: to < lineEnd,
    };
  }

  /** The source text of one line, without its line break. */
  lineText(line: number): string {
    const start = this.lineStarts[line - 1];
    if (start === undefined) return "";
    return this.text.slice(start, this.lineEnd(line));
  }

  private lineEnd(line: number): number {
    const next = this.lineStarts[line];
    if (next === undefined) return this.text.length;
    return this.text.charCodeAt(next - 1) === 10 && this.text.charCodeAt(next - 2) === 13
      ? next - 2
      : next - 1;
  }

  /** Maps an index in a string node's decoded value to its offset in the source text. */
  stringOffset(
    node: Extract<SpecNode, { kind: "string" }>,
    index: number,
    side: "start" | "end" = "start",
  ): number {
    const text = this.text;
    const raw = text.slice(node.start, node.end);
    if (node.style === "plain" && !/[\r\n]/.test(raw))
      return Math.min(node.start + index, node.end);
    if (node.style === "literal" && !/^\|[+-]?[1-9]/.test(raw)) {
      const header = text.slice(node.start).search(/\r\n|\r|\n/);
      let pos = header === -1 ? node.end : node.start + header;
      pos += text.startsWith("\r\n", pos) ? 2 : 1;
      const indent = /^( *)[^ \r\n]/m.exec(text.slice(pos, node.end))?.[1]?.length ?? 0;
      let decoded = 0;
      while (pos < node.end) {
        let skip = 0;
        while (skip < indent && text[pos + skip] === " ") skip++;
        pos += skip;
        while (pos < node.end && text[pos] !== "\n" && text[pos] !== "\r") {
          if (decoded === index) return pos;
          pos++;
          decoded++;
        }
        if (decoded === index) return Math.min(pos, node.end);
        pos += text.startsWith("\r\n", pos) ? 2 : 1;
        decoded++;
      }
      return node.end;
    }
    const blank = (ch: string | undefined) =>
      ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
    let pos = node.start;
    if (node.style === "single" || node.style === "double") pos++;
    else if (node.style === "folded" || node.style === "literal") {
      const header = text.slice(node.start).search(/\r\n|\r|\n/);
      pos = header === -1 ? node.end : node.start + header + 1;
    }
    let decoded = 0;
    if (node.style === "folded" || node.style === "literal") {
      let run = pos;
      while (run < node.end && blank(text[run])) run++;
      while (blank(node.value[decoded])) decoded++;
      let kept = 0;
      while (kept < decoded && node.value[decoded - 1 - kept] === " ") kept++;
      pos = run - kept;
      decoded -= kept;
    }
    const continuation = (at: number): number | undefined => {
      if (node.style !== "double" || text[at] !== "\\") return undefined;
      const esc = text[at + 1];
      if (esc !== "\n" && esc !== "\r") return undefined;
      let next = at + (text.startsWith("\r\n", at + 1) ? 3 : 2);
      while (text[next] === " " || text[next] === "\t") next++;
      return next;
    };
    while (decoded < index && pos < node.end) {
      const next = continuation(pos);
      if (next !== undefined) {
        pos = next;
        continue;
      }
      if (node.style === "double" && text[pos] === "\\") {
        const esc = text[pos + 1];
        const length = esc === "x" ? 4 : esc === "u" ? 6 : esc === "U" ? 10 : 2;
        decoded +=
          esc === "U" && Number.parseInt(text.slice(pos + 2, pos + 10), 16) > 0xffff ? 2 : 1;
        pos += length;
        continue;
      }
      if (node.style === "single" && text.startsWith("''", pos)) {
        pos += 2;
        decoded++;
        continue;
      }
      if (blank(text[pos])) {
        let run = pos;
        while (run < node.end && blank(text[run])) run++;
        if (!/[\r\n]/.test(text.slice(pos, run))) {
          pos++;
          decoded++;
          continue;
        }
        if (node.style === "double") {
          const breaks = text.slice(pos, run).match(/\r\n|\r|\n/g)?.length ?? 0;
          decoded += breaks === 1 ? 1 : breaks - 1;
        } else while (decoded < index && blank(node.value[decoded])) decoded++;
        pos = run;
        continue;
      }
      pos++;
      decoded++;
    }
    for (let next = continuation(pos); side === "start" && next !== undefined; ) {
      pos = next;
      next = continuation(pos);
    }
    return Math.min(pos, node.end);
  }

  /**
   * Finds the node at a JSON Pointer. When the pointer names something that does not exist (a
   * missing required property), returns the deepest existing ancestor with exact set to false.
   */
  locate(pointer: string): { node: SpecNode; member?: SpecMember; exact: boolean } | undefined {
    if (this.root === undefined) return undefined;
    let node: SpecNode = this.root;
    let member: SpecMember | undefined;
    for (const token of parsePointer(pointer)) {
      let child: SpecNode | undefined;
      let childMember: SpecMember | undefined;
      if (node.kind === "object") {
        childMember = node.members.findLast((m) => m.key === token);
        child = childMember?.value;
      } else if (node.kind === "array" && /^(0|[1-9][0-9]*)$/.test(token)) {
        child = node.items[Number(token)];
      }
      if (child === undefined) return { node, ...(member ? { member } : {}), exact: false };
      node = child;
      member = childMember;
    }
    return { node, ...(member ? { member } : {}), exact: true };
  }

  /**
   * The source range for a JSON Pointer: the value's range, or the key's with target "key".
   * A pointer that does not exist resolves to the key (or opening character) of its deepest
   * existing ancestor.
   */
  rangeOf(pointer: string, target: "value" | "key" = "value"): Range | undefined {
    return this.locationOf(pointer, target)?.range;
  }
}

function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
