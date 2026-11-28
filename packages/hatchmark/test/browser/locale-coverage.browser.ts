/// <reference lib="dom" />
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import {
  buildProject,
  EXAMPLE,
  metric,
  removeProjects,
  writeExample,
  writeProject,
} from "../node/fixture.js";
import { fromYaml } from "../yaml.js";

const FULL = process.env.HM_SWEEP === "full";
const engines: Record<string, Browser> = {};

beforeAll(async () => {
  engines.chromium = await chromium.launch();
  engines.webkit = await webkit.launch();
});

afterAll(async () => {
  for (const engine of Object.values(engines)) await engine.close();
  await removeProjects();
});

const NAMES = [
  "Zebra",
  "zebra",
  "Österreich",
  "Osterreich",
  "Ærø",
  "Þingvellir",
  "Ásbyrgi",
  "Asbyrgi",
  "Aarhus",
  "Ålborg",
  "Llandudno",
  "Lima",
  "Chester",
  "Cardiff",
  "İzmir",
  "Istanbul",
  "ırmak",
  "Item 2",
  "Item 10",
  "ABC",
  "abc",
  "東京",
  "とうきょう",
];

async function sortable(locale: string): Promise<string> {
  const rows = NAMES.map((name, i) => `2026-01-05,${name},${(i + 1) * 10}`);
  const { root } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      locale,
      name: "Locales",
      sources: { orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } } },
    },
    "orders.csv": `day,name,amount\n${rows.join("\n")}\n2026-01-05,,5\n`,
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
      blocks: [
        {
          type: "table",
          by: ["name"],
          metrics: ["amount"],
          sort: { by: "name", order: "asc" },
        },
      ],
    },
  });
  expect((await buildProject(root)).code).toBe(0);
  return `file://${path.join(root, "dist", "probe", "index.html")}`;
}

describe("click-sort keeps the build's order for locales a browser lacks", () => {
  const locales = FULL
    ? ["is-IS", "cy-GB", "da-DK", "eu-ES", "tr-TR", "sv-SE", "ja-JP"]
    : ["is-IS", "da-DK", "eu-ES"];
  for (const locale of locales) {
    for (const engine of ["chromium", "webkit"]) {
      it(`${locale} page in an en-US ${engine}`, async () => {
        const context = await (engines[engine] as Browser).newContext({ locale: "en-US" });
        const page = await context.newPage();
        await page.goto(await sortable(locale));
        const names = () =>
          page.$$eval("table.hm-table tbody tr", (trs) =>
            trs.map((tr) => (tr as HTMLTableRowElement).cells[0]?.getAttribute("data-v")),
          );
        const first = await names();
        const header = page.locator("table.hm-table thead th:nth-child(1) button");
        await header.click();
        expect(await names()).toEqual([...first.slice(0, -1).reverse(), ""]);
        await page.locator("table.hm-table thead th:nth-child(2) button").click();
        await header.click();
        expect(await names()).toEqual(first);
        await context.close();
      });
    }
  }
});

type Case = [typed: string, day: string | null];

const FIELDS: { locale: string; browser: string; zone: string; cases: Case[]; full?: true }[] = [
  {
    locale: "is-IS",
    browser: "en-US",
    zone: "UTC",
    cases: [
      ["02.09.2026", "2026-09-02"],
      ["2.9.2026", "2026-09-02"],
    ],
  },
  { locale: "is-IS", browser: "de-DE", zone: "UTC", cases: [["02.09.2026", "2026-09-02"]] },
  {
    locale: "de-DE",
    browser: "en-US",
    zone: "America/Los_Angeles",
    cases: [
      ["1.9.2026", "2026-09-01"],
      ["01.09.26", null],
      ["1.9.0026", null],
      ["31.9.2026", null],
      ["29.2.2026", null],
      ["1.9.2026.", "2026-09-01"],
      ["1/9/2026", "2026-09-01"],
      ["2026-9-1", "2026-09-01"],
      ["1 9 2026", "2026-09-01"],
      ["1\u20139\u20132026", null],
      ["\uFF11.\uFF19.\uFF12\uFF10\uFF12\uFF16", "2026-09-01"],
    ],
  },
  {
    locale: "en-US",
    browser: "de-DE",
    zone: "Pacific/Kiritimati",
    cases: [
      ["9/1/2026", "2026-09-01"],
      ["09-01-2026", "2026-09-01"],
      ["2026/09/01", null],
      ["13/1/2026", null],
      ["9/31/2026", null],
      ["+9/1/2026", null],
    ],
  },
  {
    locale: "en-US",
    browser: "en-US",
    zone: "Pacific/Pago_Pago",
    cases: [
      ["3/8/2026", "2026-03-08"],
      ["9/30/2026", "2026-09-30"],
    ],
  },
  {
    locale: "ja-JP",
    browser: "en-US",
    zone: "Asia/Seoul",
    cases: [
      ["2026/9/1", "2026-09-01"],
      ["\uFF12\uFF10\uFF12\uFF16/\uFF19/\uFF11", "2026-09-01"],
      ["2026\u5E749\u67081\u65E5", null],
      ["26/9/1", null],
    ],
  },
  {
    locale: "ar-EG",
    browser: "en-US",
    zone: "UTC",
    cases: [
      ["\u0660\u0661/\u0660\u0669/\u0662\u0660\u0662\u0666", "2026-09-01"],
      ["01/09/2026", "2026-09-01"],
    ],
  },
  {
    locale: "th-TH",
    browser: "en-US",
    zone: "UTC",
    cases: [
      ["01/09/2026", "2026-09-01"],
      ["01/09/2569", null],
    ],
  },
  {
    locale: "bg-BG",
    browser: "en-US",
    zone: "UTC",
    full: true,
    cases: [
      ["01.09.2026", "2026-09-01"],
      ["01.09.2026 \u0433.", "2026-09-01"],
    ],
  },
  {
    locale: "fa-IR",
    browser: "en-US",
    zone: "UTC",
    full: true,
    cases: [["2026/09/01", "2026-09-01"]],
  },
];

describe("custom range fields read a typed day the same in every browser", () => {
  const shown = FIELDS.filter((f) => FULL || !f.full);
  const roots: Record<string, string> = {};

  beforeAll(async () => {
    const explorer = fromYaml(
      await readFile(path.join(EXAMPLE, "dashboards/explorer.yaml"), "utf8"),
    );
    for (const locale of new Set(shown.map((f) => f.locale))) {
      const at = await writeExample({ locale }, { explorer });
      expect((await buildProject(at)).code).toBe(0);
      roots[locale] = at;
    }
  }, 300_000);

  for (const { locale, browser, zone, cases } of shown) {
    it(`${locale} fields in a ${browser} browser, ${zone}`, async () => {
      const context = await (engines.chromium as Browser).newContext({
        locale: browser,
        timezoneId: zone,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(
        `file://${path.join(roots[locale] as string, "dist", "explorer", "index.html")}`,
      );
      await page.locator(".hm-period-button").click();
      const start = page.locator("[data-hm-edge=start]");
      const results: Case[] = [];
      for (const [typed] of cases) {
        await start.fill("");
        await start.press("Tab");
        await start.fill(typed);
        await start.press("Tab");
        const invalid = (await start.getAttribute("aria-invalid")) === "true";
        const selected = await page.$$eval("[data-day][aria-selected=true]", (days) =>
          days.map((d) => d.getAttribute("data-day")),
        );
        results.push([typed, invalid ? null : (selected[0] ?? null)]);
      }
      expect(results).toEqual(cases);
      expect(errors).toEqual([]);
      await context.close();
    });
  }
});

const TIED = ["Zebra", "Þingvellir", "Ærø", "Ásbyrgi", "Asbyrgi"];

async function ranged(locale: string): Promise<string> {
  const lines = [
    "2026-01-02,Ærø,100",
    "2026-01-15,Reykjavík,50",
    ...TIED.map((name) => `2026-01-15,${name},10`),
  ];
  const { root } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      locale,
      name: "Ranges",
      sources: { orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } } },
    },
    "orders.csv": `day,name,amount\n${lines.join("\n")}\n`,
    "metrics/amount.yaml": metric({
      table: "orders",
      time: "day",
      type: "aggregate",
      aggregate: "sum",
      column: "amount",
    }),
    "dashboards/probe.yaml": {
      title: "Probe",
      period: { asOf: "2026-01-31", range: "all_time", compare: "none" },
      filters: [
        {
          type: "period",
          id: "period",
          options: [{ last: 30, unit: "day" }],
          default: { last: 30, unit: "day" },
        },
      ],
      blocks: [{ type: "table", by: ["name"], metrics: ["amount"], limit: 4, other: true }],
    },
  });
  expect((await buildProject(root)).code).toBe(0);
  return `file://${path.join(root, "dist", "probe", "index.html")}`;
}

describe("a custom range drawn in the browser cuts tied text keys like the build", () => {
  it("is-IS page in an en-US chromium: ties at the limit follow Icelandic order", async () => {
    const context = await (engines.chromium as Browser).newContext({ locale: "en-US" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${await ranged("is-IS")}?period=2026-01-10..2026-01-20`);
    await page.waitForFunction(
      () =>
        !document.querySelector("main.hm-grid")?.hasAttribute("aria-busy") &&
        new URL(location.href).searchParams.get("period") === "2026-01-10..2026-01-20" &&
        !document.querySelector(".hm-table tbody")?.textContent?.includes("100"),
    );
    const rows = await page.$$eval(".hm-table tbody tr", (trs) =>
      trs.map((tr) => [
        (tr as HTMLElement).dataset.hmKind,
        (tr as HTMLTableRowElement).cells[0]?.getAttribute("data-v"),
        (tr as HTMLTableRowElement).cells[1]?.getAttribute("data-v"),
      ]),
    );
    expect(rows).toEqual([
      ["row", "Reykjavík", "50"],
      ["row", "Asbyrgi", "10"],
      ["row", "Ásbyrgi", "10"],
      ["row", "Zebra", "10"],
      ["other", "Other", "20"],
    ]);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("calendar month and weekday names never follow the viewer's locale", () => {
  const headings = async (locale: string, viewer: string) => {
    const context = await (engines.chromium as Browser).newContext({ locale: viewer });
    const page = await context.newPage();
    await page.goto(await ranged(locale));
    await page.locator(".hm-period-button").click();
    const months = await page.locator(".hm-month-name").allTextContents();
    const weekdays = await page.locator(".hm-days thead th").allTextContents();
    const supported = await page.evaluate(
      (tag) => Intl.DateTimeFormat.supportedLocalesOf(tag).length > 0,
      locale,
    );
    await context.close();
    return { months, weekdays: [...new Set(weekdays)], supported };
  };

  it("ja-JP page in a fr-FR browser: Japanese names", async () => {
    const { months, weekdays } = await headings("ja-JP", "fr-FR");
    expect(months).toEqual(["2026年1月", "2026年2月"]);
    expect(weekdays).toEqual(["月", "火", "水", "木", "金", "土", "日"]);
  });

  it("is-IS page in a fr-FR browser: Icelandic names, or en-US when the browser lacks them", async () => {
    const { months, weekdays, supported } = await headings("is-IS", "fr-FR");
    expect(months).toEqual(
      supported ? ["janúar 2026", "febrúar 2026"] : ["January 2026", "February 2026"],
    );
    expect(weekdays).toEqual(
      supported
        ? ["mán.", "þri.", "mið.", "fim.", "fös.", "lau.", "sun."]
        : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    );
  });
});
