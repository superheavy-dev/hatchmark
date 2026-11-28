/// <reference lib="dom" />
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, KpiData } from "../../src/compiler/dashboard-data.js";
import type { SegmentData } from "../../src/compiler/index.js";
import { formatValue } from "../../src/render/index.js";
import { buildProject, removeProjects, writeExample } from "../node/fixture.js";
import { toYaml } from "../yaml.js";

const SEGMENTS = {
  paid_marketing: {
    label: "Paid marketing",
    filters: [{ column: "channel", op: "in", values: ["Paid search", "Social", "Affiliate"] }],
  },
  americas: { label: "Americas", filters: [{ column: "region", op: "eq", value: "Americas" }] },
  none: { label: "Apparel", filters: [{ column: "category", op: "eq", value: "Apparel" }] },
};
const KPIS = [
  { type: "kpi", id: "revenue", metric: "revenue" },
  { type: "kpi", id: "orders", metric: "orders" },
];
const SEGMENT = { type: "segment", id: "segments", segments: ["paid_marketing", "americas"] };
const PERIOD = { asOf: "latest_data", range: "last_12_months", compare: "previous_period" };

let browser: Browser;
let root: string;

beforeAll(async () => {
  root = await writeExample(
    {},
    {
      toggles: { title: "Toggles", period: PERIOD, filters: [SEGMENT], blocks: KPIS },
      periods: {
        title: "Periods",
        period: PERIOD,
        filters: [
          {
            type: "period",
            id: "period",
            options: ["last_30_days", "last_12_months"],
            default: "last_12_months",
          },
          SEGMENT,
        ],
        blocks: KPIS,
      },
      "named-none": {
        title: "A segment named none",
        period: PERIOD,
        filters: [
          {
            type: "segment",
            id: "segments",
            segments: ["none", "americas"],
            default: ["americas"],
          },
        ],
        blocks: KPIS,
      },
    },
  );
  await mkdir(path.join(root, "segments"));
  for (const [name, spec] of Object.entries(SEGMENTS)) {
    await writeFile(path.join(root, "segments", `${name}.yaml`), toYaml(spec));
  }
  expect((await buildProject(root)).code).toBe(0);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await removeProjects();
});

const file = (name: string) => `file://${path.join(root, "dist", name, "index.html")}`;

async function open(name: string, query = ""): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${file(name)}${query}`);
  return { page, errors };
}

async function embedded(name: string): Promise<SegmentData> {
  const html = await readFile(path.join(root, "dist", name, "index.html"), "utf8");
  const json = html.match(
    /<script type="application\/json" data-hm-segments[^>]*>(.*?)<\/script>/s,
  );
  return JSON.parse(json?.[1] ?? "{}");
}

const shown = (data: DashboardData, metric: string) => {
  const block = data.blocks.find((b): b is KpiData => b.type === "kpi" && b.metric === metric);
  const info = data.metrics[metric];
  if (!block || !info) throw new Error(`no KPI ${metric}`);
  return formatValue(block.value, info, data.locale, "headline");
};

const settled = (page: Page) =>
  page.waitForFunction(() => !document.querySelector("main.hm-grid")?.hasAttribute("aria-busy"));
const kpi = (page: Page, label: string) =>
  page.locator(".hm-kpi", { hasText: label }).locator(".hm-kpi-value").textContent();
const chip = (page: Page, name: string) => page.locator(`[data-hm-segment="${name}"]`);

describe("segment toggle", () => {
  for (const name of ["toggles", "periods"]) {
    it(`${name}: shows each combination's numbers and keeps it in the URL across a reload`, async () => {
      const { states } = await embedded(name);
      const { page, errors } = await open(name);
      const none = states[""]?.data;
      if (!none) throw new Error("no default state");
      expect(await kpi(page, "Revenue")).toBe(shown(none, "revenue"));
      expect(await chip(page, "paid_marketing").getAttribute("aria-pressed")).toBe("false");

      await chip(page, "paid_marketing").click();
      await settled(page);
      expect(await chip(page, "paid_marketing").getAttribute("aria-pressed")).toBe("true");
      const paid = states.paid_marketing?.data;
      if (!paid) throw new Error("no paid_marketing state");
      await expect.poll(() => kpi(page, "Revenue")).toBe(shown(paid, "revenue"));
      expect(await kpi(page, "Orders")).toBe(shown(paid, "orders"));
      expect(new URL(page.url()).searchParams.get("segments")).toBe("paid_marketing");

      await chip(page, "americas").click();
      await settled(page);
      const both = states["paid_marketing,americas"]?.data;
      if (!both) throw new Error("no combined state");
      await expect.poll(() => kpi(page, "Revenue")).toBe(shown(both, "revenue"));
      expect(new URL(page.url()).searchParams.get("segments")).toBe("paid_marketing,americas");
      await expect
        .poll(() => page.locator("[aria-live=polite]").last().textContent())
        .toContain("Americas");

      await page.reload();
      await settled(page);
      expect(await chip(page, "americas").getAttribute("aria-pressed")).toBe("true");
      await expect.poll(() => kpi(page, "Revenue")).toBe(shown(both, "revenue"));

      await chip(page, "paid_marketing").click();
      await chip(page, "americas").click();
      await settled(page);
      await expect.poll(() => kpi(page, "Revenue")).toBe(shown(none, "revenue"));
      expect(new URL(page.url()).searchParams.get("segments")).toBeNull();
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("keeps the chosen preset when a segment turns on", async () => {
    const { states } = await embedded("periods");
    const { page, errors } = await open("periods", "?period=last_30_days");
    await settled(page);
    await chip(page, "americas").click();
    await settled(page);
    const month = Object.entries(states.americas?.periods?.presets ?? {}).find(([key]) =>
      key.includes("30"),
    )?.[1];
    if (!month) throw new Error("no last_30_days preset");
    await expect.poll(() => kpi(page, "Revenue")).toBe(shown(month, "revenue"));
    expect(new URL(page.url()).searchParams.get("period")).toBe("last_30_days");
    expect(errors).toEqual([]);
    await page.close();
  });

  for (const range of ["last_30_days", "2026-09-01..2026-09-30"]) {
    it(`opens ?segments=americas&period=${range} on that range with that combination`, async () => {
      const clicked = await open("periods", `?period=${range}`);
      await settled(clicked.page);
      await chip(clicked.page, "americas").click();
      await settled(clicked.page);
      const want = await clicked.page.locator(".hm-kpi-value").allTextContents();
      expect(new URL(clicked.page.url()).searchParams.get("period")).toBe(range);
      await clicked.page.close();

      const { page, errors } = await open("periods", `?segments=americas&period=${range}`);
      await settled(page);
      await expect.poll(() => page.locator(".hm-kpi-value").allTextContents()).toEqual(want);
      expect(new URL(page.url()).searchParams.get("period")).toBe(range);
      expect(new URL(page.url()).searchParams.get("segments")).toBe("americas");
      expect(await chip(page, "americas").getAttribute("aria-pressed")).toBe("true");
      await page.reload();
      await settled(page);
      await expect.poll(() => page.locator(".hm-kpi-value").allTextContents()).toEqual(want);
      expect(new URL(page.url()).searchParams.get("period")).toBe(range);
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  for (const range of ["bogus", "2024-01-01..2024-01-02"]) {
    it(`drops ?period=${range} and shows the segment combination's default range`, async () => {
      const valid = await open("periods", "?segments=americas");
      await settled(valid.page);
      const want = await valid.page.locator(".hm-kpi-value").allTextContents();
      await valid.page.close();

      const { page, errors } = await open("periods", `?segments=americas&period=${range}`);
      await settled(page);
      await expect.poll(() => page.locator(".hm-kpi-value").allTextContents()).toEqual(want);
      expect(new URL(page.url()).searchParams.get("period")).toBeNull();
      expect(new URL(page.url()).searchParams.get("segments")).toBe("americas");
      expect(await chip(page, "americas").getAttribute("aria-pressed")).toBe("true");
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  for (const [name, width] of [
    ["toggles", 1280],
    ["periods", 1280],
    ["toggles", 390],
    ["periods", 390],
  ] as const) {
    it(`${name} at ${width}px: toggling moves no chip and nothing in the header`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(file(name));
      const boxes = () =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("header.hm-header *")]
            .filter((el) => !el.closest(".hm-sr") && !el.closest("[hidden]"))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return `${el.tagName}.${el.className}: ${r.x},${r.y},${r.width},${r.height}`;
            }),
        );
      const before = await boxes();
      expect(before.filter((b) => b.startsWith("BUTTON.hm-chip"))).toHaveLength(2);
      for (const segment of ["paid_marketing", "americas", "paid_marketing", "americas"]) {
        await chip(page, segment).click();
        await settled(page);
        expect(await boxes()).toEqual(before);
      }
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("names the toggle group for screen readers without a visible label", async () => {
    const { page } = await open("toggles");
    const group = page.locator("[data-hm-segment-filter]");
    expect(await group.getAttribute("role")).toBe("group");
    expect(await group.getAttribute("aria-label")).toBe("Segments");
    expect((await group.innerText()).includes("Segments")).toBe(false);
    await page.close();
  });

  it("tells none of the segments apart from a segment named none", async () => {
    const { states } = await embedded("named-none");
    const { page, errors } = await open("named-none");
    await chip(page, "americas").click();
    await settled(page);
    expect(new URL(page.url()).searchParams.get("segments")).toBe("");
    await page.reload();
    await settled(page);
    expect(await chip(page, "americas").getAttribute("aria-pressed")).toBe("false");
    expect(await chip(page, "none").getAttribute("aria-pressed")).toBe("false");
    const all = states[""]?.data;
    if (!all) throw new Error("no empty state");
    await expect.poll(() => kpi(page, "Revenue")).toBe(shown(all, "revenue"));

    await chip(page, "none").click();
    await settled(page);
    expect(new URL(page.url()).searchParams.get("segments")).toBe("none");
    await page.reload();
    await settled(page);
    expect(await chip(page, "none").getAttribute("aria-pressed")).toBe("true");
    const apparel = states.none?.data;
    if (!apparel) throw new Error("no none state");
    await expect.poll(() => kpi(page, "Revenue")).toBe(shown(apparel, "revenue"));
    expect(errors).toEqual([]);
    await page.close();
  });
});
