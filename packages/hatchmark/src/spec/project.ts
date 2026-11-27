import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import {
  type Diagnostic,
  docsCommand,
  type JsonDocument,
  parseJsonFile,
} from "../diagnostics/index.js";
import { IDENTIFIER_PATTERN } from "./common.js";
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
  const name = path.posix.basename(file, ".json");
  const { document, diagnostics } = parseJsonFile(file, text);
  const result: SpecFile<K> = { kind, name, file, document, diagnostics };
  if (kind !== "project") {
    const pattern = kind === "metric" ? IDENTIFIER_PATTERN : DASHBOARD_NAME_PATTERN;
    if (!pattern.test(name)) {
      diagnostics.push({
        code: "HM1004",
        severity: "error",
        message: `invalid ${kind} file name "${path.posix.basename(file)}"`,
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

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function dirSetting(config: SpecFile<"project">, key: "metricsDir" | "dashboardsDir"): string {
  if (config.spec) return config.spec[key];
  const raw = (config.document.value as Record<string, unknown> | undefined)?.[key];
  return typeof raw === "string" ? raw : PROJECT_DEFAULTS[key];
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Reads hatchmark.json, every metric and dashboard file, and checks that each source's data file
 * exists. Returns undefined for the project when there is no config file.
 */
export async function loadProject(
  root: string,
): Promise<{ project?: Project; diagnostics: Diagnostic[] }> {
  const configText = await readText(path.join(root, CONFIG_FILE));
  if (configText === undefined) {
    return {
      diagnostics: [
        {
          code: "HM1005",
          severity: "error",
          message: `no ${CONFIG_FILE} in ${root}`,
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
  };

  for (const [kind, key, target] of [
    ["metric", "metricsDir", project.metrics],
    ["dashboard", "dashboardsDir", project.dashboards],
  ] as const) {
    const dir = dirSetting(config, key);
    for (const name of await listJson(path.join(root, dir))) {
      const file = toPosix(path.posix.join(toPosix(dir), name));
      const text = await readText(path.join(root, dir, name));
      if (text === undefined) continue;
      const spec = parseSpecFile(kind, file, text);
      (target as Map<string, SpecFile>).set(spec.name, spec);
    }
  }

  const diagnostics: Diagnostic[] = [];
  for (const [name, source] of Object.entries(config.spec?.sources ?? {})) {
    const exists = await stat(path.join(root, source.path)).then(
      (s) => s.isFile(),
      () => false,
    );
    if (exists) continue;
    project.missingData.add(name);
    const pointer = `/sources/${name}/path`;
    const range = config.document.rangeOf(pointer);
    diagnostics.push({
      code: "HM2010",
      severity: "error",
      message: `data file "${source.path}" for source "${name}" not found`,
      file: CONFIG_FILE,
      pointer,
      ...(range ? { range } : {}),
      docs: docsCommand("HM2010"),
    });
  }
  return { project, diagnostics };
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
