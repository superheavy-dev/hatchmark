/// <reference lib="dom" />
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, KpiData } from "../../src/compiler/dashboard-data.js";
import { runDashboard } from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { formatValue } from "../../src/render/index.js";
import { buildProject, EXAMPLE, loadAt, removeProjects, writeExample } from "../node/fixture.js";
import { fromYaml } from "../yaml.js";

/** The period control on the built explorer example: presets, calendar keyboard, URL state. */
let browser: Browser;
let root: string;

beforeAll(async () => {
  const explorer = fromYaml(await readFile(path.join(EXAMPLE, "dashboards/explorer.yaml"), "utf8"));
  root = await writeExample({}, { explorer });
  expect((await buildProject(root)).code).toBe(0);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await removeProjects();
});

const file = () => `file://${path.join(root, "dist", "explorer", "index.html")}`;

async function open(query = "", width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${file()}${query}`);
  return { page, errors };
}

const settled = (page: Page) =>
  page.waitForFunction(() => !document.querySelector("main.hm-grid")?.hasAttribute("aria-busy"));
const caption = (page: Page) => page.locator("[data-hm-caption]").textContent();
const kpi = (page: Page, label: string) =>
  page.locator(".hm-kpi", { hasText: label }).locator(".hm-kpi-value").textContent();

/** The SQL path's numbers for a range, through runDashboard with the filter bound. */
async function sql(range: unknown): Promise<DashboardData> {
  const { project } = await loadAt(root);
  const config = project.config.spec;
  if (!config) throw new Error("no config");
  const executor = await createDuckDbExecutor({ root, config });
  try {
    const result = await runDashboard(project, "explorer", executor, undefined, { period: range });
    if (!result.data) throw new Error(JSON.stringify(result.diagnostics));
    return result.data;
  } finally {
    await executor.close();
  }
}

const shownValue = (data: DashboardData, metric: string) => {
  const block = data.blocks.find((b): b is KpiData => b.type === "kpi" && b.metric === metric);
  const info = data.metrics[metric];
  if (!block || !info) throw new Error(`no KPI ${metric}`);
  return formatValue(block.value, info, data.locale, "headline");
};

describe("period control", () => {
  it("opens as a dialog, picks a preset with the keyboard, and keeps it in the URL across a reload", async () => {
    const { page, errors } = await open();
    const button = page.locator(".hm-period-button");
    await button.click();
    expect(await button.getAttribute("aria-expanded")).toBe("true");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-checked")))
      .toBe("true");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement).dataset.hmPreset,
    );
    expect(focused).toBe("last_7_days");
    await page.keyboard.press("Enter");
    await settled(page);
    expect(await caption(page)).toContain("Oct 25 \u2013 31, 2026");
    expect(new URL(page.url()).searchParams.get("period")).toBe("last_7_days");
    expect(await button.getAttribute("aria-expanded")).toBe("false");
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("hm-period-button");
    expect(await kpi(page, "Revenue")).toBe(
      shownValue(await sql({ last: 7, unit: "day" }), "revenue"),
    );

    await page.reload();
    await settled(page);
    expect(await caption(page)).toContain("Oct 25 \u2013 31, 2026");
    expect(await page.locator("[data-hm-preset=last_7_days]").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(errors).toEqual([]);
    await page.close();
  });

  it("picks a custom range on the calendar grid with arrows and Page Down, matching the SQL numbers", async () => {
    const { page, errors } = await open();
    await page.locator(".hm-period-button").click();
    const day = (d: string) => page.locator(`[data-day="${d}"]`);
    await day("2026-09-01").focus();
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement).dataset.day))
      .toBe("2026-09-01");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await day("2026-09-09").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("PageDown");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.day)).toBe(
      "2026-10-09",
    );
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    expect(await page.locator(".hm-cal-status").textContent()).toContain(
      "Sep 9 \u2013 Oct 10, 2026, 32 days",
    );
    await page.locator("[data-hm-cal=apply]").click();
    await settled(page);
    expect(new URL(page.url()).searchParams.get("period")).toBe("2026-09-09..2026-10-10");
    expect(await caption(page)).toContain("Sep 9 \u2013 Oct 10, 2026");
    const data = await sql({ start: "2026-09-09", end: "2026-10-11" });
    for (const [label, metric] of [
      ["Revenue", "revenue"],
      ["Orders", "orders"],
      ["Average order value", "avg_order_value"],
      ["Refund rate", "refund_rate"],
    ] as const) {
      expect(await kpi(page, label)).toBe(shownValue(data, metric));
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  it("disables days outside the data, and Escape closes the dialog and returns focus", async () => {
    const { page } = await open();
    await page.locator(".hm-period-button").click();
    await page.locator("[data-day]").first().focus();
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.day)).toBe(
      "2026-10-31",
    );
    expect(await page.locator('[data-day="2026-11-01"]').count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await page.locator(".hm-period-panel").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("hm-period-button");
    await page.close();
  });

  it("ignores a range in the URL that the page cannot show and drops it from the address", async () => {
    for (const bad of ["nonsense", "2027-01-01..2027-02-01", "2026-05-10..2026-05-01"]) {
      const { page, errors } = await open(`?period=${encodeURIComponent(bad)}`);
      await page.waitForTimeout(300);
      await settled(page);
      expect(await caption(page)).toContain("Nov 2025 \u2013 Oct 2026");
      expect(new URL(page.url()).searchParams.get("period")).toBeNull();
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  it("keeps the grain in the URL, applies it to redrawn blocks, and names every switch apart", async () => {
    const { page } = await open("?grain=month&period=last_30_days");
    await settled(page);
    const shown = () =>
      page
        .locator("section[data-hm-grains] .hm-grain-panel:not([hidden])")
        .getAttribute("data-hm-grain");
    expect(await shown()).toBe("month");
    await page.locator("[data-hm-grain-filter]").getByRole("radio", { name: "Day" }).click();
    expect(new URL(page.url()).searchParams.get("grain")).toBe("day");
    await page.locator(".hm-period-button").click();
    await page.locator("[data-hm-preset=last_7_days]").click();
    await settled(page);
    expect(await shown()).toBe("day");
    const names = await page
      .getByRole("radiogroup")
      .evaluateAll((groups) => groups.map((g) => g.getAttribute("aria-label")));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("Grain, all charts");
    expect(names).toContain("Grain: Revenue by region");
    await page.close();
  });

  it("keeps focus inside the dialog when a redraw disables or replaces the focused control", async () => {
    const { page, errors } = await open();
    await page.locator(".hm-period-button").focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-hm-cal=prev]").focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-hm-cal=next]").focus();
    await page.keyboard.press("Enter");
    const inPanel = () =>
      page.evaluate(() => !!document.activeElement?.closest(".hm-period-panel"));
    expect(await page.locator("[data-hm-cal=next]").isDisabled()).toBe(true);
    expect(await inPanel()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator(".hm-period-panel").isHidden()).toBe(true);

    await page.locator(".hm-period-button").click();
    const days = page.locator(".hm-days button:not([aria-disabled])");
    await days.nth(3).click();
    await days.nth(6).hover();
    expect(await inPanel()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator(".hm-period-panel").isHidden()).toBe(true);
    expect(errors).toEqual([]);
  });

  it("never applies a typed day outside the data: Apply stays off and the field says so", async () => {
    const { page, errors } = await open();
    await page.locator(".hm-period-button").click();
    const max = await page.locator("[data-hm-edge=end]").getAttribute("max");
    const year = Number(max?.slice(0, 4));
    await page.locator("[data-hm-edge=start]").fill(`${year}-01-05`);
    await page.locator("[data-hm-edge=end]").fill(`${year}-01-10`);
    expect(await page.locator("[data-hm-cal=apply]").isEnabled()).toBe(true);
    await page.locator("[data-hm-edge=end]").fill(`${year + 1}-12-31`);
    expect(await page.locator("[data-hm-edge=end]").getAttribute("aria-invalid")).toBe("true");
    expect(await page.locator("[data-hm-edge=end]").inputValue()).toBe(`${year + 1}-12-31`);
    expect(await page.locator("[data-hm-cal=apply]").isDisabled()).toBe(true);
    expect(new URL(page.url()).searchParams.get("period")).toBeNull();
    expect(errors).toEqual([]);
  });

  it("keeps a link to dates as dates, even when a preset reads the same days", async () => {
    const probe = await open();
    const end = await probe.page.locator(".hm-cal").getAttribute("data-hm-end");
    await probe.page.close();
    const last = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000);
    const first = new Date(last.getTime() - 6 * 86_400_000);
    const key = `${first.toISOString().slice(0, 10)}..${last.toISOString().slice(0, 10)}`;
    const { page, errors } = await open(`?period=${key}`);
    await settled(page);
    expect(new URL(page.url()).searchParams.get("period")).toBe(key);
    expect(await page.locator("[data-hm-preset=last_7_days]").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(errors).toEqual([]);
  });

  it("labels a KPI with its own dates when they differ from the caption", async () => {
    const probe = await open();
    const end = await probe.page.locator(".hm-cal").getAttribute("data-hm-end");
    await probe.page.close();
    const day = (back: number) =>
      new Date(Date.parse(`${end}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    const read = async (key: string) => {
      const { page, errors } = await open(`?period=${key}`);
      await settled(page);
      const result = {
        caption: await caption(page),
        revenue: await kpi(page, "Revenue"),
        note: await page.locator(".hm-kpi", { hasText: "Revenue" }).innerText(),
        errors,
      };
      await page.close();
      return result;
    };
    const preset = await read("last_7_days");
    const sameLabel = await read(`${day(7)}..${day(1)}`);
    const sameDays = await read(`${day(8)}..${day(2)}`);
    expect(preset.revenue).toBe(sameDays.revenue);
    expect(sameLabel.caption).toBe(preset.caption);
    if (sameLabel.revenue !== preset.revenue) expect(sameLabel.note).not.toBe(preset.note);
    for (const r of [preset, sameLabel, sameDays]) expect(r.errors).toEqual([]);
  });

  it("clears the invalid mark when the calendar corrects a typed day", async () => {
    const { page, errors } = await open();
    await page.locator(".hm-period-button").click();
    const end = page.locator("[data-hm-edge=end]");
    const max = (await end.getAttribute("max")) ?? "";
    const before = new Date(Date.parse(`${max}T00:00:00Z`) - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await page.locator("[data-hm-edge=start]").fill(before);
    await end.fill(`${Number(max.slice(0, 4)) + 1}-01-24`);
    expect(await end.getAttribute("aria-invalid")).toBe("true");
    await page.locator(`[data-day="${max}"]`).click();
    expect(await end.inputValue()).toBe(max);
    expect(await end.getAttribute("aria-invalid")).toBeNull();
    expect(await page.locator(".hm-cal-status").textContent()).not.toContain("Pick a day from");
    expect(await page.locator("[data-hm-cal=apply]").isEnabled()).toBe(true);
    expect(errors).toEqual([]);
  });

  it("fits a 390 px phone with the dialog open", async () => {
    const { page } = await open("", 390);
    await page.locator(".hm-period-button").click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    const box = await page.locator(".hm-period-panel").boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await page.close();
  });
});

describe("range text the browser redraws, in a fr-FR browser", () => {
  for (const locale of ["en-US", "ja-JP", "ko-KR", "is-IS"]) {
    it(`is the text the build wrote for the same range, in ${locale}`, async () => {
      const explorer = fromYaml(
        await readFile(path.join(EXAMPLE, "dashboards/explorer.yaml"), "utf8"),
      );
      const at = await writeExample({ locale }, { explorer });
      expect((await buildProject(at)).code).toBe(0);
      const page = await browser.newPage({
        locale: "fr-FR",
        viewport: { width: 1280, height: 1000 },
      });
      await page.goto(`file://${path.join(at, "dist", "explorer", "index.html")}`);
      const button = page.locator(".hm-period-button");
      const shown = () => button.locator(".hm-period-dates").textContent();
      const first = { caption: await caption(page), dates: await shown() };
      const presets = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".hm-period-presets [data-hm-preset]")].map(
          (b) => ({
            key: b.dataset.hmPreset ?? "",
            dates: b.querySelector(".hm-period-dates")?.textContent ?? null,
            checked: b.getAttribute("aria-checked") === "true",
          }),
        ),
      );
      expect(presets.filter((p) => p.dates).length).toBeGreaterThan(3);
      const pick = async (key: string) => {
        await button.click();
        await page.locator(`[data-hm-preset="${key}"]`).click();
        await settled(page);
      };
      for (const preset of presets.filter((p) => !p.checked && p.dates)) {
        await pick(preset.key);
        expect(await shown(), preset.key).toBe(preset.dates);
      }
      const start = presets.find((p) => p.checked);
      if (!start) throw new Error("no selected preset");
      await pick(start.key);
      expect({ caption: await caption(page), dates: await shown() }).toEqual(first);
      await page.close();
    });
  }
});
