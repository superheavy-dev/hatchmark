/// <reference lib="dom" />
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { csv, EXPECTED, NAMES } from "../node/collation.oracle.js";
import { buildProject, metric, removeProjects, writeProject } from "../node/fixture.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await removeProjects();
});

async function built(
  locale: string,
  orders = csv(NAMES),
  block: Record<string, unknown> = {
    type: "table",
    by: ["name"],
    metrics: ["amount"],
    sort: { by: "name", order: "asc" },
  },
): Promise<string> {
  const { root } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      locale,
      name: "Collation",
      sources: { orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } } },
    },
    "orders.csv": orders,
    "metrics/amount.yaml": metric({
      table: "orders",
      time: "day",
      type: "aggregate",
      aggregate: "sum",
      column: "amount",
    }),
    "dashboards/probe.yaml": {
      title: "Probe",
      period: { asOf: "2026-02-28", range: "all_time", compare: "none" },
      blocks: [block],
    },
  });
  expect((await buildProject(root)).code).toBe(0);
  return `file://${path.join(root, "dist", "probe", "index.html")}`;
}

describe("click-to-sort orders text like the build", () => {
  for (const [locale, expected] of Object.entries(EXPECTED)) {
    it(`${locale} page in a fr-FR browser: first paint, descending and ascending clicks`, async () => {
      const context = await browser.newContext({ locale: "fr-FR" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(await built(locale));
      const names = () =>
        page.$$eval("table.hm-table tbody tr", (trs) =>
          trs.map((tr) => (tr as HTMLTableRowElement).cells[0]?.getAttribute("data-v")),
        );
      const header = page.locator("table.hm-table thead th:nth-child(1) button");
      expect(await names()).toEqual(expected);
      await header.click();
      expect(await names()).toEqual([...expected].reverse());
      await page.locator("table.hm-table thead th:nth-child(2) button").click();
      await header.click();
      expect(await names()).toEqual(expected);
      expect(errors).toEqual([]);
      await context.close();
    });
  }
});

const column = (page: Page, index: number) =>
  page.$$eval(
    "table.hm-table tbody tr",
    (trs, i) => trs.map((tr) => (tr as HTMLTableRowElement).cells[i]?.getAttribute("data-v")),
    index,
  );

describe("a project locale the build cannot collate in", () => {
  it("eu: every browser locale keeps the build's order through clicks", async () => {
    const file = await built(
      "eu",
      csv([
        ["Zebra", 30],
        ["Österreich", 20],
        ["Sable", 10],
      ]),
    );
    const orders: Record<string, (string | null | undefined)[][]> = {};
    for (const locale of ["fr-FR", "sv-SE"]) {
      const context = await browser.newContext({ locale });
      const page = await context.newPage();
      await page.goto(file);
      const names = () => column(page, 0);
      const header = page.locator("table.hm-table thead th:nth-child(1) button");
      const first = await names();
      await header.click();
      await header.click();
      orders[locale] = [first, await names()];
      await context.close();
    }
    expect(orders["fr-FR"]).toEqual([
      ["Österreich", "Sable", "Zebra"],
      ["Österreich", "Sable", "Zebra"],
    ]);
    expect(orders["sv-SE"]).toEqual(orders["fr-FR"]);
  });
});

describe("returning to a sort shows first paint again", () => {
  it("by [region, name], region ascending: name twice, then region", async () => {
    const file = await built(
      "de-DE",
      "day,region,name,amount\n2026-01-05,North,Österreich,30\n2026-01-05,North,Zebra,20\n2026-01-05,West,Sable,10\n",
      {
        type: "table",
        by: ["region", "name"],
        metrics: ["amount"],
        sort: { by: "region", order: "asc" },
      },
    );
    const context = await browser.newContext({
      locale: "fr-FR",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(file);
    const rows = async () => {
      const regions = await column(page, 0);
      const names = await column(page, 1);
      return regions.map((r, i) => `${r}/${names[i]}`);
    };
    const first = await rows();
    expect(first).toEqual(["North/Österreich", "North/Zebra", "West/Sable"]);
    const name = page.locator("table.hm-table thead th:nth-child(2) button");
    await name.click();
    await name.click();
    expect(await rows()).toEqual(["North/Zebra", "West/Sable", "North/Österreich"]);
    await page.locator("table.hm-table thead th:nth-child(1) button").click();
    expect(await rows()).toEqual(first);
    await context.close();
  });
});
