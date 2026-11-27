import type { Position, Range } from "./diagnostic.js";
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
  /** Offset of the earlier occurrence, for duplicate keys. */
  related?: number;
  /** A text edit that repairs the error, when the repair is unambiguous. */
  repair?: { start: number; end: number; text: string };
}

/** Thrown internally to stop parsing at the first syntax error. */
class StopParsing extends Error {}

/**
 * A strict RFC 8259 JSON parser that keeps the source offset of every value and key, so a
 * diagnostic found on the parsed value (through a JSON Pointer) can point back to file:line:col.
 * It stops at the first syntax error, and also reports duplicate object keys, which JSON.parse
 * accepts silently by keeping the last one.
 */
class Parser {
  private pos = 0;
  readonly errors: JsonSyntaxError[] = [];

  constructor(private readonly text: string) {
    if (text.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  parseDocument(): JsonNode | undefined {
    try {
      this.skipWhitespace();
      if (this.pos >= this.text.length) this.fail("expected a JSON value, found end of file");
      const root = this.parseValue();
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
    this.errors.push({ kind: "syntax", message, start, end, ...(repair ? { repair } : {}) });
    throw new StopParsing();
  }

  private describeHere(): string {
    if (this.pos >= this.text.length) return "end of file";
    const ch = this.text[this.pos];
    return ch === "\n" ? "a line break" : JSON.stringify(ch);
  }

  private skipWhitespace(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.pos++;
        continue;
      }
      if (ch === "/" && (this.text[this.pos + 1] === "/" || this.text[this.pos + 1] === "*")) {
        const start = this.pos;
        const close = this.text[this.pos + 1] === "/" ? "\n" : "*/";
        const found = this.text.indexOf(close, start + 2);
        const end = found === -1 ? this.text.length : found + (close === "*/" ? 2 : 0);
        this.fail("comments are not allowed in JSON", start, end, { start, end, text: "" });
      }
      return;
    }
  }

  private parseValue(): JsonNode {
    const ch = this.text[this.pos];
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"') {
      const start = this.pos;
      const value = this.parseString();
      return { kind: "string", value, start, end: this.pos };
    }
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return this.parseNumber();
    for (const [word, node] of [
      ["true", { kind: "boolean", value: true }],
      ["false", { kind: "boolean", value: false }],
      ["null", { kind: "null", value: null }],
    ] as const) {
      if (this.text.startsWith(word, this.pos)) {
        const start = this.pos;
        this.pos += word.length;
        return { ...node, start, end: this.pos };
      }
    }
    if (ch === "'") this.fail("strings must use double quotes");
    if (ch !== undefined && /[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos))?.[0] ?? ch;
      this.fail(
        `unexpected word ${JSON.stringify(word)}: strings must be in double quotes`,
        this.pos,
        this.pos + word.length,
      );
    }
    return this.fail(`expected a JSON value, found ${this.describeHere()}`);
  }

  private parseObject(): JsonNode {
    const start = this.pos;
    this.pos++;
    const members: JsonMember[] = [];
    const seen = new Map<string, number>();
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return { kind: "object", members, start, end: this.pos };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') {
        if (this.text[this.pos] === "}" && members.length > 0) {
          this.failTrailingComma();
        }
        const ch = this.text[this.pos];
        if (ch !== undefined && /[A-Za-z_]/.test(ch)) {
          this.fail("object keys must be strings in double quotes");
        }
        this.fail(`expected a property name in double quotes, found ${this.describeHere()}`);
      }
      const keyStart = this.pos;
      const key = this.parseString();
      const keyEnd = this.pos;
      const previous = seen.get(key);
      if (previous !== undefined) {
        this.errors.push({
          kind: "duplicate-key",
          message: `duplicate key ${JSON.stringify(key)}`,
          start: keyStart,
          end: keyEnd,
          related: previous,
        });
      }
      seen.set(key, keyStart);
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") {
        this.fail(`expected ":" after property name, found ${this.describeHere()}`);
      }
      this.pos++;
      this.skipWhitespace();
      const value = this.parseValue();
      members.push({ key, keyStart, keyEnd, value });
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ",") {
        this.lastComma = this.pos;
        this.pos++;
        continue;
      }
      if (next === "}") {
        this.pos++;
        return { kind: "object", members, start, end: this.pos };
      }
      if (next === '"') {
        this.fail('expected "," between properties', this.pos, this.pos + 1, {
          start: value.end,
          end: value.end,
          text: ",",
        });
      }
      this.fail(`expected "," or "}" after property value, found ${this.describeHere()}`);
    }
  }

  private lastComma = -1;

  private failTrailingComma(): never {
    const comma = this.lastComma;
    return this.fail("trailing commas are not allowed in JSON", comma, comma + 1, {
      start: comma,
      end: comma + 1,
      text: "",
    });
  }

  private parseArray(): JsonNode {
    const start = this.pos;
    this.pos++;
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return { kind: "array", items, start, end: this.pos };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] === "]" && items.length > 0) this.failTrailingComma();
      const item = this.parseValue();
      items.push(item);
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ",") {
        this.lastComma = this.pos;
        this.pos++;
        continue;
      }
      if (next === "]") {
        this.pos++;
        return { kind: "array", items, start, end: this.pos };
      }
      this.fail(`expected "," or "]" after array item, found ${this.describeHere()}`);
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined || ch === "\n") {
        this.fail("unterminated string", start, this.pos);
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === "\\") {
        const esc = this.text[this.pos + 1];
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (esc !== undefined && esc in simple) {
          out += simple[esc];
          this.pos += 2;
          continue;
        }
        if (esc === "u") {
          const hex = this.text.slice(this.pos + 2, this.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail("invalid \\u escape: expected four hex digits", this.pos, this.pos + 2);
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 6;
          continue;
        }
        this.fail("invalid escape sequence in string", this.pos, this.pos + 2);
      }
      if (ch < " ") this.fail("control characters must be escaped in strings");
      out += ch;
      this.pos++;
    }
  }

  private parseNumber(): JsonNode {
    const start = this.pos;
    const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.text.slice(start));
    if (!match) this.fail("invalid number", start);
    this.pos += match[0].length;
    const next = this.text[this.pos];
    if (next !== undefined && /[0-9.eExX]/.test(next)) {
      const tail = /^[0-9A-Za-z.+-]*/.exec(this.text.slice(this.pos))?.[0] ?? "";
      this.fail("invalid number", start, this.pos + tail.length);
    }
    return { kind: "number", value: Number(match[0]), start, end: this.pos };
  }
}

/** A parsed JSON file that can map offsets and JSON Pointers back to line and column. */
export class JsonDocument {
  readonly root: JsonNode | undefined;
  readonly errors: readonly JsonSyntaxError[];
  private readonly lineStarts: number[];

  constructor(
    readonly file: string,
    readonly text: string,
  ) {
    const parser = new Parser(text);
    this.root = parser.parseDocument();
    this.errors = parser.errors;
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  /** The plain value, or undefined when the file did not parse. */
  get value(): unknown {
    return this.root === undefined ? undefined : toValue(this.root);
  }

  /** 1-based line and column; columns count Unicode code points, so emoji count once. */
  positionAt(offset: number): Position {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = this.lineStarts[lo] ?? 0;
    return { line: lo + 1, column: [...this.text.slice(lineStart, offset)].length + 1 };
  }

  rangeAt(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }

  /** The source text of one line, without its line break. */
  lineText(line: number): string {
    const start = this.lineStarts[line - 1];
    if (start === undefined) return "";
    const next = this.lineStarts[line];
    return this.text
      .slice(start, next === undefined ? this.text.length : next - 1)
      .replace(/\r$/, "");
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
   * A pointer that does not exist resolves to the opening line of its deepest existing ancestor.
   */
  rangeOf(pointer: string, target: "value" | "key" = "value"): Range | undefined {
    const found = this.locate(pointer);
    if (found === undefined) return undefined;
    if (!found.exact) {
      const { node, member } = found;
      if (member) return this.rangeAt(member.keyStart, member.keyEnd);
      return this.rangeAt(node.start, node.start + 1);
    }
    if (target === "key" && found.member) {
      return this.rangeAt(found.member.keyStart, found.member.keyEnd);
    }
    return this.rangeAt(found.node.start, found.node.end);
  }
}

function toValue(node: JsonNode): unknown {
  switch (node.kind) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const member of node.members) {
        Object.defineProperty(out, member.key, {
          value: toValue(member.value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    case "array":
      return node.items.map(toValue);
    default:
      return node.value;
  }
}
