import { describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { DashboardData, KpiData, LineData } from "../../src/compiler/dashboard-data.js";
import { chartRuntimeData, chartTable, describeChart } from "../../src/render/describe.js";
import { renderFragment } from "../../src/render/page.js";
import { partialBar, partialPositions } from "../../src/render/partial.js";
import { DEFAULT_THEME } from "../../src/render/theme.js";

function variant(name: string): { block: LineData; data: DashboardData } {
  const data = GALLERY.find((v) => v.variant === name)?.data;
  if (!data) throw new Error(`no gallery variant ${name}`);
  return { block: data.blocks[0] as LineData, data };
}
const ctx = (data: DashboardData) => ({ data, theme: DEFAULT_THEME, paint: { attrs: () => "" } });

describe("partial buckets", () => {
  it("reads the trailing partial week: the days the data covers, of the week's seven", () => {
    const { block, data } = variant("line-incomplete-mark");
    const last = block.axis.kind === "time" ? block.axis.buckets.length - 1 : -1;
    expect([...partialPositions(block, ctx(data))]).toEqual([
      [
        last,
        { from: "2026-09-21", to: "2026-09-24", days: 3, of: 7, point: false, complete: false },
      ],
    ]);
  });

  it("gives the tooltip a date line and a status line; one line in the readout, table and description", () => {
    const { block, data } = variant("line-incomplete-mark");
    const runtime = chartRuntimeData(block, ctx(data));
    expect(runtime.headers.slice(-2)).toEqual(["Week of Sep 14, 2026", "Sep 21\u201323"]);
    expect(runtime.status?.slice(-2)).toEqual(["", "In progress \u00B7 3 of 7 days"]);
    expect(runtime.heads).toBeUndefined();
    expect(chartTable(block, ctx(data), "c")).toContain(
      '<th scope="row">Sep 21\u201323 \u00B7 in progress (3 of 7 days)</th>',
    );
    expect(describeChart(block, ctx(data))).toContain(
      "Sep 21\u201323 \u00B7 in progress (3 of 7 days).",
    );
  });

  it("names a clipped first week a partial week, from the window's start", () => {
    const { block, data } = variant("line-edges-clip");
    const runtime = chartRuntimeData(block, ctx(data));
    expect(runtime.headers[0]).toBe("Jul 1\u20135");
    expect(runtime.status?.[0]).toBe("Partial week \u00B7 5 of 7 days");
    expect(runtime.heads).toBeUndefined();
    expect(describeChart(block, ctx(data))).toContain(
      "Jul 1\u20135 \u00B7 partial week (5 of 7 days).",
    );
  });

  it("labels the covered days by the token rules: across months, and another year than the as-of", () => {
    const { block, data } = variant("line-incomplete-mark");
    if (block.axis.kind !== "time") throw new Error("unexpected variant");
    const moved = (buckets: string[], asOf: string) => {
      const b = { ...block, axis: { ...block.axis, buckets } };
      return chartRuntimeData(b, ctx({ ...data, asOf })).headers.at(-1);
    };
    const shifted = block.axis.buckets.map((_, i, all) => all[i] as string);
    expect(moved(shifted, "2027-01-04")).toBe("Sep 21\u201323, 2026");
  });

  it("names a point-in-time metric's partial bucket as of the horizon, not in progress", () => {
    const { block, data } = variant("line-incomplete-mark");
    const metric = block.series[0]?.metric ?? "";
    const info = data.metrics[metric];
    if (!info || block.axis.kind !== "time") throw new Error("unexpected variant");
    const point: DashboardData = {
      ...data,
      metrics: { ...data.metrics, [metric]: { ...info, nature: "point" } },
    };
    const atTime = {
      ...block,
      series: block.series.map((s) => ({
        ...s,
        partial: (s.partial ?? []).map((p) => ({ ...p, through: "2026-09-23T14:03:00" })),
      })),
    };
    const timed = chartRuntimeData(atTime, ctx(point));
    expect(timed.headers.at(-1)).toBe("Week of Sep 21, 2026");
    expect(timed.status?.at(-1)).toMatch(/^As of Sep 23, 2026, 2:03\sPM$/);
    expect(chartRuntimeData(block, ctx(point)).status?.at(-1)).toBe("As of Sep 23, 2026");
    expect(describeChart(block, ctx(point))).toContain(
      "Week of Sep 21, 2026 \u00B7 as of Sep 23, 2026.",
    );
  });

  it("adds no status line when nothing is partial", () => {
    const { block, data } = variant("line-incomplete-hide");
    expect(chartRuntimeData(block, ctx(data)).status).toBeUndefined();
  });
});

describe("partial buckets drawn (option B)", () => {
  const svg = (name: string) => {
    const data = GALLERY.find((v) => v.variant === name)?.data;
    if (!data) throw new Error(`no gallery variant ${name}`);
    return renderFragment(data);
  };
  const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;
  const charts = (html: string) => count(html, /<svg/g);

  it("hatches the slot behind a partial line point and draws the point hollow", () => {
    const html = svg("line-incomplete-mark");
    expect(count(html, /<pattern id="hm-p-/g)).toBeGreaterThan(0);
    expect(count(html, /class="hm-pr"/g)).toBe(charts(html));
    expect(count(html, /<circle[^>]* r="3.5"[^>]*stroke-width="1.75"/g)).toBe(charts(html));
    expect(html).not.toMatch(/stroke-dasharray/);
  });

  it("hatches a partial area slice in the series colour, with no flat fill there", () => {
    const html = svg("area-incomplete-mark");
    expect(count(html, /clip-path="url\(#hm-p-[^)]*-whole0\)"/g)).toBe(charts(html));
    expect(
      count(html, /fill="url\(#hm-p-[^)]*-c1\)"[^>]*clip-path="url\(#hm-p-[^)]*-part0\)"/g),
    ).toBe(charts(html));
  });

  it("tints, hatches and outlines every part of a partial stack, square-cornered", () => {
    const html = svg("bar-incomplete-stacked");
    for (const c of ["c1", "c2", "c3"]) {
      expect(count(html, new RegExp(`fill="url\\(#hm-p-[^)]*-${c}\\)"`, "g")), c).toBe(
        charts(html),
      );
    }
    expect(count(html, /fill-opacity="0.1"/g)).toBe(3 * charts(html));
    expect(html).not.toMatch(/<rect[^>]*fill-opacity="0.1"[^>]*rx=/);
  });

  it("keeps a point-in-time bar solid and marks it with a hollow point, no hatch", () => {
    const html = svg("bar-incomplete-point");
    expect(html).not.toMatch(/url\(#hm-p-/);
    expect(count(html, /<circle[^>]* r="3.5"[^>]*stroke-width="1.75"/g)).toBe(charts(html));
  });

  it("gives a sparkline only a hollow end point when its last bucket is partial", () => {
    const partial = svg("kpi-sparkline-partial");
    const sparks = count(partial, /class="hm-spark"/g);
    expect(sparks).toBeGreaterThan(0);
    expect(count(partial, /h0"[^>]*stroke-linecap="round"/g)).toBe(2 * sparks);
    expect(partial).not.toMatch(/url\(#hm-p-/);
    expect(count(svg("kpi-sparkline"), /h0"/g)).toBe(0);
  });
});

describe("partial buckets: review cases (HAT-80)", () => {
  const find = (name: string) => {
    const v = GALLERY.find((g) => g.variant === name);
    if (!v) throw new Error(`no gallery variant ${name}`);
    return v.data;
  };
  const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

  it("keeps a visible outline on a 1 px stack part", () => {
    const data = find("bar-incomplete-stacked");
    const svg = partialBar(ctx(data), "h", "c1", 0, 0, 40, 1, 1);
    expect(svg).not.toMatch(/url\(#h-c1\)/);
    expect(svg).toMatch(/<rect x="0" y="0" width="40" height="1"[^>]*\/>$/);
    expect(svg).not.toMatch(/height="0"/);
  });

  it("draws a point-in-time line's partial end hollow, without the hatch", () => {
    const data = find("line-incomplete-mark");
    const metric = (data.blocks[0] as LineData).series[0]?.metric ?? "";
    const info = data.metrics[metric];
    if (!info) throw new Error("unexpected variant");
    const html = renderFragment({
      ...data,
      metrics: { ...data.metrics, [metric]: { ...info, nature: "point" } },
    });
    expect(count(html, /<circle[^>]* r="3.5"[^>]*stroke-width="1.75"/g)).toBe(count(html, /<svg/g));
    expect(html).not.toMatch(/url\(#hm-p-/);
  });

  it("gives a missing stack Total no partial status", () => {
    const data = find("bar-incomplete-stacked");
    const block = data.blocks[0] as LineData;
    const totals = block.totals ?? [];
    const last = totals.length - 1;
    const gone = { ...block, totals: totals.map((v, i) => (i === last ? null : v)) };
    const runtime = chartRuntimeData(gone, ctx(data));
    expect(runtime.totalStatus?.[last]).toBe("");
    expect(chartRuntimeData(block, ctx(data)).totalStatus?.[last]).toBe(
      "In progress \u00B7 23 of 30 days",
    );
  });

  it("keeps a complete Total complete when only a null part is partial", () => {
    const data = find("bar-incomplete-stacked");
    const block = data.blocks[0] as LineData;
    const last = (block.totals ?? []).length - 1;
    const absent = {
      ...block,
      series: block.series.map((s, k) =>
        k === 0
          ? { ...s, values: s.values.map((v, i) => (i === last ? null : v)) }
          : { ...s, partial: [] },
      ),
    };
    expect(chartRuntimeData(absent, ctx(data)).totalStatus?.[last] ?? "").toBe("");
    const rows = chartTable(absent, ctx(data), "t").match(/<tr>.*?<\/tr>/g) ?? [];
    expect(rows.at(-1)).toMatch(/in progress/);
    expect(rows.at(-1)).not.toMatch(/\u00B7 in progress[^<]*<\/td><\/tr>$/);
  });

  it("names a partial sparkline bucket in its table, accessible name and runtime, and marks the last drawn point", () => {
    const html = renderFragment(find("kpi-sparkline-partial"));
    expect(html).toMatch(/aria-label="[^"]*in progress \(\d+ of \d+ days\)"/);
    expect(html).toMatch(/<th scope="row">[^<]*in progress \(\d+ of \d+ days\)<\/th>/);
    expect(html).toMatch(/"status":\[[^\]]*"In progress \u00B7 \d+ of \d+ days"\]/);
    const data = find("kpi-sparkline-partial");
    const kpi = data.blocks[0] as KpiData;
    const spark = kpi.sparkline;
    if (!spark) throw new Error("unexpected variant");
    const trailing = renderFragment({
      ...data,
      blocks: [
        {
          ...kpi,
          sparkline: {
            ...spark,
            buckets: [...spark.buckets, "2099-01-01"],
            values: [...spark.values, null],
          },
        },
      ],
    });
    expect(count(trailing, /h0"[^>]*stroke-linecap="round"/g)).toBe(2);
  });
});
