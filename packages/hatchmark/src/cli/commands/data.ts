import {
  createReport,
  type Diagnostic,
  docsCommand,
  renderHuman,
} from "../../diagnostics/index.js";
import {
  type DataSession,
  MissingSource,
  nodeProjectHost,
  openDataSession,
  QueryRejected,
  SourceReadError,
} from "../../node/index.js";
import {
  CONFIG_FILE,
  loadProject,
  type ProjectConfig,
  parseDiagnostics,
} from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";
import { exitCodeFor } from "./check.js";

export const dataHelp: CommandHelp = {
  name: "data",
  summary:
    "Explore the project's data before writing YAML: describe a source, or run a read-only SQL query over the sources.",
  usage:
    'hatchmark data describe <source> [--limit <n>] | hatchmark data query "<sql>" [--limit <n>]',
  options: [
    {
      flag: "describe <source>",
      description:
        "Columns with their DuckDB type and kind, null and distinct counts, min and max of time and number columns, the row count and the first rows.",
    },
    {
      flag: 'query "<sql>"',
      description:
        "One SELECT statement. Each file source is a table named after the source; nothing outside them can be read or written.",
    },
    {
      flag: "--limit <n>",
      description: `Rows to print: sample rows for describe (default 5), result rows for query (default 100, at most 10000).`,
    },
  ],
  example: {
    command: 'hatchmark data query "SELECT region, sum(amount) FROM orders GROUP BY 1"',
    description: "Prints the result; JSON gives columns, rows as arrays, and truncated.",
  },
};

const DEFAULT_LIMIT = { describe: 5, query: 100 };
const MAX_LIMIT = 10_000;
const SUBCOMMANDS = ["describe", "query"];

function parseLimit(value: string | undefined, min: number): number | CommandResult {
  if (value === undefined) return Number.NaN;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < min || n > MAX_LIMIT) {
    return usageError("HM0002", `--limit must be a whole number from ${min} to ${MAX_LIMIT}`, {
      input: value,
    });
  }
  return n;
}

function report(
  ctx: CommandContext,
  diagnostics: Diagnostic[],
  exitCode = exitCodeFor(diagnostics, false),
): CommandResult {
  const r = createReport(diagnostics);
  return { exitCode, json: r, human: renderHuman(r, { color: ctx.color }) };
}

export async function data(
  ctx: CommandContext,
  positionals: string[],
  flags: { limit?: string },
): Promise<CommandResult> {
  const [sub, arg, ...rest] = positionals;
  if (sub === undefined) {
    return usageError("HM0003", "missing subcommand: describe or query", {
      help: 'run hatchmark data describe <source>, or hatchmark data query "<sql>"',
    });
  }
  if (!SUBCOMMANDS.includes(sub)) {
    return usageError("HM0002", `unknown data subcommand "${sub}"`, {
      expected: SUBCOMMANDS,
      input: sub,
    });
  }
  const kind = sub as "describe" | "query";
  if (arg === undefined) {
    return usageError(
      "HM0003",
      kind === "describe" ? "missing argument <source>" : 'missing argument "<sql>"',
      { help: "run hatchmark data --help" },
    );
  }
  if (rest.length > 0) {
    return usageError("HM0002", `unexpected argument "${rest[0]}"`, {
      help:
        kind === "query"
          ? "quote the whole query as one argument"
          : "describe one source at a time",
    });
  }
  const parsed = parseLimit(flags.limit, kind === "describe" ? 0 : 1);
  if (typeof parsed !== "number") return parsed;
  const limit = Number.isNaN(parsed) ? DEFAULT_LIMIT[kind] : parsed;

  const { project, diagnostics } = await loadProject(nodeProjectHost(ctx.root));
  const config = project?.config.spec;
  if (config === undefined) {
    return report(
      ctx,
      [...diagnostics, ...(project === undefined ? [] : parseDiagnostics(project))],
      EXIT.usage,
    );
  }
  const fileSources = Object.entries(config.sources)
    .filter(([, s]) => s.type !== "lookup")
    .map(([name]) => name)
    .sort();

  if (kind === "describe") {
    const source = config.sources[arg];
    if (source === undefined) {
      return usageError("HM0002", `unknown source "${arg}"`, { expected: fileSources, input: arg });
    }
    if (source.type === "lookup") {
      return usageError("HM0002", `"${arg}" is a lookup source`, {
        help: `describe the sources it joins: ${[source.from, ...source.lookups.map((l) => l.table)].join(", ")}`,
      });
    }
  }
  const session = await openDataSession({ root: ctx.root, config });
  try {
    const missingFile = (name: string) =>
      diagnostics.filter((d) => d.code === "HM2010" && d.pointer === `/sources/${name}/path`);
    if (kind === "describe") {
      const missing = missingFile(arg);
      if (missing.length > 0) return report(ctx, missing);
      return await describe(session, config, arg, limit);
    }
    const missing = new Set(fileSources.filter((name) => missingFile(name).length > 0));
    return await query(ctx, session, arg, { sources: fileSources, missing, limit }).catch(
      (error: unknown) => {
        if (error instanceof MissingSource) return report(ctx, missingFile(error.source));
        throw error;
      },
    );
  } catch (error) {
    if (error instanceof SourceReadError) {
      return report(
        ctx,
        [
          {
            code: "HM2015",
            severity: "error",
            message: `data cannot be read: ${firstLine(error.message)}`,
            help: `check the file and the reader options of the source in ${CONFIG_FILE}`,
            docs: docsCommand("HM2015"),
          },
        ],
        EXIT.check,
      );
    }
    if (error instanceof QueryRejected) {
      return report(
        ctx,
        [
          {
            code: "HM0008",
            severity: "error",
            message: `${error.message}; nothing ran`,
            help: "pass one SELECT statement, such as SELECT * FROM <source> LIMIT 10",
            docs: docsCommand("HM0008"),
          },
        ],
        EXIT.usage,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    const unknownTable = /Table with name .* does not exist/.test(message);
    return report(
      ctx,
      [
        {
          code: "HM0009",
          severity: "error",
          message: `query failed: ${firstLine(message)}`,
          ...(unknownTable ? { expected: fileSources } : {}),
          help: unknownTable
            ? "each file source is a table named after the source"
            : "the query runs in DuckDB SQL; see https://duckdb.org/docs/sql/introduction",
          docs: docsCommand("HM0009"),
        },
      ],
      EXIT.usage,
    );
  } finally {
    await session.close();
  }
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

async function describe(
  session: DataSession,
  config: ProjectConfig,
  name: string,
  limit: number,
): Promise<CommandResult> {
  const source = config.sources[name] as { type: string; path: string };
  const described = await session.describe(name, limit);
  const columns = described.columns.map((c) => [
    c.name,
    c.type,
    c.kind,
    String(c.nulls),
    String(c.distinct),
    c.min === undefined ? "" : cell(c.min),
    c.max === undefined ? "" : cell(c.max),
  ]);
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", source: name, type: source.type, path: source.path, ...described },
    human: [
      `${name}: ${source.type} ${source.path}, ${described.row_count} rows`,
      "",
      table(["column", "type", "kind", "nulls", "distinct", "min", "max"], columns),
      "",
      described.sample.rows.length > 0
        ? `first ${described.sample.rows.length} rows:\n${table(
            described.sample.columns,
            described.sample.rows.map((r) => r.map(cell)),
          )}`
        : "no sample rows",
    ].join("\n"),
  };
}

async function query(
  ctx: CommandContext,
  session: DataSession,
  sql: string,
  options: { sources: readonly string[]; missing: ReadonlySet<string>; limit: number },
): Promise<CommandResult> {
  const { limit } = options;
  const { sources, ...result } = await session.query(sql, options);
  const note = result.truncated
    ? `first ${result.rows.length} rows shown; more rows exist (raise --limit, at most ${MAX_LIMIT}, or aggregate)`
    : `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`;
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", sql, sources, limit, ...result },
    human: ctx.quiet
      ? ""
      : `${table(
          result.columns.map((c) => c.name),
          result.rows.map((r) => r.map(cell)),
        )}\n${note}`,
  };
}

function cell(value: unknown): string {
  if (value === null) return "NULL";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function table(head: string[], rows: string[][]): string {
  const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
  const all = [head, ...rows].map((r) => r.map((s) => clip(s.replace(/\s+/g, " "))));
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((s, i) => s.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(all[0] ?? []),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...all.slice(1).map(line),
  ].join("\n");
}
