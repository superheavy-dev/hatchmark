import type { z } from "zod";
import {
  type Diagnostic,
  docsCommand,
  type JsonDocument,
  parseJsonFile,
} from "../diagnostics/index.js";
import { IDENTIFIER_PATTERN, normalizePath } from "./common.js";
import { PROJECT_DEFAULTS, type ProjectConfig, projectConfigSchema } from "./config.js";
import { type Dashboard, dashboardSchema } from "./dashboard.js";
import { type Metric, metricSchema } from "./metric.js";
import { issuesToDiagnostics } from "./zod-diagnostics.js";

export const CONFIG_FILE = "hatchmark.json";
const DASHBOARD_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type SpecKind = "project" | "metric" | "dashboard";

interface SpecTypes {
  project: ProjectConfig;
  metric: Metric;
  dashboard: Dashboard;
}

const schemas: { [K in SpecKind]: z.ZodType<SpecTypes[K]> } = {
  project: projectConfigSchema,
  metric: metricSchema,
  dashboard: dashboardSchema,
};

export const SPEC_SCHEMAS = schemas;

/** One parsed spec file. spec is set only when the file parsed and passed its schema. */
export interface SpecFile<K extends SpecKind = SpecKind> {
  kind: K;
  /** Metric or dashboard name: the file name without .json. */
  name: string;
  /** Project-relative path with forward slashes. */
  file: string;
  document: JsonDocument;
  spec?: SpecTypes[K];
  diagnostics: Diagnostic[];
}

export interface Project {
  config: SpecFile<"project">;
  metrics: Map<string, SpecFile<"metric">>;
  dashboards: Map<string, SpecFile<"dashboard">>;
  /** Source names whose data file is missing; filled by loadProject. */
  missingData: Set<string>;
  /**
   * Column names by source, where they are known without a query engine: CSV headers today.
   * A source missing from the map has unknown columns.
   */
  columns: Map<string, string[]>;
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
  const name = base.endsWith(".json") ? base.slice(0, -".json".length) : base;
  const { document, diagnostics } = parseJsonFile(file, text);
  const result: SpecFile<K> = { kind, name, file, document, diagnostics };
  if (kind !== "project") {
    const pattern = kind === "metric" ? IDENTIFIER_PATTERN : DASHBOARD_NAME_PATTERN;
    if (!pattern.test(name)) {
      diagnostics.push({
        code: "HM1004",
        severity: "error",
        message: `invalid ${kind} file name "${base}"`,
        file,
        help:
          kind === "metric"
            ? "metric names are lowercase snake_case, such as net_revenue.json"
            : "dashboard names are lowercase letters, digits, _ and -, such as sales-overview.json",
        docs: docsCommand("HM1004"),
      });
    }
  }
  if (document.root === undefined || diagnostics.some((d) => d.code === "HM1002")) return result;
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
  /** Up to the first bytes of a file decoded as UTF-8, or undefined when it cannot be read. */
  readHead(file: string, bytes: number): Promise<string | undefined>;
}

function dirSetting(config: SpecFile<"project">, key: "metricsDir" | "dashboardsDir"): string {
  if (config.spec) return config.spec[key];
  const raw = (config.document.value as Record<string, unknown> | undefined)?.[key];
  return typeof raw === "string" ? raw : PROJECT_DEFAULTS[key];
}

/**
 * Reads hatchmark.json, every metric and dashboard file, and checks that each source's data file
 * exists. Returns undefined for the project when there is no config file.
 */
export async function loadProject(
  host: ProjectHost,
): Promise<{ project?: Project; diagnostics: Diagnostic[] }> {
  const configText = await host.readText(CONFIG_FILE);
  if (configText === undefined) {
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
    missingData: new Set(),
    columns: new Map(),
  };

  for (const [kind, key, target] of [
    ["metric", "metricsDir", project.metrics],
    ["dashboard", "dashboardsDir", project.dashboards],
  ] as const) {
    const dir = normalizePath(dirSetting(config, key));
    const names = (await host.listFiles(dir)).filter((n) => n.endsWith(".json")).sort();
    for (const name of names) {
      const file = dir === "" || dir === "." ? name : `${dir}/${name}`;
      const text = await host.readText(file);
      if (text === undefined) continue;
      const spec = parseSpecFile(kind, file, text);
      (target as Map<string, SpecFile>).set(spec.name, spec);
    }
  }

  const diagnostics: Diagnostic[] = [];
  for (const [name, source] of Object.entries(config.spec?.sources ?? {})) {
    const file = normalizePath(source.path);
    if (await host.isFile(file)) {
      if (source.type === "csv" && source.header !== false) {
        const head = await host.readHead(file, 64 * 1024);
        const header =
          head === undefined
            ? undefined
            : parseCsvRecord(head.replace(/^\ufeff/, ""), source.delimiter ?? ",");
        if (header) project.columns.set(name, header);
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

/** Parses the first record of CSV text (RFC 4180 quoting); undefined when a quote is left open. */
export function parseCsvRecord(text: string, delimiter: string): string[] | undefined {
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
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      fields.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      fields.push(field);
      return fields;
    } else field += ch;
  }
  if (quoted) return undefined;
  fields.push(field);
  return fields;
}

/** Every diagnostic produced while parsing the project's files. */
export function parseDiagnostics(project: Project): Diagnostic[] {
  return [
    ...project.config.diagnostics,
    ...[...project.metrics.values()].flatMap((m) => m.diagnostics),
    ...[...project.dashboards.values()].flatMap((d) => d.diagnostics),
  ];
}

/** Source text by file, for rendering diagnostics with their source lines. */
export function projectSources(project: Project): Map<string, string> {
  const sources = new Map<string, string>([[project.config.file, project.config.document.text]]);
  for (const spec of [...project.metrics.values(), ...project.dashboards.values()]) {
    sources.set(spec.file, spec.document.text);
  }
  return sources;
}
