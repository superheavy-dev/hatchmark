import { describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type {
  BarData,
  DashboardData,
  KpiData,
  LineData,
} from "../../src/compiler/dashboard-data.js";
import { chartRuntimeData, chartTable, describeChart } from "../../src/render/describe.js";
import { pageStyles, renderFragment, usesTargets } from "../../src/render/page.js";
import { attainment, chartTargets, kpiJudgement } from "../../src/render/target.js";
import { DEFAULT_THEME } from "../../src/render/theme.js";

function variant(name: string): DashboardData {
  const data = GALLERY.find((v) => v.variant === name)?.data;
  if (!data) throw new Error(`no gallery variant ${name}`);
  return data;
}
const ctx = (data: DashboardData) => ({ data, theme: DEFAULT_THEME, paint: { attrs: () => "" } });
const chart = <T extends LineData | BarData>(name: string) => {
  const data = variant(name);
  return { data, block: data.blocks[0] as T };
};
const count = (html: string, needle: string) => html.split(needle).length - 1;
const firstSvg = (data: DashboardData) => {
  const html = renderFragment(data);
  return html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
};
const kpiCards = (html: string) =>
  html
    .split('<div class="hm-kt"')
    .slice(1)
    .map((part) => part.slice(part.indexOf(">") + 1, part.indexOf("</div></div>")));

describe("chart targets", () => {
  it("draws a per-series target on a plain line and keeps the total out of an unstacked split", () => {
    const own = chart<LineData>("target-split-series");
    const targets = chartTargets(own.block, ctx(own.data));
    expect(targets?.tracks.map((t) => [t.label, t.drawn])).toEqual([
      ["North America FY plan", true],
      ["Europe FY plan", true],
      ["Asia-Pacific FY plan", true],
      ["Latin America FY plan", true],
      ["Total FY plan", false],
    ]);
  });

  it("draws only the total on a stacked area, and nothing on a chart stacked to 100%", () => {
    const { block, data } = chart<LineData>("target-split-total");
    expect(chartTargets(block, ctx(data))?.tracks.map((t) => t.drawn)).toEqual([true]);
    const percent = chartTargets({ ...block, percent: true }, ctx(data));
    expect(percent?.tracks.every((t) => !t.drawn)).toBe(true);
  });

  it("has no attainment against a target of zero or below", () => {
    expect(attainment(50, 100)).toBe(0.5);
    expect(attainment(50, 0)).toBeNull();
    expect(attainment(-50, -100)).toBeNull();
    expect(attainment(null, 100)).toBeNull();
  });

  it("judges attainment by the metric's better direction", () => {
    const t = { id: "plan", label: "Plan", metric: "m", value: 10, attainment: 1.2 };
    expect(kpiJudgement(t, "up")).toBe("ahead");
    expect(kpiJudgement(t, "down")).toBe("behind");
    expect(kpiJudgement(t, "neutral")).toBe("neutral");
    expect(kpiJudgement({ ...t, attainment: null }, "up")).toBeUndefined();
  });
});

describe("line and area targets", () => {
  it("draws the target as one dashed path with the key above the plot", () => {
    const html = firstSvg(variant("target-line"));
    expect(count(html, "hm-target")).toBe(1);
    expect(html).toContain('stroke-dasharray="6 3"');
    expect(html).toContain('class="hm-tkey"');
    expect(html).toContain(">FY plan<");
  });

  it("breaks the target path where the target has no value", () => {
    const html = firstSvg(variant("target-gaps"));
    const path = /<path d="([^"]+)"[^>]*hm-target/.exec(html)?.[1] ?? "";
    expect(count(path, "M")).toBe(2);
  });

  it("marks pace in the partial bucket and names it in the key", () => {
    const html = firstSvg(variant("target-pace"));
    expect(html).toContain("Pace to date");
    expect(count(html, 'stroke-width="1.5"/>')).toBeGreaterThanOrEqual(2);
  });

  it("says why a hidden target shows nothing", () => {
    const html = firstSvg(variant("target-hidden"));
    expect(html).not.toContain("hm-target");
    expect(html).toContain(
      "Quarterly plan not shown at this grain: it would split the target's buckets",
    );
  });
});

describe("bar targets", () => {
  it("draws a haloed tick on every bar that has a target", () => {
    const html = firstSvg(variant("target-bar-categories"));
    expect(count(html, "hm-target")).toBe(10);
  });

  it("puts each value label past the bar's target tick", () => {
    const { block, data } = chart<BarData>("target-bar-categories");
    const html = firstSvg(data);
    const ticks = [...html.matchAll(/<line x1="([\d.]+)"[^>]*hm-target/g)].map((m) => Number(m[1]));
    const labels = [...html.matchAll(/<text x="([\d.]+)"[^>]*>(\$[\d.]+K)</g)].map((m) =>
      Number(m[1]),
    );
    expect(ticks).toHaveLength(block.axis.kind === "category" ? block.axis.categories.length : 0);
    ticks.forEach((x, i) => {
      expect(labels[i]).toBeGreaterThan(x);
    });
  });

  it("draws a window target as one dashed rule with its pace", () => {
    const html = firstSvg(variant("target-bar-window"));
    expect(html).toContain("FY plan for the period");
    expect(count(html, 'stroke-dasharray="6 3"')).toBeGreaterThanOrEqual(2);
  });

  it("draws the total target over a stacked bar, not one per segment", () => {
    const { block, data } = chart<BarData>("target-bar-stacked");
    const html = firstSvg(data);
    expect(count(html, "hm-target")).toBe(block.series[0]?.values.length);
  });
});

describe("KPI targets", () => {
  it("keeps three rows in every state so cards line up", () => {
    for (const name of ["target-kpi-states", "target-kpi-edges"]) {
      const data = variant(name);
      const withTarget = data.blocks.filter((b) => (b as KpiData).target !== undefined).length;
      const cards = kpiCards(renderFragment(data));
      expect(cards).toHaveLength(withTarget);
      for (const card of cards) {
        expect(count(card, "hm-kt-row")).toBe(1);
        expect(count(card, "hm-kt-bar")).toBe(1);
        expect(count(card, "hm-kt-note")).toBe(1);
      }
    }
  });

  it("states ahead, behind and neutral by direction, and clamps the bar past 100%", () => {
    const html = renderFragment(variant("target-kpi-states"));
    const cards = kpiCards(html);
    expect([...html.matchAll(/class="hm-kt" data-hm-t="(\w+)"/g)].map((m) => m[1])).toEqual([
      "ahead",
      "behind",
      "ahead",
      "behind",
    ]);
    expect(cards[2]).toContain('style="width:100%"');
    expect(cards[2]).toContain("hm-kt-over");
    expect(cards[1]).toMatch(/style="width:9\d(\.\d)?%"/);
    expect(cards[1]).not.toContain("hm-kt-over");
    expect(cards[0]).toContain("of pace");
    expect(cards[3]).toContain("of target");
  });

  it("speaks the attainment once and hides the visual rows from assistive tech", () => {
    const [first] = kpiCards(renderFragment(variant("target-kpi-states")));
    expect(first).toContain(
      '<div class="hm-sr">Revenue is at 103% of pace, ahead; Pace $1.14M \u00B7 FY plan $1.86M</div>',
    );
    expect(count(first ?? "", 'aria-hidden="true"')).toBe(3);
  });

  it("explains each state without attainment in words", () => {
    const cards = kpiCards(renderFragment(variant("target-kpi-edges")));
    const text = cards.map((c) =>
      c
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(text[0]).toContain("Behind");
    expect(text[1]).toBe("FY plan hidden A segment is on that the target can't follow");
    expect(text[2]).toBe("FY plan hidden A filter is on that the target can't follow");
    expect(text[3]).toBe("No FY plan for this period");
    expect(text[4]).toBe("Target is zero or below Orders plan 0");
    expect(text[6]).toBe("Target is zero or below Loss ceiling \u2212$5,000");
  });
});

describe("target text alternatives", () => {
  it("describes the target at the last position, with pace and attainment", () => {
    const { block, data } = chart<LineData>("target-pace");
    expect(describeChart(block, ctx(data))).toMatch(
      /FY plan \$[\d,]+ in Week of Sep 21, 2026, pace \$[\d,]+, \d+% attained\.$/,
    );
  });

  it("adds a target table after the data table", () => {
    const { block, data } = chart<LineData>("target-pace");
    const html = chartTable(block, ctx(data), "Revenue");
    expect(html).toContain("<caption>Revenue: FY plan</caption>");
    expect(count(html, "<table>")).toBe(2);
  });

  it("gives the tooltip the target, pace and attainment at each position", () => {
    const { block, data } = chart<LineData>("target-pace");
    const runtime = chartRuntimeData(block, ctx(data));
    const [row] = runtime.targets ?? [];
    expect(row?.label).toBe("FY plan");
    expect(row?.text).toHaveLength(13);
    expect(row?.pace?.slice(-2)).toEqual(["", expect.stringMatching(/^\$[\d,]+$/)]);
    expect(row?.att?.at(-1)).toMatch(/^\d+%$/);
  });

  it("leaves the tooltip alone when the target is hidden", () => {
    const { block, data } = chart<LineData>("target-hidden");
    expect(chartRuntimeData(block, ctx(data)).targets).toBeUndefined();
  });
});

describe("target styles", () => {
  it("adds the target styles only to pages that have a target", () => {
    const assets = { fonts: {}, runtime: "" };
    expect(usesTargets(variant("target-line"))).toBe(true);
    expect(usesTargets(variant("line-incomplete-mark"))).toBe(false);
    expect(pageStyles(assets, DEFAULT_THEME)).not.toContain(".hm-kt{");
    expect(pageStyles(assets, DEFAULT_THEME, { targets: true })).toContain(".hm-kt{");
  });
});
