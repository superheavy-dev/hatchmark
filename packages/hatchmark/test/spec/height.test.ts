import { describe, expect, it } from "vitest";
import { checkReferences, parseSpecFile } from "../../src/spec/index.js";
import { HEIGHT_PRESETS, layoutItems } from "../../src/spec/layout.js";
import { fromYaml, toYaml } from "../yaml.js";
import { applyFix, DASHBOARD, projectFrom } from "./helpers.js";

const line = (extra: Record<string, unknown> = {}) => ({
  type: "line",
  metrics: ["revenue"],
  grain: "month",
  ...extra,
});
const table = (extra: Record<string, unknown> = {}) => ({
  type: "table",
  by: ["region"],
  metrics: ["revenue"],
  ...extra,
});

function parse(blocks: unknown[]) {
  const text = toYaml({ ...DASHBOARD, blocks });
  return { text, ...parseSpecFile("dashboard", "dashboards/x.yaml", text) };
}

function check(blocks: Record<string, unknown>[], code: string) {
  const project = projectFrom({ dashboards: { sales: { ...DASHBOARD, blocks } } });
  const text = project.dashboards.get("sales")?.document.text ?? "";
  return {
    text,
    found: checkReferences(project).filter((d) => d.code === code),
  };
}

describe("height presets in the schema", () => {
  it("accepts every preset on every block type that is built", () => {
    const blocks = HEIGHT_PRESETS.flatMap((height) => [
      { type: "kpi", metric: "revenue", height },
      line({ height }),
      { ...line({ height }), type: "area" },
      { type: "bar", metrics: ["orders"], by: "plan", height },
      { type: "pie", metric: "revenue", by: "region", height },
      { type: "donut", metric: "revenue", by: "region", height },
      { type: "scatter", x: "orders", y: "revenue", by: "region", height },
      table({ height }),
    ]);
    expect(parse(blocks).diagnostics).toEqual([]);
  });

  it.each([320, "320", "320px", " 410 PX "])(
    "rejects the pixel value %j, names the presets and offers the nearest",
    (value) => {
      const { text, diagnostics } = parse([line({ height: value })]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "HM3004",
        pointer: "/blocks/0/height",
        message: "height takes a preset name, not pixels",
        expected: ["compact", "default", "tall"],
        help: expect.stringContaining("compact (200 px for a chart on desktop)"),
        fix: { applicability: "unsafe" },
      });
      const nearest = Number.parseFloat(String(value)) > 340 ? "tall" : "default";
      expect(fromYaml(applyFix(text, diagnostics[0]?.fix)).blocks[0].height).toBe(nearest);
    },
  );

  it("rejects an unknown name with the presets, and fixes a near miss", () => {
    const { text, diagnostics } = parse([line({ height: "tal" })]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "HM3004",
        pointer: "/blocks/0/height",
        expected: ["compact", "default", "tall"],
      }),
    ]);
    expect(fromYaml(applyFix(text, diagnostics[0]?.fix)).blocks[0].height).toBe("tall");
    expect(parse([line({ height: "huge" })]).diagnostics[0]).toMatchObject({
      code: "HM3004",
      expected: ["compact", "default", "tall"],
    });
  });

  it.each(["text", "bar_list"])(
    "rejects height on a %s block, with a safe fix that removes it",
    (type) => {
      const block =
        type === "text"
          ? { type, height: "tall", markdown: "Revenue was {{revenue}}." }
          : { type, metric: "revenue", height: "tall", by: "region" };
      const { text, diagnostics } = parse([block]);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "HM3002",
          pointer: "/blocks/0/height",
          message: `a ${type} block takes no height`,
          fix: expect.objectContaining({ applicability: "safe" }),
        }),
      ]);
      const fixed = applyFix(text, diagnostics[0]?.fix);
      expect(fromYaml(fixed).blocks[0]).toEqual(
        Object.fromEntries(Object.entries(block).filter(([k]) => k !== "height")),
      );
      expect(parseSpecFile("dashboard", "dashboards/x.yaml", fixed).diagnostics).toEqual([]);
    },
  );

  it("removes height from a flow mapping, first or last", () => {
    for (const source of [
      "title: Sales\nblocks:\n  - {type: text, height: tall, markdown: Hi}\n",
      "title: Sales\nblocks:\n  - {height: tall, type: text, markdown: Hi}\n",
      "title: Sales\nblocks:\n  - {type: text, markdown: Hi, height: tall}\n",
      "title: Sales\nblocks:\n  - height: tall\n    type: text\n    markdown: Hi\n",
    ]) {
      const { diagnostics } = parseSpecFile("dashboard", "dashboards/x.yaml", source);
      const fixed = applyFix(source, diagnostics[0]?.fix);
      expect(fromYaml(fixed).blocks[0], source).toEqual({ type: "text", markdown: "Hi" });
    }
  });

  it("removes only the height line, keeping block scalars, comments and other blocks", () => {
    for (const [source, expected] of [
      [
        "title: Sales\nblocks:\n  - type: text\n    markdown: |+\n      Hello\n\n    height: tall\n  - type: text\n    markdown: Bye\n",
        "title: Sales\nblocks:\n  - type: text\n    markdown: |+\n      Hello\n\n  - type: text\n    markdown: Bye\n",
      ],
      [
        "title: Sales\nblocks:\n  - type: text\n    height: tall # too big\n    # the intro\n    markdown: Hi\n",
        "title: Sales\nblocks:\n  - type: text\n    # the intro\n    markdown: Hi\n",
      ],
      [
        "title: Sales\nblocks:\n  - type: text\n    markdown: |+\n      Hello\n\n    height: tall",
        "title: Sales\nblocks:\n  - type: text\n    markdown: |+\n      Hello\n\n",
      ],
    ] as const) {
      const { diagnostics } = parseSpecFile("dashboard", "dashboards/x.yaml", source);
      expect(applyFix(source, diagnostics[0]?.fix), source).toBe(expected);
    }
  });

  it("offers no safe fix when removing height would also remove a comment", () => {
    const source =
      "title: Sales\nblocks:\n  - height: tall\n    # the intro\n    type: text\n    markdown: Hi\n";
    const { diagnostics } = parseSpecFile("dashboard", "dashboards/x.yaml", source);
    expect(diagnostics.map((d) => [d.code, d.fix])).toEqual([["HM3002", undefined]]);
  });
});

describe("HM2031", () => {
  it("warns on height for a table with overflow: page, and the safe fix removes it", () => {
    const { text, found } = check([table({ overflow: "page", height: "compact" })], "HM2031");
    expect(found).toEqual([
      expect.objectContaining({
        severity: "warning",
        pointer: "/blocks/0/height",
        fix: expect.objectContaining({ applicability: "safe" }),
      }),
    ]);
    expect(fromYaml(applyFix(text, found[0]?.fix)).blocks[0]).toEqual(table({ overflow: "page" }));
  });

  it("is quiet for a scrolling table with a height, and for page without one", () => {
    expect(
      check(
        [
          table({ height: "tall" }),
          table({ overflow: "scroll", height: "compact" }),
          table({ overflow: "page" }),
        ],
        "HM2031",
      ).found,
    ).toEqual([]);
  });
});

describe("HM2028", () => {
  it("warns on charts in one grid row that are set lower than the tallest", () => {
    const { text, found } = check(
      [
        line({ span: 6, height: "compact" }),
        { type: "bar", metrics: ["orders"], by: "plan", span: 6, height: "tall" },
        line({ span: 4 }),
        line({ span: 4, height: "default" }),
        line({ span: 4 }),
      ],
      "HM2028",
    );
    expect(found.map((d) => [d.pointer, d.severity, d.message])).toEqual([
      [
        "/blocks/0/height",
        "warning",
        "this chart shares a grid row with a tall chart, so it is drawn tall on wide screens",
      ],
    ]);
    expect(found[0]?.fix?.applicability).toBe("unsafe");
    expect(fromYaml(applyFix(text, found[0]?.fix)).blocks[0].height).toBe("tall");
  });

  it("adds height to a chart that sets none when its row is drawn taller", () => {
    const { text, found } = check(
      [
        line({ span: 8 }),
        { type: "pie", metric: "revenue", by: "region", span: 4, height: "tall" },
      ],
      "HM2028",
    );
    expect(found.map((d) => d.pointer)).toEqual(["/blocks/0"]);
    expect(fromYaml(applyFix(text, found[0]?.fix)).blocks[0].height).toBe("tall");
  });

  it("warns on KPIs of one strip set lower than the tallest among them", () => {
    const { found } = check(
      [
        { type: "kpi", metric: "revenue", height: "tall" },
        { type: "kpi", metric: "orders" },
        { type: "kpi", metric: "orders", height: "tall" },
        line({ span: 12, height: "compact" }),
      ],
      "HM2028",
    );
    expect(found.map((d) => [d.pointer, d.message])).toEqual([
      [
        "/blocks/1",
        "KPIs in one strip are drawn at the tallest height among them, so this one is drawn tall",
      ],
    ]);
  });

  it("leaves tables, KPI strips and charts on their own rows alone", () => {
    expect(
      check(
        [
          { type: "kpi", metric: "revenue", height: "compact", span: 6 },
          line({ span: 6, height: "tall" }),
          table({ span: 6, height: "compact" }),
          line({ span: 6, height: "tall" }),
          line({ span: 8, height: "compact" }),
          line({ span: 8, height: "tall" }),
        ],
        "HM2028",
      ).found,
    ).toEqual([]);
  });
});

describe("layoutItems", () => {
  it("mirrors grid auto-placement and draws each chart row at its tallest preset", () => {
    const items = layoutItems([
      { type: "kpi", height: "compact" },
      { type: "kpi", height: "tall" },
      { type: "text" },
      { type: "kpi" },
      { type: "line", span: 2, height: "compact" },
      { type: "bar", span: 4 },
      { type: "table", span: 4, height: "tall" },
      { type: "pie", span: 4, height: "tall" },
      { type: "bar_list" },
      { type: "scatter", span: 9, height: "compact" },
    ]);
    expect(
      items.map(({ kind, blocks, span, row, alone, height }) => [
        kind,
        blocks,
        span,
        row,
        alone,
        height,
      ]),
    ).toEqual([
      ["strip", [0, 1, 3], 9, 0, false, "tall"],
      ["chart", [4], 3, 0, false, "compact"],
      ["chart", [5], 4, 1, false, "tall"],
      ["table", [6], 4, 1, false, "tall"],
      ["chart", [7], 4, 1, false, "tall"],
      ["chart", [9], 9, 2, true, "compact"],
    ]);
  });
});
