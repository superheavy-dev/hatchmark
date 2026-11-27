import type { Frame, Position, Range } from "./diagnostic.js";
import { parsePointer } from "./pointer.js";

interface NodeBase {
  /** UTF-16 offset of the first character of the value. */
  start: number;
  /** UTF-16 offset just past the last character of the value. */
  end: number;
}

export interface JsonMember {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: JsonNode;
}

export type JsonNode =
  | (NodeBase & { kind: "object"; members: JsonMember[] })
  | (NodeBase & { kind: "array"; items: JsonNode[] })
  | (NodeBase & { kind: "string"; value: string })
  | (NodeBase & { kind: "number"; value: number })
  | (NodeBase & { kind: "boolean"; value: boolean })
  | (NodeBase & { kind: "null"; value: null });

export type JsonSyntaxErrorKind = "syntax" | "duplicate-key";

export interface JsonSyntaxError {
  kind: JsonSyntaxErrorKind;
  message: string;
  start: number;
  end: number;
  /** Offset of the first occurrence, for duplicate keys. */
  related?: number;
  /** A text edit that repairs the error without changing any other token. */
  repair?: { start: number; end: number; text: string };
}

const FRAME_BEFORE = 80;
const FRAME_AFTER = 160;

class StopParsing extends Error {}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const NUMBER_TAIL = /[0-9A-Za-z.+-]*/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON forbids raw control characters in strings
const STRING_RUN = /[^"\\\u0000-\u001f]*/y;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

type Built = { node: JsonNode; value: unknown };

type Container =
  | {
      kind: "object";
      start: number;
      members: JsonMember[];
      value: Record<string, unknown>;
      firstSeen: Map<string, number>;
      key: string;
      keyStart: number;
      keyEnd: number;
    }
  | { kind: "array"; start: number; items: JsonNode[]; value: unknown[] };

class Parser {
  private pos = 0;
  private lastComma = -1;
  readonly errors: JsonSyntaxError[] = [];

  constructor(private readonly text: string) {}

  parseDocument(): Built | undefined {
    try {
      if (this.text.charCodeAt(0) === 0xfeff) {
        this.fail("a byte order mark is not allowed at the start of a JSON file", 0, 1, {
          start: 0,
          end: 1,
          text: "",
        });
      }
      const root = this.parseRoot();
      this.skipWhitespace();
      if (this.pos < this.text.length) {
        this.fail("unexpected content after the end of the JSON value", this.pos, this.text.length);
      }
      return root;
    } catch (error) {
      if (error instanceof StopParsing) return undefined;
      throw error;
    }
  }

  private fail(
    message: string,
    start = this.pos,
    end = Math.min(start + 1, this.text.length),
    repair?: JsonSyntaxError["repair"],
  ): never {
    const length = this.text.length;
    const clamp = (offset: number): number => Math.min(Math.max(offset, 0), length);
    const s = clamp(start);
    this.errors.push({
      kind: "syntax",
      message,
      start: s,
      end: Math.max(s, clamp(end)),
      ...(repair
        ? {
            repair: {
              start: clamp(repair.start),
              end: Math.max(clamp(repair.start), clamp(repair.end)),
              text: repair.text,
            },
          }
        : {}),
    });
    throw new StopParsing();
  }

  private describeHere(): string {
    if (this.pos >= this.text.length) return "end of file";
    const ch = this.text[this.pos];
    return ch === "\n" || ch === "\r" ? "a line break" : JSON.stringify(ch);
  }

  private skipWhitespace(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.pos++;
        continue;
      }
      if (ch === "/" && (this.text[this.pos + 1] === "/" || this.text[this.pos + 1] === "*")) {
        this.failComment();
      }
      return;
    }
  }

  private failComment(): never {
    const start = this.pos;
    if (this.text[start + 1] === "/") {
      let end = start + 2;
      while (end < this.text.length && this.text[end] !== "\n" && this.text[end] !== "\r") end++;
      return this.fail("comments are not allowed in JSON", start, end, { start, end, text: "" });
    }
    const close = this.text.indexOf("*/", start + 2);
    if (close === -1)
      return this.fail(
        "unterminated comment (and comments are not allowed in JSON)",
        start,
        this.text.length,
      );
    const end = close + 2;
    return this.fail("comments are not allowed in JSON", start, end, { start, end, text: " " });
  }

  private parseRoot(): Built {
    const stack: Container[] = [];
    for (;;) {
      this.skipWhitespace();
      let built: Built | undefined = this.openOrScalar(stack);
      if (built === undefined) continue;
      for (;;) {
        const top = stack.at(-1);
        if (top === undefined) return built;
        if (top.kind === "object") {
          top.members.push({
            key: top.key,
            keyStart: top.keyStart,
            keyEnd: top.keyEnd,
            value: built.node,
          });
          Object.defineProperty(top.value, top.key, {
            value: built.value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else {
          top.items.push(built.node);
          top.value.push(built.value);
        }
        this.skipWhitespace();
        const next = this.text[this.pos];
        const close = top.kind === "object" ? "}" : "]";
        if (next === ",") {
          this.lastComma = this.pos;
          this.pos++;
          this.skipWhitespace();
          if (this.text[this.pos] === close) this.failTrailingComma();
          if (top.kind === "object") this.readKey(top);
          break;
        }
        if (next === close) {
          this.pos++;
          stack.pop();
          built = this.close(top);
          continue;
        }
        if (top.kind === "object" && next === '"') {
          this.fail('expected "," between properties', this.pos, this.pos + 1, {
            start: built.node.end,
            end: built.node.end,
            text: ",",
          });
        }
        this.fail(
          top.kind === "object"
            ? `expected "," or "}" after property value, found ${this.describeHere()}`
            : `expected "," or "]" after array item, found ${this.describeHere()}`,
        );
      }
    }
  }

  private close(frame: Container): Built {
    const end = this.pos;
    return frame.kind === "object"
      ? {
          node: { kind: "object", members: frame.members, start: frame.start, end },
          value: frame.value,
        }
      : {
          node: { kind: "array", items: frame.items, start: frame.start, end },
          value: frame.value,
        };
  }

  private openOrScalar(stack: Container[]): Built | undefined {
    const start = this.pos;
    const ch = this.text[start];
    if (ch === "{") {
      this.pos++;
      const frame: Container = {
        kind: "object",
        start,
        members: [],
        value: {},
        firstSeen: new Map(),
        key: "",
        keyStart: 0,
        keyEnd: 0,
      };
      this.skipWhitespace();
      if (this.text[this.pos] === "}") {
        this.pos++;
        return this.close(frame);
      }
      this.readKey(frame);
      stack.push(frame);
      return undefined;
    }
    if (ch === "[") {
      this.pos++;
      const frame: Container = { kind: "array", start, items: [], value: [] };
      this.skipWhitespace();
      if (this.text[this.pos] === "]") {
        this.pos++;
        return this.close(frame);
      }
      stack.push(frame);
      return undefined;
    }
    if (ch === '"') {
      const value = this.parseString();
      return { node: { kind: "string", value, start, end: this.pos }, value };
    }
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return this.parseNumber();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.text.startsWith(word, start)) {
        this.pos += word.length;
        const end = this.pos;
        const node: JsonNode =
          value === null
            ? { kind: "null", value, start, end }
            : { kind: "boolean", value, start, end };
        return { node, value };
      }
    }
    if (ch === "'") this.fail("strings must use double quotes");
    WORD.lastIndex = start;
    const word = WORD.exec(this.text)?.[0];
    if (word !== undefined) {
      this.fail(
        `unexpected word ${JSON.stringify(word)}: strings must be in double quotes`,
        start,
        start + word.length,
      );
    }
    return this.fail(`expected a JSON value, found ${this.describeHere()}`);
  }

  private readKey(frame: Extract<Container, { kind: "object" }>): void {
    this.skipWhitespace();
    if (this.text[this.pos] !== '"') {
      const ch = this.text[this.pos];
      if (ch !== undefined && /[A-Za-z_]/.test(ch))
        this.fail("object keys must be strings in double quotes");
      this.fail(`expected a property name in double quotes, found ${this.describeHere()}`);
    }
    const keyStart = this.pos;
    const key = this.parseString();
    const keyEnd = this.pos;
    const first = frame.firstSeen.get(key);
    if (first === undefined) {
      frame.firstSeen.set(key, keyStart);
    } else {
      this.errors.push({
        kind: "duplicate-key",
        message: `duplicate key ${JSON.stringify(key)}`,
        start: keyStart,
        end: keyEnd,
        related: first,
      });
    }
    this.skipWhitespace();
    if (this.text[this.pos] !== ":")
      this.fail(`expected ":" after property name, found ${this.describeHere()}`);
    this.pos++;
    frame.key = key;
    frame.keyStart = keyStart;
    frame.keyEnd = keyEnd;
  }

  private failTrailingComma(): never {
    const comma = this.lastComma;
    return this.fail("trailing commas are not allowed in JSON", comma, comma + 1, {
      start: comma,
      end: comma + 1,
      text: "",
    });
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++;
    const parts: string[] = [];
    for (;;) {
      STRING_RUN.lastIndex = this.pos;
      const run = STRING_RUN.exec(this.text)?.[0] ?? "";
      parts.push(run);
      this.pos += run.length;
      const ch = this.text[this.pos];
      if (ch === '"') {
        this.pos++;
        return parts.join("");
      }
      if (ch === undefined || ch === "\n" || ch === "\r")
        this.fail("unterminated string", start, this.pos);
      if (ch === "\\") {
        const esc = this.text[this.pos + 1];
        const simple = esc === undefined ? undefined : ESCAPES[esc];
        if (simple !== undefined) {
          parts.push(simple);
          this.pos += 2;
          continue;
        }
        if (esc === "u") {
          const hex = this.text.slice(this.pos + 2, this.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail("invalid \\u escape: expected four hex digits", this.pos, this.pos + 2);
          }
          parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
          this.pos += 6;
          continue;
        }
        this.fail("invalid escape sequence in string", this.pos, this.pos + 2);
      }
      this.fail("control characters must be escaped in strings");
    }
  }

  private parseNumber(): Built {
    const start = this.pos;
    NUMBER.lastIndex = start;
    const match = NUMBER.exec(this.text)?.[0];
    if (match === undefined) this.fail("invalid number", start);
    this.pos += match.length;
    const next = this.text[this.pos];
    if (next !== undefined && /[0-9.eExX]/.test(next)) {
      NUMBER_TAIL.lastIndex = this.pos;
      const tail = NUMBER_TAIL.exec(this.text)?.[0] ?? "";
      this.fail("invalid number", start, this.pos + tail.length);
    }
    const value = Number(match);
    return { node: { kind: "number", value, start, end: this.pos }, value };
  }
}

// RFC 8259 allows only \n, \r\n and \r as line breaks; U+2028 and U+2029 are ordinary
// characters.
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** A parsed JSON file that can map offsets and JSON Pointers back to line and column. */
export class JsonDocument {
  readonly root: JsonNode | undefined;
  /** The parsed value, identical to JSON.parse; undefined when the file did not parse. */
  readonly value: unknown;
  readonly errors: readonly JsonSyntaxError[];
  private readonly lineStarts: number[] = [0];
  private readonly astral: number[] = [];

  constructor(
    readonly file: string,
    readonly text: string,
  ) {
    const parser = new Parser(text);
    const built = parser.parseDocument();
    this.root = built?.node;
    this.value = built?.value;
    this.errors = parser.errors;
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

  /**
   * Finds the node at a JSON Pointer. When the pointer names something that does not exist (a
   * missing required property), returns the deepest existing ancestor with exact set to false.
   */
  locate(pointer: string): { node: JsonNode; member?: JsonMember; exact: boolean } | undefined {
    if (this.root === undefined) return undefined;
    let node: JsonNode = this.root;
    let member: JsonMember | undefined;
    for (const token of parsePointer(pointer)) {
      let child: JsonNode | undefined;
      let childMember: JsonMember | undefined;
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
