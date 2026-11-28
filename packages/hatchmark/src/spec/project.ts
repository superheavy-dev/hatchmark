import type { z } from "zod";
import {
  type Diagnostic,
  docsCommand,
  isDiagnosticCode,
  parseYamlFile,
  type SpecDocument,
  type SpecNode,
} from "../diagnostics/index.js";
import {
  GLOB_CHARACTERS,
  hasColumn,
  IDENTIFIER_PATTERN,
  normalizePath,
  plainAggregate,
} from "./common.js";
import {
  type DatabaseSource,
  type FileSource,
  isDatabaseSource,
  PROJECT_DEFAULTS,
  type ProjectConfig,
  projectConfigSchema,
} from "./config.js";
import { type Dashboard, dashboardSchema } from "./dashboard.js";
import { KEYWORDS } from "./expr.js";
import { type Metric, metricSchema } from "./metric.js";
import { type Segment, segmentSchema } from "./segment.js";
import { issuesToDiagnostics } from "./zod-diagnostics.js";

export const CONFIG_FILE = "hatchmark.yaml";
const SPEC_EXTENSION = ".yaml";
const UNREAD_EXTENSIONS = [".json", ".yml"] as const;
/** Root config files that are not read, each reported as HM1007 naming hatchmark.yaml. */
export const UNREAD_CONFIG_FILES = UNREAD_EXTENSIONS.map(
  (ext) => `${CONFIG_FILE.slice(0, -SPEC_EXTENSION.length)}${ext}`,
);
const DASHBOARD_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type SpecKind = "project" | "metric" | "dashboard" | "segment";

interface SpecTypes {
  project: ProjectConfig;
  metric: Metric;
  dashboard: Dashboard;
  segment: Segment;
}

const schemas: { [K in SpecKind]: z.ZodType<SpecTypes[K]> } = {
  project: projectConfigSchema,
  metric: metricSchema,
  dashboard: dashboardSchema,
  segment: segmentSchema,
};

export const SPEC_SCHEMAS = schemas;

/** One parsed spec file. spec is set only when the file parsed and passed its schema. */
export interface SpecFile<K extends SpecKind = SpecKind> {
  kind: K;
  /** Metric or dashboard name: the file name without .yaml. */
  name: string;
  /** Project-relative path with forward slashes. */
  file: string;
  document: SpecDocument;
  spec?: SpecTypes[K];
  diagnostics: Diagnostic[];
}

export interface Project {
  config: SpecFile<"project">;
  metrics: Map<string, SpecFile<"metric">>;
  dashboards: Map<string, SpecFile<"dashboard">>;
  segments: Map<string, SpecFile<"segment">>;
  /** Source names whose data file is missing; filled by loadProject. */
  missingData: Set<string>;
  /**
   * Column names by source: CSV headers, and the columns of other files when the host can read
   * them (ProjectHost.columns). A source missing from the map has unknown columns.
   */
  columns: Map<string, string[]>;
  /**
   * Column names and DuckDB types of the sources an in_table or not_in_table filter compares, when
   * the host can read them (ProjectHost.columnTypes). A source missing from the map has unknown types.
   */
  columnTypes: Map<string, { name: string; type: string }[]>;
  /** The schema of each database source whose columns the host could read (ProjectHost.database). */
  databases: Map<string, DatabaseSchema>;
}

/**
 * Parses and validates one spec file from its text. Pure, so a dev server can re-run it for the
 * one file that changed and keep the rest of the project.
 */
export function parseSpecFile<K extends SpecKind>(
  kind: K,
  file: string,
  text: string,
): SpecFile<K> {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const name = base.endsWith(SPEC_EXTENSION) ? base.slice(0, -SPEC_EXTENSION.length) : base;
  const { document, diagnostics } = parseYamlFile(file, text);
  diagnostics.push(...commentedValues(document));
  const result: SpecFile<K> = { kind, name, file, document, diagnostics };
  if (kind !== "project") {
    const pattern = kind === "dashboard" ? DASHBOARD_NAME_PATTERN : IDENTIFIER_PATTERN;
    const keyword = kind === "metric" && KEYWORDS.has(name);
    if (!pattern.test(name) || keyword) {
      diagnostics.push({
        code: "HM1004",
        severity: "error",
        message: keyword
          ? `"${name}" is an expression keyword, so it cannot name a metric`
          : `invalid ${kind} file name "${base}"`,
        file,
        help: keyword
          ? `and, or, not and null are operators in expressions; rename the file, such as ${name}_count.yaml`
          : kind !== "dashboard"
            ? `${kind} names are lowercase snake_case, such as ${kind === "metric" ? "net_revenue" : "external_customers"}.yaml`
            : "dashboard names are lowercase letters, digits, _ and -, such as sales-overview.yaml",
        docs: docsCommand("HM1004"),
      });
    }
  }
  if (
    document.root === undefined ||
    diagnostics.some((d) => d.code === "HM1002" || d.code === "HM1006")
  )
    return result;
  const parsed = schemas[kind].safeParse(document.value);
  if (parsed.success) {
    if (!diagnostics.some((d) => d.severity === "error")) result.spec = parsed.data;
  } else {
    diagnostics.push(
      ...issuesToDiagnostics(parsed.error.issues, {
        root: schemas[kind],
        document,
        ...(kind === "project" ? { defaults: PROJECT_DEFAULTS } : {}),
      }),
    );
  }
  return result;
}

/** The columns of a database source, as Hatchmark reads them. */
export interface DatabaseSchema {
  columns: { name: string; type: string }[];
  /** Exact decimal columns (NUMERIC, DECIMAL) the database driver delivers as DOUBLE (HM4080). */
  decimals: string[];
  /**
   * "database" when read from the database itself, "cached" from a local copy younger than the
   * source's max_age, "copy" from the newest local copy when the credentials are not set.
   */
  origin: "database" | "cached" | "copy";
  /** For "cached" and "copy": when the copy was fetched, ISO 8601 UTC. */
  stored_at?: string;
}

/** A failure the host reports for a database source: its diagnostic code, message and help. */
export interface DatabaseProblem {
  code: string;
  message: string;
  help?: string;
}

/**
 * How the engine reads a project. The core never touches a file system itself, so it runs
 * unchanged in Node, a browser or a worker; the CLI passes a Node implementation (src/node/host.ts).
 * Every path is project-relative with forward slashes.
 */
export interface ProjectHost {
  /** Shown in messages, such as the project's absolute directory. */
  readonly label: string;
  /** The file's text, or undefined when it does not exist or cannot be read. */
  readText(file: string): Promise<string | undefined>;
  /** Names of the files (not directories) directly inside a directory; empty when it is missing. */
  listFiles(dir: string): Promise<string[]>;
  /** Whether the path is an existing file. */
  isFile(file: string): Promise<boolean>;
  /**
   * Up to the first bytes of a file decoded as UTF-8, and whether that is the whole file; undefined
   * when it cannot be read.
   */
  readHead(file: string, bytes: number): Promise<{ text: string; complete: boolean } | undefined>;
  /**
   * Optional: the column names of a Parquet or JSON source, as the host's query engine reads the
   * file; undefined when it cannot tell. Hosts without a query engine leave it out, and those
   * sources keep unknown columns.
   */
  columns?(file: string, source: FileSource): Promise<string[] | undefined>;
  /**
   * Optional: the column names and types of a source as the host's query engine reads it, with the
   * source's reader options; undefined when it cannot tell. Read only for sources whose columns an
   * in_table or not_in_table filter compares.
   */
  columnTypes?(
    file: string,
    source: FileSource,
  ): Promise<{ name: string; type: string }[] | undefined>;
  /**
   * Optional: the columns of a database source, without reading its rows. Rejects with a
   * DatabaseProblem when the database cannot be read. Hosts without database access leave it out,
   * and those sources keep unknown columns.
   */
  database?(name: string, source: DatabaseSource): Promise<DatabaseSchema>;
}

const FILTER_VALUE_KEYS = new Set(["value", "values", "from", "to"]);

function commentedValues(document: SpecDocument): Diagnostic[] {
  const found: Diagnostic[] = [];
  const text = document.text;
  const check = (node: SpecNode, flow = false): void => {
    if (node.kind === "array") {
      for (const item of node.items) check(item, flow || node.flow);
      return;
    }
    const plain =
      (node.kind === "string" && node.style === "plain") ||
      node.kind === "number" ||
      node.kind === "boolean";
    if (!plain) return;
    const comment = /^[ \t]+#/.exec(text.slice(node.end));
    if (comment === null) return;
    const lineEnd = text.slice(node.end).search(/\r\n|\r|\n|$/);
    const line = text.slice(node.start, node.end + lineEnd);
    const written = (flow ? line.replace(/[\s,\]}]+$/, "") : line).trimEnd();
    found.push({
      code: "HM1008",
      severity: "warning",
      message: `this value is read as ${JSON.stringify(node.value)}: the text after # is a comment`,
      file: document.file,
      ...document.location(node.start, node.end + lineEnd),
      help: `quote it if the # is part of the value: ${JSON.stringify(written)}`,
      docs: docsCommand("HM1008"),
    });
  };
  const walk = (node: SpecNode | undefined): void => {
    if (node === undefined) return;
    if (node.kind === "array") for (const item of node.items) walk(item);
    if (node.kind !== "object") return;
    const flow = node.flow;
    const keys = new Set(node.members.map((m) => m.key));
    const select = node.members.some(
      (m) => m.key === "type" && m.value.kind === "string" && m.value.value === "select",
    );
    for (const member of node.members) {
      if (
        (keys.has("op") && FILTER_VALUE_KEYS.has(member.key)) ||
        (select && member.key === "default") ||
        member.key === "sql"
      )
        check(member.value, flow);
      else walk(member.value);
    }
  };
  walk(document.root);
  return found;
}

function dirSetting(
  config: SpecFile<"project">,
  key: "metricsDir" | "dashboardsDir" | "segmentsDir",
): string {
  const fallback = key === "segmentsDir" ? "segments" : PROJECT_DEFAULTS[key];
  if (config.spec) return config.spec[key] ?? fallback;
  const raw = (config.document.value as Record<string, unknown> | undefined)?.[key];
  return typeof raw === "string" ? raw : fallback;
}

/**
 * Reads hatchmark.yaml, every metric and dashboard file, and checks that each source's data file
 * exists. Returns undefined for the project when there is no config file. A spec file with another
 * extension (a .json or .yml file) is not read; each one gets HM1007 naming the .yaml file expected.
 */
export async function loadProject(
  host: ProjectHost,
): Promise<{ project?: Project; diagnostics: Diagnostic[] }> {
  const unread: Diagnostic[] = [];
  const flagUnread = (file: string): void => {
    const ext = UNREAD_EXTENSIONS.find((e) => file.endsWith(e)) ?? "";
    const expected = `${file.slice(0, -ext.length)}${SPEC_EXTENSION}`;
    unread.push({
      code: "HM1007",
      severity: "error",
      message: `${file} is not read: spec files are YAML, in ${expected}`,
      file,
      help: `write it as YAML in ${expected} and delete ${file}`,
      docs: docsCommand("HM1007"),
    });
  };
  for (const file of UNREAD_CONFIG_FILES) if (await host.isFile(file)) flagUnread(file);
  const configText = await host.readText(CONFIG_FILE);
  if (configText === undefined) {
    if (unread.length > 0) return { diagnostics: unread };
    return {
      diagnostics: [
        {
          code: "HM1005",
          severity: "error",
          message: `no ${CONFIG_FILE} in ${host.label}`,
          help: "run from the project root, pass --cwd <dir>, or create a project with hatchmark init",
          docs: docsCommand("HM1005"),
        },
      ],
    };
  }
  const config = parseSpecFile("project", CONFIG_FILE, configText);
  const project: Project = {
    config,
    metrics: new Map(),
    dashboards: new Map(),
    segments: new Map(),
    missingData: new Set(),
    columns: new Map(),
    columnTypes: new Map(),
    databases: new Map(),
  };

  for (const [kind, key, target] of [
    ["metric", "metricsDir", project.metrics],
    ["dashboard", "dashboardsDir", project.dashboards],
    ["segment", "segmentsDir", project.segments],
  ] as const) {
    const dir = normalizePath(dirSetting(config, key));
    const listed = (await host.listFiles(dir)).sort();
    const root = dir === "" || dir === ".";
    const inDir = (name: string): string => (root ? name : `${dir}/${name}`);
    if (!root)
      for (const name of listed)
        if (UNREAD_EXTENSIONS.some((e) => name.endsWith(e))) flagUnread(inDir(name));
    for (const name of listed.filter((n) => n.endsWith(SPEC_EXTENSION))) {
      const file = inDir(name);
      const text = await host.readText(file);
      if (text === undefined) continue;
      const spec = parseSpecFile(kind, file, text);
      (target as Map<string, SpecFile>).set(spec.name, spec);
    }
  }

  const diagnostics: Diagnostic[] = [...unread];
  for (const [name, source] of Object.entries(config.spec?.sources ?? {})) {
    if (source.type === "lookup") continue;
    if (isDatabaseSource(source)) {
      diagnostics.push(...(await readDatabase(host, project, config.document, name, source)));
      continue;
    }
    if (GLOB_CHARACTERS.test(source.path)) continue;
    const file = normalizePath(source.path);
    if (await host.isFile(file)) {
      if (source.type === "csv" && source.header !== false) {
        const header = await readCsvHeader(host, file, source.delimiter ?? ",");
        if (header === "too-long") {
          const pointer = `/sources/${name}/path`;
          diagnostics.push({
            code: "HM2014",
            severity: "error",
            message: `the first record of "${source.path}" is longer than ${CSV_HEADER_LIMIT / 1024 / 1024} MiB`,
            file: CONFIG_FILE,
            pointer,
            ...config.document.locationOf(pointer),
            help: "check the delimiter and quoting, or set header: false",
            docs: docsCommand("HM2014"),
          });
        } else if (header !== undefined) {
          project.columns.set(name, header);
        }
      } else if (source.type !== "csv" && host.columns) {
        const columns = await host.columns(file, source).catch(() => undefined);
        if (columns !== undefined) project.columns.set(name, columns);
      }
      if (host.columnTypes && typedSources(project).has(name)) {
        const types = await host.columnTypes(file, source).catch(() => undefined);
        if (types !== undefined) project.columnTypes.set(name, types);
      }
      continue;
    }
    project.missingData.add(name);
    const pointer = `/sources/${name}/path`;
    diagnostics.push({
      code: "HM2010",
      severity: "error",
      message: `data file "${source.path}" for source "${name}" not found`,
      file: CONFIG_FILE,
      pointer,
      ...config.document.locationOf(pointer),
      docs: docsCommand("HM2010"),
    });
  }
  return { project, diagnostics };
}

const DATABASE_POINTERS: Record<string, string> = {
  HM2040: "env",
  HM2041: "env",
  HM2042: "table",
  HM2045: "timezone",
};

async function readDatabase(
  host: ProjectHost,
  project: Project,
  document: SpecDocument,
  name: string,
  source: DatabaseSource,
): Promise<Diagnostic[]> {
  if (host.database === undefined) return [];
  try {
    const schema = await host.database(name, source);
    project.databases.set(name, schema);
    project.columns.set(
      name,
      schema.columns.map((c) => c.name),
    );
    project.columnTypes.set(name, schema.columns);
    if (schema.origin !== "copy") return [];
    const pointer = `/sources/${name}/env`;
    return [
      {
        code: "HM2040",
        severity: "note",
        message: `${source.env} is not set; the columns of "${name}" are checked against the local copy fetched ${schema.stored_at ?? "earlier"}`,
        file: CONFIG_FILE,
        pointer,
        ...document.locationOf(pointer),
        help: `set ${source.env} to check against the database itself`,
        docs: docsCommand("HM2040"),
      },
    ];
  } catch (error) {
    const problem = error as Partial<DatabaseProblem>;
    const code =
      typeof problem.code === "string" && isDiagnosticCode(problem.code) ? problem.code : "HM2015";
    const key = DATABASE_POINTERS[code] ?? "";
    const pointer = `/sources/${name}${key !== "" && (key !== "table" || source.table !== undefined) ? `/${key}` : ""}`;
    project.missingData.add(name);
    return [
      {
        code,
        severity: code === "HM2040" ? "warning" : "error",
        message:
          code === "HM2040"
            ? `${problem.message ?? "credentials not set"}; the columns of "${name}" are not checked`
            : (problem.message ?? String(error)),
        file: CONFIG_FILE,
        pointer,
        ...document.locationOf(pointer),
        ...(problem.help !== undefined ? { help: problem.help } : {}),
        docs: docsCommand(code),
      },
    ];
  }
}

function typedSources(project: Project): Set<string> {
  const out = new Set<string>();
  const filters = [
    ...[...project.metrics.values()].flatMap((m) => {
      const spec = m.spec;
      return spec && (spec.type === "aggregate" || spec.type === "sql")
        ? (spec.filters ?? []).map((f) => ({ f, table: spec.table }))
        : [];
    }),
    ...[...project.metrics.values()].flatMap((m) => {
      const spec = m.spec;
      if (!spec || (spec.type !== "aggregate" && spec.type !== "sql")) return [];
      return (spec.segments ?? []).flatMap((s) =>
        (project.segments.get(s)?.spec?.filters ?? []).map((f) => ({ f, table: spec.table })),
      );
    }),
  ];
  for (const { f, table } of filters) {
    if (f.op !== "in_table" && f.op !== "not_in_table") continue;
    out.add(table);
    out.add(f.table);
  }
  for (const { spec } of project.metrics.values()) {
    if (spec?.type === "sql" && spec.additive && plainAggregate(spec.sql)?.fn === "sum") {
      out.add(spec.table);
    }
  }
  const toggled = [...project.dashboards.values()].flatMap((d) =>
    (d.spec?.filters ?? []).flatMap((filter) =>
      filter.type === "segment"
        ? filter.segments.flatMap((s) => project.segments.get(s)?.spec?.filters ?? [])
        : [],
    ),
  );
  for (const f of toggled) {
    if (f.op !== "in_table" && f.op !== "not_in_table") continue;
    out.add(f.table);
    for (const source of Object.keys(project.config.spec?.sources ?? {})) {
      const columns = project.columns.get(source);
      if (columns === undefined || hasColumn(columns, f.column)) out.add(source);
    }
  }
  return out;
}

/** The longest CSV header Hatchmark reads; a longer first record is an error, never a partial list. */
export const CSV_HEADER_LIMIT = 16 * 1024 * 1024;

async function readCsvHeader(
  host: ProjectHost,
  file: string,
  delimiter: string,
): Promise<string[] | "too-long" | undefined> {
  for (let bytes = 64 * 1024; ; bytes *= 4) {
    const head = await host.readHead(file, Math.min(bytes, CSV_HEADER_LIMIT));
    if (head === undefined) return undefined;
    const record = parseCsvRecord(head.text.replace(/^\ufeff/, ""), delimiter, head.complete);
    if (record !== undefined || head.complete) return record;
    if (bytes >= CSV_HEADER_LIMIT) return "too-long";
  }
}

/**
 * Parses the first record of CSV text (RFC 4180 quoting). Returns undefined when the record does
 * not end inside the text, unless the text is the whole file (atEnd), or when a quote is left open.
 */
export function parseCsvRecord(
  text: string,
  delimiter: string,
  atEnd = false,
): string[] | undefined {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        let end = text.indexOf('"', i);
        if (end === -1) end = text.length;
        field += text.slice(i, end);
        i = end - 1;
      }
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      fields.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      fields.push(field);
      return fields;
    } else {
      let end = i + 1;
      while (end < text.length) {
        const next = text[end];
        if (next === delimiter || next === "\n" || next === "\r") break;
        end++;
      }
      field += text.slice(i, end);
      i = end - 1;
    }
  }
  if (quoted || !atEnd) return undefined;
  fields.push(field);
  return fields;
}

/** Every diagnostic produced while parsing the project's files. */
export function parseDiagnostics(project: Project): Diagnostic[] {
  return [
    ...project.config.diagnostics,
    ...[...project.metrics.values()].flatMap((m) => m.diagnostics),
    ...[...project.dashboards.values()].flatMap((d) => d.diagnostics),
    ...[...project.segments.values()].flatMap((s) => s.diagnostics),
  ];
}

/** Source text by file, for rendering diagnostics with their source lines. */
export function projectSources(project: Project): Map<string, string> {
  const sources = new Map<string, string>([[project.config.file, project.config.document.text]]);
  for (const spec of [
    ...project.metrics.values(),
    ...project.dashboards.values(),
    ...project.segments.values(),
  ]) {
    sources.set(spec.file, spec.document.text);
  }
  return sources;
}
