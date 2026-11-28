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
import { chartTargets, kpiJudgement } from "../../src/render/target.js";
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

  it("judges a KPI by comparing its value with the target directly", () => {
    const t = (value: number, pace?: number) => ({
      id: "plan",
      label: "Plan",
      value,
      ...(pace === undefined ? {} : { pace }),
      attainment: null,
    });
    expect(kpiJudgement(12, t(10), "up")).toBe("ahead");
    expect(kpiJudgement(12, t(10), "down")).toBe("behind");
    expect(kpiJudgement(-50, t(-100), "up")).toBe("ahead");
    expect(kpiJudgement(-150, t(-100), "up")).toBe("behind");
    expect(kpiJudgement(10, t(10), "down")).toBe("even");
    expect(kpiJudgement(10, t(10), "up")).toBe("even");
    expect(kpiJudgement(6, t(20, 5), "up")).toBe("ahead");
    expect(kpiJudgement(12, t(10), "neutral")).toBe("neutral");
    expect(kpiJudgement(null, t(10), "up")).toBeUndefined();
  });

  it("draws the total on a stacked chart of one series, and its own track without a total", () => {
    const { block, data } = chart<LineData>("target-area");
    const own = chartTargets({ ...block, stack: true }, ctx(data));
    expect(own?.tracks.map((t) => t.drawn)).toEqual([true]);
    const split = chart<BarData>("target-bar-stacked");
    const [first] = split.block.series;
    if (!first) throw new Error("no series");
    const single = chartTargets({ ...split.block, series: [first] }, ctx(split.data));
    expect(single?.tracks.map((t) => [t.series, t.drawn])).toEqual([[undefined, true]]);
  });

  it("draws no absolute window rule on a chart stacked to 100%", () => {
    const { block, data } = chart<BarData>("target-bar-window");
    const percent = { ...block, stack: true, percent: true as const };
    expect(chartTargets(percent, ctx(data))?.window?.drawn).toBe(false);
    const html = firstSvg({ ...data, blocks: [percent] });
    expect(html).not.toContain("hm-target");
    expect(html).not.toContain("for the period");
  });

  it("takes attainment from the data, not from the series it is drawn on", () => {
    const { block, data } = chart<BarData>("target-bar-window");
    const window = block.target?.window;
    if (!window) throw new Error("no window");
    const moved = {
      ...block,
      target: {
        ...block.target,
        id: "plan",
        label: "FY plan",
        metric: "revenue",
        window: { ...window, attainment: 0.5 },
      },
    };
    const runtime = chartRuntimeData(moved, ctx(data));
    expect(runtime.targets?.[0]?.att?.[0]).toBe("50%");
  });
});

describe("line and area targets", () => {
  it("draws the target over the actual line so equal values keep it visible", () => {
    const html = firstSvg(variant("target-line"));
    const actual = html.indexOf('stroke-width="1.75"');
    expect(actual).toBeGreaterThan(-1);
    expect(html.indexOf("hm-target")).toBeGreaterThan(actual);
  });

  it("carries target, pace and attainment in the pinned readout", () => {
    const { block, data } = chart<LineData>("target-pace");
    const html = renderFragment(data);
    const runtime = chartRuntimeData(block, ctx(data));
    const [row] = runtime.targets ?? [];
    expect(html).toContain('class="hm-rtv-0 ');
    expect(html).toContain(`>${row?.pace?.at(-1)}</text>`);
    expect(html).toContain(`>${row?.att?.at(-1)}</text>`);
    expect(html).toContain(">Attained<");
  });

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
    expect(text[4]).toBe(
      "Orders 38, ahead; Orders plan 0 Target is zero or below Ahead Orders plan 0",
    );
    expect(text[6]).toContain("Target is zero or below Behind");
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

  it("adds a window target's table to a category bar's screen-reader output", () => {
    const { block, data } = chart<BarData>("target-bar-window");
    const html = chartTable(block, ctx(data), "Revenue");
    expect(html).toContain("<caption>Revenue: FY plan for the period</caption>");
    expect(html).toMatch(
      /<th scope="col">Attained<\/th><\/tr><\/thead><tbody><tr><td>\$[\d,]+<\/td><td>\$[\d,]+<\/td><td>\d+%<\/td>/,
    );
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
