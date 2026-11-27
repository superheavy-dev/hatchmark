/// <reference lib="dom" />
// Grain switching (#16) on the trends example built by hatchmark build. A card without the grain
// keeps its own.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, GrainSwitch, Series } from "../../src/compiler/dashboard-data.js";
import { formatBucket, formatValue } from "../../src/render/index.js";
import type { TimeGrain } from "../../src/spec/index.js";
import {
  buildProject,
  EXAMPLE,
  loadAt,
  removeProjects,
  run,
  writeExample,
} from "../node/fixture.js";

const SIX = [
  "quarter",
  { unit: "quarter", anchor: "02-01" },
  { unit: "quarter", anchor: "03-01" },
  "year",
  { unit: "year", anchor: "02-01" },
  { unit: "year", anchor: "07-01" },
];

let browser: Browser;
let root: string;
let data: DashboardData;

beforeAll(async () => {
  const trends = JSON.parse(await readFile(path.join(EXAMPLE, "dashboards/trends.json"), "utf8"));
  root = await writeExample(
    {},
    {
      t: trends,
      six: {
        title: "Six",
        period: {
          asOf: "latest_data",
          range: { start: "2024-11-01", end: "2026-11-01" },
          compare: "none",
        },
        filters: [{ type: "grain", id: "g", options: SIX, default: "quarter" }],
        blocks: [
          {
            type: "line",
            id: "l",
            title: "Revenue",
            metrics: ["revenue"],
            grain: "quarter",
            grains: SIX,
          },
        ],
      },
    },
  );
  expect((await buildProject(root)).code).toBe(0);
  const { project } = await loadAt(root);
  data = (await run(root, project, "t")).data as DashboardData;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await removeProjects();
});

const open = async (name: string, width: number): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.goto(`file://${path.join(root, "dist", name, "index.html")}`);
  return page;
};
const radio = (scope: Locator, name: string) => scope.getByRole("radio", { name, exact: true });

describe("grain switching on the built trends page", () => {
  it("header and card switches move only the cards that list the grain, and header arrow keys step and wrap", async () => {
    const page = await open("t", 1280);
    const cards = page.locator("section[data-hm-grains]");
    const header = page.locator("[data-hm-grain-filter]");
    const shown = () =>
      Promise.all(
        [0, 1, 2].map((i) =>
          cards.nth(i).locator(".hm-grain-panel:not([hidden])").getAttribute("data-hm-grain"),
        ),
      );
    const checked = () => header.locator("[aria-checked=true]").textContent();
    const focused = () => page.evaluate(() => document.activeElement?.textContent);

    expect(await shown()).toEqual(["month", "month", "month"]);
    await radio(header, "Week").click();
    expect(await shown()).toEqual(["week:sunday", "month", "week:sunday"]);
    expect(await checked()).toBe("Week");
    await radio(header, "Quarter").click();
    expect(await shown()).toEqual(["quarter:01-01", "quarter:01-01", "week:sunday"]);
    await radio(header, "Week").click();
    expect(await shown()).toEqual(["week:sunday", "quarter:01-01", "week:sunday"]);
    await radio(cards.nth(1), "Month").click();
    expect(await shown()).toEqual(["week:sunday", "month", "week:sunday"]);
    expect(await checked()).toBe("Week");

    await header.locator("[aria-checked=true]").focus();
    await page.keyboard.press("ArrowRight");
    expect(await shown()).toEqual(["month", "month", "month"]);
    expect(await focused()).toBe("Month");
    expect(await checked()).toBe("Month");
    await page.keyboard.press("ArrowRight");
    expect(await shown()).toEqual(["quarter:01-01", "quarter:01-01", "month"]);
    expect(await focused()).toBe("Quarter");
    await page.close();
  });

  const SWITCHING = ["revenue_by_region", "orders_over_time", "revenue_by_channel"];
  const optionsOf = (id: string) =>
    (data.blocks.find((b) => b.id === id) as unknown as { grains: GrainSwitch }).grains.options;
  const expected = (option: GrainSwitch["options"][number]) => {
    const axis = option.axis as { buckets: string[]; grain: TimeGrain };
    const metric = (name: string) => data.metrics[name] ?? { format: { type: "number" as const } };
    return {
      headers: axis.buckets.map((b) => formatBucket(b, axis.grain, data.locale)),
      cells: option.series.map((s: Series) => ({
        label: s.label,
        text: s.values.map((v) => formatValue(v ?? null, metric(s.metric), data.locale, "full")),
        cell: s.values.map((v, j) => {
          const text = formatValue(v ?? null, metric(s.metric), data.locale, "full");
          if (s.share === undefined) return text;
          const share = formatValue(
            s.share[j] ?? null,
            { format: { type: "percent" } },
            data.locale,
            "full",
          );
          return `${text} (${share})`;
        }),
        short: s.values.map((v) =>
          formatValue(v ?? null, metric(s.metric), data.locale, "compact"),
        ),
      })),
      totals: option.totals?.map((v) =>
        formatValue(v ?? null, metric(option.series[0]?.metric ?? ""), data.locale, "full"),
      ),
      shortTotals: option.totals?.map((v) =>
        formatValue(v ?? null, metric(option.series[0]?.metric ?? ""), data.locale, "compact"),
      ),
    };
  };

  it("every grain panel's figure JSON and data table match DashboardData cell by cell, as the page formats them", async () => {
    const page = await open("t", 1280);
    const cards = page.locator("section[data-hm-grains]");
    let panels = 0;
    for (const [i, id] of SWITCHING.entries()) {
      for (const panel of await cards.nth(i).locator(".hm-grain-panel").all()) {
        panels++;
        const key = await panel.getAttribute("data-hm-grain");
        const option = optionsOf(id).find((o) => o.key === key);
        if (option === undefined) throw new Error(`${id}: no option ${key}`);
        const want = expected(option);
        const json = JSON.parse(
          (await panel.locator("figure > script").textContent()) ?? "null",
        ) as {
          headers: string[];
          series: { v: unknown[] }[];
        };
        expect({ id, key, headers: json.headers, v: json.series.map((x) => x.v) }).toEqual({
          id,
          key,
          headers: want.headers,
          v: option.series.map((x: Series) => x.values),
        });
        const table = await panel.locator("table").evaluate((t) => ({
          head: [...t.querySelectorAll("thead th")].map((c) => c.textContent),
          rows: [...t.querySelectorAll("tbody tr")].map((r) =>
            [...r.children].map((c) => c.textContent),
          ),
        }));
        expect({ id, key, ...table }).toEqual({
          id,
          key,
          head: ["Period", ...want.cells.map((c) => c.label), ...(want.totals ? ["Total"] : [])],
          rows: want.headers.map((h, j) => [
            h,
            ...want.cells.map((c) => c.cell[j]),
            ...(want.totals ? [want.totals[j]] : []),
          ]),
        });
      }
    }
    expect(panels).toBe(7);
    await page.close();
  });

  it("hovering a newly revealed panel of every grain shows that bucket's values, in a tooltip or in the pinned readout", async () => {
    const page = await open("t", 1280);
    const cards = page.locator("section[data-hm-grains]");
    for (const [i, id] of SWITCHING.entries()) {
      const card = cards.nth(i);
      for (const option of optionsOf(id)) {
        await card.locator(`.hm-seg button[data-hm-grain="${option.key}"]`).click();
        const panel = card.locator(".hm-grain-panel:not([hidden])");
        expect(await panel.getAttribute("data-hm-grain")).toBe(option.key);
        const want = expected(option);
        const svg = panel.locator("svg[data-hm-kind]").filter({ visible: true });
        await svg.scrollIntoViewIfNeeded();
        const box = (await svg.boundingBox()) as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        const pinned = await svg.evaluate((e) => e.hasAttribute("data-hm-readout"));
        const tip = panel.locator(".hm-tip");
        const headers = new Set<string>();
        for (const at of [0.15, 0.35, 0.5, 0.65, 0.85]) {
          await page.mouse.move(box.x + box.width * at, box.y + box.height / 2);
          const where = `${id} ${option.key} at ${at}`;
          if (pinned) {
            const shown = await svg.evaluate(
              (e, n) => ({
                header: e.querySelector(".hm-rh")?.textContent ?? "",
                values: Array.from(
                  { length: n },
                  (_, k) => e.querySelector(`.hm-rv-${k}`)?.textContent ?? "",
                ),
              }),
              want.cells.length,
            );
            const [period = "", total] = shown.header.split(" · Total ");
            const j = want.headers.indexOf(period);
            expect(j, `${where}: readout header ${shown.header}`).toBeGreaterThanOrEqual(0);
            expect(total, `${where}: readout total`).toBe(want.shortTotals?.[j]);
            expect(shown.values, where).toEqual(want.cells.map((c) => c.short[j]));
            headers.add(shown.header);
            continue;
          }
          expect(await tip.isVisible(), `${where}: tooltip visible`).toBe(true);
          const shown = await tip.evaluate((t) => ({
            header: t.querySelector(".hm-tip-h")?.textContent ?? "",
            rows: [...t.querySelectorAll(".hm-tip-r:not(.hm-tip-t)")].map((r) => [
              r.querySelector(".hm-tip-n")?.textContent ?? "",
              r.querySelector(".hm-tip-v")?.textContent ?? "",
            ]),
          }));
          const j = want.headers.indexOf(shown.header);
          expect(j, `${where}: tooltip header ${shown.header}`).toBeGreaterThanOrEqual(0);
          expect(Object.fromEntries(shown.rows), where).toEqual(
            Object.fromEntries(want.cells.map((c) => [c.label, c.text[j]])),
          );
          headers.add(shown.header);
        }
        expect(headers.size, `${id} ${option.key}: distinct buckets hovered`).toBeGreaterThan(1);
        await page.mouse.move(0, 0);
      }
    }
    await page.close();
  });

  it("a switching card's accessible name leaves out the titles of hidden grains", async () => {
    const page = await open("t", 1280);
    const names = await page.locator("section[data-hm-grains]").evaluateAll((sections) =>
      sections.map((s) => {
        const heading = document.getElementById(s.getAttribute("aria-labelledby") ?? "");
        const hidden = [...(heading?.querySelectorAll("[hidden]") ?? [])].map(
          (n) => n.textContent ?? "",
        );
        const visible = [...(heading?.childNodes ?? [])]
          .filter((n) => !(n as HTMLElement).hidden)
          .map((n) => n.textContent)
          .join("");
        return {
          visible,
          leaks: hidden.filter((h) => h !== "" && visible.includes(h) && h !== visible),
        };
      }),
    );
    expect(names.length).toBe(3);
    for (const n of names) {
      expect(n.visible.length).toBeGreaterThan(0);
      expect(n.leaks).toEqual([]);
    }
    await page.close();
  });

  it("on a phone the page never scrolls sideways and the readout starts on the last week and steps back with the arrow keys after a switch", async () => {
    const page = await open("t", 390);
    await radio(page.locator("[data-hm-grain-filter]"), "Week").click();
    const svg = page
      .locator("section[data-hm-grains]")
      .nth(0)
      .locator(".hm-grain-panel:not([hidden]) svg")
      .filter({ visible: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBe(0);
    expect(await svg.evaluate((s) => s.hasAttribute("data-hm-readout"))).toBe(true);
    const readout = () => svg.evaluate((s) => s.querySelector(".hm-rh")?.textContent ?? null);
    const before = await readout();
    expect(before).toMatch(/^Week of /);
    await svg.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await readout()).toBe(before);
    await page.keyboard.press("ArrowLeft");
    const after = await readout();
    expect(after).toMatch(/^Week of /);
    expect(after).not.toBe(before);
    await page.close();
  });

  it.each([320, 390])(
    "six anchored options never make a %ipx page scroll sideways",
    async (width) => {
      const page = await open("six", width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBe(0);
      await page.close();
    },
  );
});
