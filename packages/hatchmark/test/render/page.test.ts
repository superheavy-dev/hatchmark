import { describe, expect, it } from "vitest";
import { GALLERY, SALES } from "../../gallery/variants.js";
import { renderDashboardPage, renderFragment } from "../../src/render/index.js";

const ASSETS = { runtime: "../_hatchmark/hatchmark.js", fonts: {} };

describe("dashboard page", () => {
  it("is byte-identical for identical input and never shows the build time", () => {
    const a = renderDashboardPage(structuredClone(SALES), { assets: ASSETS });
    const b = renderDashboardPage(structuredClone(SALES), { assets: ASSETS });
    expect(a).toBe(b);
    expect(a).toContain("Data through Oct 31, 2026");
    expect(a).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
  });

  it("pre-renders every chart for every layout and uses relative asset URLs only", () => {
    const page = renderDashboardPage(SALES, { assets: ASSETS });
    for (const layout of [0, 1, 2, 3, 4, 5, 6]) {
      expect(page.match(new RegExp(`class="hm-v [^"]*\\bhm-l${layout}\\b`, "g"))?.length).toBe(2);
    }
    expect(page).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(page).toContain('<script defer src="../_hatchmark/hatchmark.js"></script>');
  });

  it("never prints NaN, Infinity or undefined in any gallery variant", () => {
    for (const entry of GALLERY) {
      const html = renderFragment(entry.data);
      expect(html, entry.variant).not.toMatch(/NaN|Infinity|undefined|\[object/);
    }
  });

  it("gives every chart a text alternative and a data table", () => {
    const page = renderDashboardPage(SALES, { assets: ASSETS });
    expect(page).toContain(
      '<figcaption class="hm-sr" id="hm-revenue_by_month-d">Line chart of Revenue by month, Nov 2024 \u2013 Oct 2026.',
    );
    expect(page).toContain('aria-describedby="hm-revenue_by_month-d"');
    expect(page.match(/<div class="hm-sr"><table>/g)?.length).toBe(2);
    expect(page.match(/role="img" aria-label=/g)?.length).toBeGreaterThan(2);
  });

  it("escapes text from the data", () => {
    const evil = structuredClone(SALES);
    evil.title = '<img src=x onerror="alert(1)">';
    const line = evil.blocks[4];
    if (line?.type === "line" && line.series[0]) line.series[0].label = "</script><b>x</b>";
    const page = renderDashboardPage(evil, { assets: ASSETS });
    expect(page).not.toContain("<img src=x");
    expect(page).not.toContain("</script><b>");
  });
});
