import { describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type {
  BarData,
  BlockData,
  DashboardData,
  LineData,
  TableData,
} from "../../src/compiler/dashboard-data.js";
import {
  cssPaint,
  DEFAULT_THEME,
  LAYOUTS,
  type RenderContext,
  renderBlocks,
  renderChartSvg,
} from "../../src/render/index.js";
import type { HeightPreset } from "../../src/spec/layout.js";

const entry = (variant: string) => {
  const found = GALLERY.find((v) => v.variant === variant);
  if (found === undefined) throw new Error(`gallery variant ${variant} missing`);
  return found.data;
};
const ctx = (data: DashboardData): RenderContext => ({
  data,
  theme: DEFAULT_THEME,
  paint: cssPaint,
});
const html = (data: DashboardData, blocks: BlockData[]) => renderBlocks(blocks, ctx(data));

/** Height of the SVG drawn for each layout of one chart card, by layout index. */
function svgHeights(markup: string, id: string): number[] {
  const card = markup.slice(markup.indexOf(`data-hm-chart="${id}"`));
  const heights: number[] = [];
  for (const m of card.matchAll(/<div class="hm-v ([^"]+)"><svg[^>]* height="([\d.]+)"/g)) {
    if (m.index > card.indexOf("</figure>")) break;
    for (const l of (m[1] as string).split(" ")) heights[Number(l.slice(4))] = Number(m[2]);
  }
  return heights;
}

const tokens = DEFAULT_THEME.height;
const line = entry("height-line").blocks[0] as LineData;
const plain = { ...line, id: "plain", span: 12 } as LineData;
delete plain.height;

describe("height presets", () => {
  it("draws height: default byte for byte like no height", () => {
    const data = entry("height-line");
    expect(html(data, [{ ...plain, height: "default" }])).toBe(html(data, [plain]));
    const { height: _, ...table } = entry("height-table").blocks[0] as TableData;
    const shared = { ...table, span: 6 };
    const beside = { ...plain, span: 6 };
    expect(html(data, [{ ...shared, height: "default" }, beside])).toBe(
      html(data, [shared, beside]),
    );
  });

  it("draws a lone chart at its preset in every layout, desktop and phone values apart", () => {
    for (const [variant, extra] of [
      ["height-scatter", 32],
      ["height-bar", 0],
    ] as const) {
      const data = entry(variant);
      for (const block of data.blocks) {
        const preset = block.height ?? "default";
        const heights = svgHeights(html(data, [block]), block.id);
        LAYOUTS.forEach((layout, i) => {
          const plot = tokens[preset][layout.mobile ? "phone" : "desktop"].chart;
          expect(heights[i], `${block.id} layout ${i}`).toBe(plot + extra);
        });
      }
    }
  });

  it("grows a pie with a taller preset", () => {
    const data = entry("height-pie");
    const radius = (block: BlockData) =>
      Number(/data-hm-pie="[^,]+,[^,]+,[^,]+,([\d.]+)"/.exec(html(data, [block]))?.[1]);
    const [compact, standard, tall] = data.blocks.map(radius);
    expect(compact).toBeLessThan(standard as number);
    expect(standard).toBe(120);
    expect(tall).toBeGreaterThan(standard as number);
  });

  it("draws the charts of one grid row at its tallest preset on wide layouts only", () => {
    const data = entry("height-row");
    const markup = html(data, data.blocks);
    const [lineBlock, barBlock] = data.blocks as [LineData, LineData];
    const lineHeights = svgHeights(markup, lineBlock.id);
    const alone = (height: "compact" | "tall") =>
      svgHeights(html(data, [{ ...lineBlock, height }]), lineBlock.id);
    const [asTall, asCompact] = [alone("tall"), alone("compact")];
    LAYOUTS.forEach((layout, i) => {
      expect(lineHeights[i], `layout ${i}`).toBe(layout.grid ? asTall[i] : asCompact[i]);
      expect(lineHeights[i]).not.toBe(layout.grid ? asCompact[i] : asTall[i]);
    });
    expect(svgHeights(markup, barBlock.id)[0]).toBe(tokens.tall.desktop.chart);
  });

  it("sizes a KPI strip at its tallest KPI's preset on wide screens and each KPI at its own below", () => {
    const strip = (variant: string) => html(entry(variant), entry(variant).blocks);
    expect(strip("height-kpi-default")).not.toContain("data-hm-height");
    expect(strip("height-kpi-default")).not.toContain("<style>");
    const mixed = strip("height-strip");
    expect(mixed).toContain(
      '<section class="hm-strip" style="--span:12" aria-label="Key metrics" data-hm-height="tall">',
    );
    expect(
      mixed.match(/<div class="hm-kpi"[^>]*>/g)?.map((t) => /data-hm-height="(\w+)"/.exec(t)?.[1]),
    ).toEqual(["compact", "tall", undefined, "compact"]);
    expect(mixed).toContain(
      `@container hm (max-width:599.98px){.hm-kpi[data-hm-height=compact] .hm-kpi-value{font-size:${tokens.compact.phone.kpiSize}px`,
    );
    expect(mixed).toContain(
      `@container hm (min-width:1024px){.hm-strip[data-hm-height=tall] .hm-kpi .hm-kpi-value{font-size:${tokens.tall.desktop.kpiSize}px`,
    );
    expect(mixed.match(/<style>/g)).toHaveLength(3);
    const uniform = strip("height-kpi-tall");
    expect(uniform).not.toContain("min-width:1024px){.hm-strip");
    expect(uniform.match(/<style>/g)).toHaveLength(1);
  });

  it("scrolls a table with a height past its preset's rows, even alone in its row", () => {
    const data = entry("height-table");
    const [compact, standard, tall] = data.blocks as TableData[];
    const short = (block: TableData, rows: number) => ({
      ...block,
      rows: block.rows.slice(0, rows),
    });
    const wrap = (block: TableData) =>
      /<div class="hm-table-wrap([^"]*)"([^>]*)>/.exec(html(data, [block]))?.slice(1);
    expect(wrap(compact as TableData)).toEqual([
      " hm-tall",
      ' data-hm-height="compact" tabindex="0" role="region" aria-labelledby="hm-states_compact-t"',
    ]);
    expect(wrap(short(compact as TableData, 8))?.[0]).toBe(" hm-tall");
    expect(wrap(short(compact as TableData, 7))?.[0]).toBe("");
    expect(wrap(standard as TableData)?.[0]).toBe(" hm-tall");
    expect(wrap(short(tall as TableData, 25))?.[0]).toBe(" hm-tall");
    expect(wrap(short(tall as TableData, 18))?.[0]).toBe("");
    const { height: _, ...unset } = standard as TableData;
    expect(wrap(unset)?.[0]).toBe(" hm-tall hm-grow");
    expect(wrap({ ...(compact as TableData), overflow: "page" })).toEqual([
      " hm-tall hm-grow",
      ' tabindex="0" role="region" aria-labelledby="hm-states_compact-t"',
    ]);
    const row = DEFAULT_THEME.density.tableRow;
    const body = row - 4 + Math.round(tokens.compact.desktop.tableRows * row);
    expect((compact as TableData).total).toBeDefined();
    expect(html(data, [compact as TableData])).toContain(
      `.hm-table-wrap[data-hm-height=compact].hm-tall{max-height:${body + row}px}`,
    );
    const { total: __, ...untotalled } = compact as TableData;
    expect(html(data, [untotalled])).toContain(
      `.hm-table-wrap[data-hm-height=compact].hm-tall.hm-nofoot{max-height:${body}px}`,
    );
    expect(wrap(untotalled)?.[0]).toBe(" hm-tall hm-nofoot");
    const { height: ___, ...legacy } = untotalled;
    const plain = html(data, [{ ...legacy, overflow: "scroll" }]);
    expect(plain).not.toContain("hm-nofoot");
    expect(plain).not.toContain("data-hm-height");
  });

  it("stretches horizontal bar rows within each preset's limits", () => {
    const data = entry("height-bar-horizontal");
    const [base] = data.blocks as BarData[];
    const rows = (block: BarData, n: number): BarData => {
      if (block.axis.kind !== "category") throw new Error("category axis expected");
      const names = Array.from({ length: n }, (_, i) => `Country ${i + 1}`);
      return {
        ...block,
        axis: { ...block.axis, categories: names },
        series: block.series.map((s) => ({ ...s, values: names.map((_, i) => 1000 * (n - i)) })),
      };
    };
    const drawn = (n: number, height: HeightPreset, device: "desktop" | "phone") =>
      Number(
        /height="(\d+)"/.exec(
          renderChartSvg({ ...rows(base as BarData, n), height }, data, { width: 900, device }),
        )?.[1],
      );
    const expected: Record<number, Record<HeightPreset, [number, number]>> = {
      5: { compact: [150, 150], default: [180, 180], tall: [240, 240] },
      10: { compact: [220, 220], default: [280, 280], tall: [400, 320] },
      20: { compact: [440, 440], default: [560, 560], tall: [560, 560] },
    };
    for (const [n, presets] of Object.entries(expected)) {
      for (const [height, [desktop, phone]] of Object.entries(presets)) {
        const label = `${n} rows, ${height}`;
        expect(drawn(Number(n), height as HeightPreset, "desktop"), label).toBe(desktop);
        expect(drawn(Number(n), height as HeightPreset, "phone"), label).toBe(phone);
      }
    }
  });

  it("renders a standalone SVG at the block's preset for desktop and phone", () => {
    const data = entry("height-line");
    for (const block of data.blocks as LineData[]) {
      for (const device of ["desktop", "phone"] as const) {
        const svg = renderChartSvg(block, data, { width: 900, device });
        expect(/height="(\d+)"/.exec(svg)?.[1]).toBe(
          String(tokens[block.height ?? "default"][device].chart),
        );
      }
    }
  });
});
