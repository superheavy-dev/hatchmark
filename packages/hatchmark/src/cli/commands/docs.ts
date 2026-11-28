import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../version.js";
import type { CommandHelp } from "../help.js";
import { type CommandResult, EXIT } from "../io.js";
import { packageRoot } from "../package-root.js";
import { usageError } from "../usage.js";

export const docsHelp: CommandHelp = {
  name: "docs",
  summary:
    "Print the docs bundled with this version of Hatchmark: list the topics, print a topic or one section, or search them.",
  usage: 'hatchmark docs [topic[#section]] | hatchmark docs --search "<words>"',
  options: [
    { flag: "[topic]", description: "A page such as metrics, cli or components/table (or table)." },
    {
      flag: "[topic#section]",
      description: "One section of a page by its heading anchor, such as cli#data.",
    },
    {
      flag: "--search <words>",
      description:
        "Sections that contain every word, best first, each with the topic#section that prints it.",
    },
    { flag: "--limit <n>", description: "Search results to print. Default 10." },
  ],
  example: {
    command: 'hatchmark docs --search "percent of total"',
    description: "Then hatchmark docs <topic#section> prints a result in full.",
  },
};

interface Section {
  title: string;
  anchor: string;
  level: number;
  line: number;
  text: string;
  own: string;
}

interface Page {
  topic: string;
  title: string;
  path: string;
  text: string;
  sections: Section[];
}

export function headingAnchor(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function sectionsOf(text: string): Section[] {
  const lines = text.split("\n");
  const headings: Omit<Section, "text" | "own">[] = [];
  const seen = new Map<string, number>();
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading === null) return;
    const title = heading[2] ?? "";
    const base = headingAnchor(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    headings.push({
      title,
      anchor: n === 0 ? base : `${base}-${n}`,
      level: heading[1]?.length ?? 1,
      line: i + 1,
    });
  });
  return headings.map((h, i) => {
    const end = (after: (next: (typeof headings)[number]) => boolean) =>
      headings.slice(i + 1).find(after)?.line ?? lines.length + 1;
    const slice = (to: number) =>
      lines
        .slice(h.line - 1, to - 1)
        .join("\n")
        .trimEnd();
    return { ...h, text: slice(end((next) => next.level <= h.level)), own: slice(end(() => true)) };
  });
}

async function loadPages(dir: string): Promise<Page[]> {
  const files = (await readdir(dir, { recursive: true }))
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(dir, file), "utf8");
      const sections = sectionsOf(text);
      const topic = file === "README.md" ? "index" : file.slice(0, -3);
      return { topic, title: sections[0]?.title ?? topic, path: file, text, sections };
    }),
  );
}

function findPage(pages: Page[], name: string): Page | undefined {
  const exact = pages.find((p) => p.topic === name);
  if (exact) return exact;
  const short = pages.filter((p) => p.topic.split("/").at(-1) === name);
  return short.length === 1 ? short[0] : undefined;
}

function search(pages: Page[], query: string, limit: number) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = pages.flatMap((page) =>
    page.sections.flatMap((s) => {
      const own = s.own.toLowerCase();
      if (!words.every((w) => own.includes(w))) return [];
      const title = s.title.toLowerCase();
      const phrase = words.join(" ");
      const score =
        words.reduce((sum, w) => sum + own.split(w).length - 1 + (title.includes(w) ? 5 : 0), 0) +
        (words.length > 1 && own.includes(phrase) ? 10 : 0);
      const body = s.own.split("\n").slice(1);
      const hit =
        body.find((l) => words.every((w) => l.toLowerCase().includes(w))) ??
        body.find((l) => l.toLowerCase().includes(words[0] ?? "")) ??
        s.title;
      return [
        {
          section: `${page.topic}#${s.anchor}`,
          topic: page.topic,
          title: s.title,
          path: page.path,
          line: s.line,
          snippet: hit.trim().slice(0, 200),
          score,
        },
      ];
    }),
  );
  return results
    .sort((a, b) => b.score - a.score || a.section.localeCompare(b.section))
    .slice(0, limit);
}

export async function docs(
  positionals: string[],
  flags: { search?: string; limit?: string },
  dir?: string,
): Promise<CommandResult> {
  const [target, ...rest] = positionals;
  if (rest.length > 0) return usageError("HM0002", `unexpected argument "${rest[0]}"`);
  if (target !== undefined && flags.search !== undefined) {
    return usageError("HM0002", "pass a topic or --search, not both");
  }
  const limit = Number(flags.limit ?? "10");
  if (!/^\d+$/.test(flags.limit ?? "10") || limit < 1) {
    return usageError("HM0002", "--limit must be a whole number of at least 1", {
      input: flags.limit ?? "",
    });
  }
  const root =
    dir ?? path.join(await packageRoot(path.dirname(fileURLToPath(import.meta.url))), "docs");
  const pages = await loadPages(root);

  if (flags.search !== undefined) {
    if (flags.search.trim() === "") return usageError("HM0003", "missing search words");
    const results = search(pages, flags.search, limit);
    return {
      exitCode: EXIT.ok,
      json: { format_version: "1", version: VERSION, query: flags.search, results },
      human:
        results.length === 0
          ? `no section contains every word of "${flags.search}"; run hatchmark docs for the topics`
          : results.map((r) => `${r.section}  ${r.title}\n  ${r.snippet}`).join("\n\n"),
    };
  }

  if (target === undefined) {
    const topics = pages.map((p) => ({ topic: p.topic, title: p.title, path: p.path }));
    const width = Math.max(...topics.map((t) => t.topic.length));
    return {
      exitCode: EXIT.ok,
      json: { format_version: "1", version: VERSION, dir: root, topics },
      human: [
        `Hatchmark ${VERSION} docs in ${root}`,
        "",
        ...topics.map((t) => `  ${t.topic.padEnd(width)}  ${t.title}`),
        "",
        'Run hatchmark docs <topic> to print one, or hatchmark docs --search "<words>".',
      ].join("\n"),
    };
  }

  const [name = "", anchor = ""] = target.split("#", 2);
  const page = findPage(pages, name.replace(/\.md$/, ""));
  if (page === undefined) {
    return usageError("HM0002", `unknown docs topic "${name}"`, {
      expected: pages.map((p) => p.topic),
      input: name,
    });
  }
  const head = { format_version: "1", version: VERSION, topic: page.topic, path: page.path };
  if (anchor === "") {
    return {
      exitCode: EXIT.ok,
      json: { ...head, title: page.title, content: page.text },
      human: page.text.trimEnd(),
    };
  }
  const section = page.sections.find((s) => s.anchor === anchor.toLowerCase());
  if (section === undefined) {
    return usageError("HM0002", `no section "${anchor}" in docs topic "${page.topic}"`, {
      expected: page.sections.map((s) => s.anchor),
      input: anchor,
    });
  }
  return {
    exitCode: EXIT.ok,
    json: {
      ...head,
      section: section.anchor,
      title: section.title,
      line: section.line,
      content: section.text,
    },
    human: section.text,
  };
}
