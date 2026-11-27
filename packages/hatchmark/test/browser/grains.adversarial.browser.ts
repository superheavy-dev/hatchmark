/// <reference lib="dom" />
// Adopted from the HAT-40 adversarial review of hatchmark#16 (grain switching): browser.mjs, on the
// trends example built by hatchmark build. Its two header ArrowRight expectations were wrong in the
// harness; the expectations here follow the README's correction (a card without the grain keeps its own).
// Its phone readout check pressed ArrowLeft once, which lands on the last week the readout already pins.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, GrainSwitch, Series } from "../../src/compiler/dashboard-data.js";
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

describe("grain switching on the built trends page (HAT-40 browser.mjs)", () => {
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

  it("every grain panel's figure JSON and data table match DashboardData for that grain", async () => {
    const page = await open("t", 1280);
    const cards = page.locator("section[data-hm-grains]");
    const ids = ["revenue_by_region", "orders_over_time", "revenue_by_channel"];
    const bad: unknown[] = [];
    let panels = 0;
    for (const [i, id] of ids.entries()) {
      const block = data.blocks.find((b) => b.id === id) as unknown as { grains: GrainSwitch };
      for (const panel of await cards.nth(i).locator(".hm-grain-panel").all()) {
        panels++;
        const key = await panel.getAttribute("data-hm-grain");
        const option = block.grains.options.find((o) => o.key === key);
        const json = JSON.parse(
          (await panel.locator("figure > script").textContent()) ?? "null",
        ) as {
          headers: unknown[];
          series: { v: unknown[] }[];
        };
        const buckets = (option?.axis as { buckets: string[] } | undefined)?.buckets.length;
        const same =
          JSON.stringify(json.series.map((s) => s.v)) ===
          JSON.stringify(option?.series.map((s: Series) => s.values));
        const tableRows = await panel.locator("table tbody tr").count();
        if (!same || json.headers.length !== buckets || tableRows === 0)
          bad.push({ id, key, headers: json.headers.length, buckets, same, tableRows });
      }
    }
    expect(bad).toEqual([]);
    expect(panels).toBe(7);
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
