import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Comment {
  line: number;
  block: boolean;
  doc: boolean;
  text: string;
}

export type Rule = "commented-out-code" | "divider" | "todo" | "suppression-without-reason";

export interface Violation {
  line: number;
  rule: Rule;
  text: string;
}

const REGEX_AFTER_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const CONDITION_KEYWORDS = new Set(["if", "while", "for", "with"]);

export function scanComments(source: string): Comment[] {
  const comments: Comment[] = [];
  const templateDepths: number[] = [];
  const parens: boolean[] = [];
  let braceDepth = 0;
  let line = 1;
  let previous = "";
  let i = 0;

  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (source[k] === "\n") line++;
    i = Math.min(to, source.length);
  };

  const skipQuoted = (quote: string) => {
    let k = i + 1;
    while (k < source.length && source[k] !== quote && source[k] !== "\n") {
      k += source[k] === "\\" ? 2 : 1;
    }
    advance(k + 1);
  };

  const skipTemplateChunk = () => {
    let k = i;
    while (k < source.length) {
      if (source[k] === "\\") {
        k += 2;
      } else if (source[k] === "`") {
        advance(k + 1);
        return;
      } else if (source[k] === "$" && source[k + 1] === "{") {
        advance(k + 2);
        templateDepths.push(braceDepth);
        braceDepth++;
        return;
      } else {
        k++;
      }
    }
    advance(k);
  };

  const skipRegex = () => {
    let k = i + 1;
    let inClass = false;
    while (k < source.length && source[k] !== "\n") {
      const c = source[k];
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      k++;
    }
    k++;
    while (k < source.length && /[a-z]/i.test(source[k] ?? "")) k++;
    advance(k);
  };

  const regexAllowed = () => {
    if (previous === "") return true;
    if (/^[\w$]+$/.test(previous)) return REGEX_AFTER_KEYWORDS.has(previous);
    return previous !== ")" && previous !== "]";
  };

  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    if (/\s/.test(c)) {
      advance(i + 1);
    } else if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      comments.push({ line, block: false, doc: false, text: source.slice(i + 2, stop) });
      advance(stop);
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      const doc = source[i + 2] === "*" && source[i + 3] !== "/";
      comments.push({ line, block: true, doc, text: source.slice(i + 2, stop - 2) });
      advance(stop);
    } else if (c === '"' || c === "'") {
      skipQuoted(c);
      previous = "string";
    } else if (c === "`") {
      advance(i + 1);
      skipTemplateChunk();
      previous = "string";
    } else if (c === "/" && regexAllowed()) {
      skipRegex();
      previous = "string";
    } else if (/[\w$]/.test(c)) {
      let k = i;
      while (k < source.length && /[\w$]/.test(source[k] ?? "")) k++;
      previous = source.slice(i, k);
      advance(k);
    } else if (c === "}" && templateDepths.at(-1) === braceDepth - 1) {
      braceDepth--;
      templateDepths.pop();
      advance(i + 1);
      skipTemplateChunk();
      previous = "string";
    } else {
      if (c === "{") braceDepth++;
      if (c === "}") braceDepth--;
      if (c === "(") parens.push(CONDITION_KEYWORDS.has(previous));
      previous = c === ")" && parens.pop() ? "{" : c;
      advance(i + 1);
    }
  }
  return comments;
}

const SUPPRESSION =
  /^(biome-ignore-all|biome-ignore-start|biome-ignore-end|biome-ignore|@ts-expect-error|@ts-ignore|@ts-nocheck)\b(.*)$/;
const DIVIDER = /([-=*#~_+/])\1{3,}/;
const TODO = /\b(?:TODO|FIXME|XXX|HACK)\b/;
const CODE = [
  /^(?:const|let|var)\s+[\w${[{]/,
  /^(?:import|export)\s.*(?:\bfrom\s+["']|[{;]$)/,
  /^export\s+default\b/,
  /^(?:if|for|while|switch)\s*\(.*\)\s*\{?$/,
  /^(?:return|await|throw|yield)(?:\s+[\w$.[\]()!]+)?;?$/,
  /^(?:return|await|throw)\b.*;$/,
  /^(?:break|continue);?$/,
  /^[\w$.[\]]+\(.*\);?$/,
  /^[\w$.[\]]+\s*[-+*/]?=\s*\S.*;$/,
  /^[{}\])]+;?$/,
];

function suppressionReason(directive: string, rest: string): string {
  if (directive.startsWith("biome-ignore")) {
    const colon = rest.indexOf(":");
    return colon === -1 ? "" : rest.slice(colon + 1);
  }
  return rest;
}

const withoutQuoted = (body: string) =>
  body.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, "");

export function checkComments(source: string): Violation[] {
  const violations: Violation[] = [];
  for (const comment of scanComments(source)) {
    const lines = comment.block
      ? comment.text.split("\n").map((text) => text.replace(/^\s*\*(?!\*)/, "").trim())
      : [comment.text.replace(/^\/\s*/, "").trim()];
    lines.forEach((body, offset) => {
      const report = (rule: Rule) =>
        violations.push({ line: comment.line + offset, rule, text: body });
      const suppression = SUPPRESSION.exec(body);
      if (suppression) {
        const [, directive = "", rest = ""] = suppression;
        if (
          directive !== "biome-ignore-end" &&
          !/[a-z]{3}/i.test(suppressionReason(directive, rest))
        ) {
          report("suppression-without-reason");
        }
      } else if (DIVIDER.test(body.replace(/\w+:\/\/\S+/g, ""))) {
        report("divider");
      } else if (TODO.test(withoutQuoted(body))) {
        report("todo");
      } else if (!comment.doc && CODE.some((pattern) => pattern.test(body))) {
        report("commented-out-code");
      }
    });
  }
  return violations;
}

const MESSAGES: Record<Rule, string> = {
  "commented-out-code": "commented-out code: delete it, git keeps the history",
  divider: "banner or divider comment: delete it",
  todo: "TODO-style comment: file an issue instead",
  "suppression-without-reason": "suppression without a reason: name the external cause",
};

const GENERATED = new Set(["packages/hatchmark/src/render/text-metrics.ts"]);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((file) => /\.[cm]?ts$/.test(file) && !GENERATED.has(file) && existsSync(file));
  let failures = 0;
  for (const file of new Set(files)) {
    for (const violation of checkComments(readFileSync(file, "utf8"))) {
      failures++;
      console.error(
        `${file}:${violation.line}: ${MESSAGES[violation.rule]}\n    ${violation.text}`,
      );
    }
  }
  if (failures > 0) {
    console.error(
      `\n${failures} comment violation(s). Code carries no comments except license headers, external constraints naming their cause, public API doc comments, and issue or RFC links.`,
    );
    process.exit(1);
  }
}
