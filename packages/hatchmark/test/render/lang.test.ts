import { describe, expect, it } from "vitest";
import type { DashboardData, PeriodFilter } from "../../src/compiler/dashboard-data.js";
import { renderDashboardPage } from "../../src/render/index.js";
import { periodControl } from "../../src/render/period.js";
import GLOBAL_SALES from "../fixtures/global-sales/sales.data.json" with { type: "json" };

const ASSETS = { runtime: "hatchmark.js", fonts: {} };

const page = (locale: string) =>
  renderDashboardPage(
    { ...(GLOBAL_SALES as DashboardData), locale },
    { assets: ASSETS, sources: [] },
  );

/** The text of every td, svg text and span that carries lang, inner markup removed. */
const marked = (html: string, lang: string) =>
  [
    ...html.matchAll(new RegExp(`<(text|td|span)\\b[^>]*\\blang="${lang}"[^>]*>(.*?)</\\1>`, "g")),
  ].map((m) => (m[2] ?? "").replace(/<[^>]*>/g, ""));

const GERMAN_NUMBER = /^[\u2212+]?\d{1,3}(\.\d{3})*(,\d+)?(\u00a0Mio\.)?(\u00a0[$%])?$/;
const GERMAN_DATE =
  /^(\d{1,2}\. )?(Jan|Feb|Mär|März|Apr|Mai|Juni?|Juli?|Aug|Sept?|Okt|Nov|Dez)\.?( \d{4})?$/;

describe("lang on locale-formatted values", () => {
  it("adds nothing for English locales, which the page's lang already covers", () => {
    for (const locale of ["en-US", "en-GB"]) {
      expect(page(locale).match(/ lang="/g), locale).toEqual([' lang="']);
    }
  });

  it("de-DE: marks KPI figures, table and chart cells, ticks and value labels, and nothing else", () => {
    const html = page("de-DE");
    const texts = marked(html, "de-DE");
    expect(texts.length).toBeGreaterThan(100);
    expect(
      texts.filter((t) => !GERMAN_NUMBER.test(t) && !GERMAN_DATE.test(t) && t !== "\u2014"),
    ).toEqual([]);
    expect(texts).toContain("5.000\u00a0$");
    expect(texts).toContain("Nov. 2025");
    expect(html.match(/<div class="hm-kpi-figure" lang="de-DE">/g)).toHaveLength(4);
    expect(
      html.match(/<span class="hm-sr" lang="en"> \((up|down), (better|worse)\)<\/span>/g),
    ).toHaveLength(4);
    expect(html).not.toMatch(/lang="de-DE"[^>]*>(Total|Other|Share)/);
  });

  it("ja-JP: marks values and dates with the project locale", () => {
    const texts = marked(page("ja-JP"), "ja-JP");
    expect(texts).toContain("2025年11月");
    expect(texts).toContain("$5,000");
    expect(texts.filter((t) => /[A-Za-z]/.test(t))).toEqual([]);
  });

  const filter: PeriodFilter = {
    id: "period",
    label: "Period",
    selected: "2026-09-01..2026-09-10",
    options: [
      {
        key: "last_7_days",
        label: "Last 7 days",
        current: { start: "2026-10-25", end: "2026-11-01" },
      },
      { key: "2026-10-01..2026-10-07", current: { start: "2026-10-01", end: "2026-10-08" } },
    ],
    custom: { start: "2025-11-01", end: "2026-11-01" },
  };
  const control = (locale: string, selected = filter.selected) =>
    periodControl(
      { ...(GLOBAL_SALES as DashboardData), locale, periodFilter: { ...filter, selected } },
      undefined,
      0,
    );

  it("marks the period control's dates, never its English names", () => {
    const html = control("de-DE");
    expect(html).toContain(
      '<span class="hm-period-name" lang="de-DE">1.\u201310. Sept. 2026</span>',
    );
    expect(html).toContain(
      '<span>Last 7 days</span><span class="hm-period-dates" lang="de-DE">25.\u201331. Okt. 2026</span>',
    );
    expect(html).toContain('<span lang="de-DE">1.\u20137. Okt. 2026</span>');
    expect(html).toContain(
      '<input type="text" inputmode="numeric" autocomplete="off" placeholder="DD.MM.YYYY" data-hm-edge="start" lang="de-DE">',
    );
    const preset = control("de-DE", "last_7_days");
    expect(preset).toContain(
      '<span class="hm-period-name">Last 7 days</span><span class="hm-period-dates" lang="de-DE">',
    );
    expect(control("en-US").match(/ lang="/g)).toBeNull();
  });
});
