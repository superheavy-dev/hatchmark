import { describe, expect, it } from "vitest";
import {
  checkReferences,
  loadProject,
  type ProjectHost,
  parseCsvRecord,
  parseDiagnostics,
} from "../../src/spec/index.js";
import { CONFIG, METRICS, projectFrom } from "./helpers.js";

const config = {
  ...CONFIG,
  sources: { ...CONFIG.sources, sessions: { type: "csv", path: "data/sessions.csv" } },
};
const metrics = {
  ...METRICS,
  sessions: {
    label: "Sessions",
    type: "aggregate",
    table: "sessions",
    aggregate: "count",
    time: "started_at",
    format: { type: "number" },
    better: "up",
  },
  conversion: {
    label: "Conversion rate",
    type: "ratio",
    numerator: "orders",
    denominator: "sessions",
    format: { type: "percent", decimals: 1 },
    better: "up",
  },
  order_count: {
    label: "Orders",
    type: "aggregate",
    table: "orders",
    aggregate: "count",
    format: { type: "number" },
    better: "up",
  },
  revenue_per_order: {
    label: "Revenue per order",
    type: "ratio",
    numerator: "revenue",
    denominator: "order_count",
    format: { type: "currency" },
    better: "up",
  },
};
const period = { asOf: "2026-11-15", range: "last_12_months", compare: "none" };
const filters = [{ type: "select", id: "region", column: "region" }];

function diagnostics(dashboard: unknown, columns?: Record<string, string[]>) {
  const project = projectFrom({
    config,
    metrics,
    dashboards: { sales: dashboard },
    ...(columns ? { columns } : {}),
  });
  return [...parseDiagnostics(project), ...checkReferences(project)].filter(
    (d) => d.file === "dashboards/sales.json",
  );
}

function metricDiagnostics() {
  const project = projectFrom({ config, metrics, dashboards: {} });
  return checkReferences(project);
}

describe("ratio scope", () => {
  it("B1: rejects a filter that would bind to one side of a cross-source ratio", () => {
    const dashboard = {
      title: "Funnel",
      period,
      filters,
      blocks: [{ type: "kpi", metric: "conversion" }],
    };
    const known = diagnostics(dashboard, {
      orders: ["region", "ordered_at"],
      sessions: ["started_at"],
    });
    expect(known.map((d) => [d.code, d.pointer])).toEqual([["HM2013", "/blocks/0"]]);
    expect(known[0]?.message).toBe(
      'filter "region" would apply to orders but not to sessions in this block',
    );
    const unknown = diagnostics(dashboard);
    expect(unknown.map((d) => d.code)).toEqual(["HM2013"]);
    expect(unknown[0]?.message).toContain("cannot confirm");
  });

  it("B1: accepts the filter when every source has the column, or none does", () => {
    const dashboard = {
      title: "Funnel",
      period,
      filters,
      blocks: [{ type: "kpi", metric: "conversion" }],
    };
    expect(diagnostics(dashboard, { orders: ["region"], sessions: ["region"] })).toEqual([]);
    expect(diagnostics(dashboard, { orders: ["x"], sessions: ["y"] })).toEqual([]);
  });

  it("B1: checks multi-source line charts and text blocks too", () => {
    const dashboard = {
      title: "Funnel",
      period,
      filters,
      blocks: [
        { type: "line", metrics: ["orders", "sessions"], grain: "week" },
        { type: "text", markdown: "{{orders}} from {{sessions}}" },
        { type: "kpi", metric: "orders" },
      ],
    };
    const ds = diagnostics(dashboard, { orders: ["region"], sessions: [] });
    expect(ds.map((d) => [d.code, d.pointer])).toEqual([
      ["HM2013", "/blocks/0"],
      ["HM2013", "/blocks/1"],
    ]);
  });

  it("B2: rejects a ratio whose sides disagree on time, wherever it is used", () => {
    const ds = metricDiagnostics();
    expect(ds.map((d) => [d.file, d.code, d.pointer])).toEqual([
      ["metrics/revenue_per_order.json", "HM2012", "/denominator"],
    ]);
  });
});

describe("parseCsvRecord", () => {
  it("reads quoted headers, custom delimiters and CRLF", () => {
    expect(parseCsvRecord('a,"b,c","d""e"\r\n1,2,3', ",")).toEqual(["a", "b,c", 'd"e']);
    expect(parseCsvRecord("x;y\n", ";")).toEqual(["x", "y"]);
    expect(parseCsvRecord('"open', ",", true)).toBeUndefined();
    expect(parseCsvRecord("a,b", ",")).toBeUndefined();
    expect(parseCsvRecord("a,b", ",", true)).toEqual(["a", "b"]);
  });

  it("matches a character-at-a-time RFC 4180 reader on random short records", () => {
    const oracle = (text: string, delimiter: string, atEnd: boolean) => {
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
      if (quoted || !atEnd) return undefined;
      fields.push(field);
      return fields;
    };
    const alphabet = ["a", "b", ",", ";", '"', '"', "\n", "\r", " "];
    let seed = 7;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return Math.floor((seed / 2147483648) * n);
    };
    const mismatches: string[] = [];
    for (let k = 0; k < 20_000; k++) {
      const text = Array.from({ length: random(13) }, () => alphabet[random(alphabet.length)]).join(
        "",
      );
      for (const delimiter of [",", ";"]) {
        for (const atEnd of [false, true]) {
          const got = parseCsvRecord(text, delimiter, atEnd);
          const want = oracle(text, delimiter, atEnd);
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            mismatches.push(
              `${JSON.stringify(text)} ${delimiter} ${atEnd}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
            );
          }
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("reads a CSV header longer than one read, so HM2013 sees every column", async () => {
    const head = `${"x".repeat(65535)},region\n1,West\n`;
    const files: Record<string, string> = {
      "hatchmark.json": JSON.stringify({
        ...CONFIG,
        sources: {
          orders: { type: "csv", path: "orders.csv" },
          sessions: { type: "csv", path: "sessions.csv" },
        },
      }),
      "metrics/orders.json": JSON.stringify({
        ...(metrics.order_count as object),
        table: "orders",
      }),
      "metrics/sessions.json": JSON.stringify({ ...(metrics.sessions as object), time: undefined }),
      "dashboards/sales.json": JSON.stringify({
        title: "Sales",
        filters,
        blocks: [{ type: "table", by: ["x"], metrics: ["orders", "sessions"] }],
      }),
      "orders.csv": head,
      "sessions.csv": "x\n1\n",
    };
    const host: ProjectHost = {
      label: "memory",
      readText: async (f) => files[f],
      isFile: async (f) => f in files,
      listFiles: async (d) =>
        Object.keys(files)
          .filter((f) => f.startsWith(`${d}/`))
          .map((f) => f.slice(d.length + 1)),
      readHead: async (f, n) => {
        const text = files[f];
        return text === undefined
          ? undefined
          : { text: text.slice(0, n), complete: text.length <= n };
      },
    };
    const { project } = await loadProject(host);
    if (!project) throw new Error("no project");
    expect(project.columns.get("orders")).toEqual(["x".repeat(65535), "region"]);
    expect(project.columns.get("sessions")).toEqual(["x"]);
    expect(checkReferences(project).map((d) => d.code)).toEqual(["HM2013"]);

    files["orders.csv"] = "y".repeat(17 * 1024 * 1024);
    const tooLong = await loadProject(host);
    expect(tooLong.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["HM2014", "/sources/orders/path"],
    ]);
    expect(tooLong.project?.columns.has("orders")).toBe(false);
  });
});
