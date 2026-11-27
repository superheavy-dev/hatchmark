import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseSync } from "rolldown/utils";

export type Rule = "divider" | "todo" | "suppression-without-reason";

export interface Violation {
  line: number;
  rule: Rule;
  text: string;
}

const SUPPRESSION =
  /^(biome-ignore-all|biome-ignore-start|biome-ignore-end|biome-ignore|@ts-expect-error|@ts-ignore|@ts-nocheck)\b(.*)$/s;
const MARKER = /\b(?:TODO|FIXME|XXX|HACK)\b(?=\s*[:(]|\s*$)/m;
const DIVIDER = /([-=*#~_+/])\1{3,}/;
const URL = /\w+:\/\/\S+/g;

function suppressionReason(directive: string, rest: string): string {
  if (!directive.startsWith("biome-ignore")) return rest;
  const colon = rest.indexOf(":");
  return colon === -1 ? "" : rest.slice(colon + 1);
}

export function checkComments(file: string, source: string): Violation[] {
  const { comments, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file}: ${errors[0]?.message}`);
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const violations: Violation[] = [];
  for (const comment of comments) {
    const line = lineAt(comment.start);
    const body =
      comment.type === "Line" ? comment.value.replace(/^\/(?=\s|@|<)/, "") : comment.value;
    const report = (rule: Rule, offset = 0) =>
      violations.push({ line: line + offset, rule, text: body.trim() });
    const suppression = SUPPRESSION.exec(body.replace(/^\*?\s*/, ""));
    if (suppression) {
      const [, directive = "", rest = ""] = suppression;
      if (
        directive !== "biome-ignore-end" &&
        !/[a-z]{3}/i.test(suppressionReason(directive, rest))
      ) {
        report("suppression-without-reason");
      }
      continue;
    }
    if (MARKER.test(body)) report("todo");
    body.split("\n").forEach((text, offset) => {
      const content = offset > 0 ? text.replace(/^\s*\*/, "") : text;
      if (DIVIDER.test(content.replace(URL, ""))) report("divider", offset);
    });
  }
  return violations;
}

const LINTED = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export function biomeFiles(): string[] {
  const config = JSON.parse(readFileSync("biome.json", "utf8"));
  const includes: string[] = config.files?.includes ?? ["**"];
  const excluded = includes.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const unsupported = [
    ...includes.filter((p) => !p.startsWith("!") && p !== "**"),
    ...excluded.filter((p) => /[*?[{]/.test(p)),
  ];
  if (unsupported.length > 0) {
    throw new Error(
      `check-comments does not understand biome.json files.includes ${unsupported.join(", ")}`,
    );
  }
  const git = config.vcs?.useIgnoreFile
    ? ["--cached", "--others", "--exclude-standard"]
    : ["--cached", "--others"];
  return [
    ...new Set(execFileSync("git", ["ls-files", "-z", ...git], { encoding: "utf8" }).split("\0")),
  ]
    .filter((file) => LINTED.test(file) && existsSync(file))
    .filter((file) => !excluded.some((dir) => file === dir || file.startsWith(`${dir}/`)));
}

const MESSAGES: Record<Rule, string> = {
  divider: "banner or divider comment: delete it",
  todo: "TODO-style marker: file an issue instead",
  "suppression-without-reason": "suppression without a reason: name the external cause",
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let failures = 0;
  for (const file of biomeFiles()) {
    for (const violation of checkComments(file, readFileSync(file, "utf8"))) {
      failures++;
      console.error(
        `${file}:${violation.line}: ${MESSAGES[violation.rule]}\n    ${violation.text}`,
      );
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} comment violation(s).`);
    process.exit(1);
  }
}
