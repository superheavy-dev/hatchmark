/// <reference lib="dom" />
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboard } from "../../gallery/fixtures.js";
import { GALLERY } from "../../gallery/variants.js";
import type { DashboardData, TableData } from "../../src/compiler/dashboard-data.js";
import { FONT_FILES, renderDashboardPage } from "../../src/render/index.js";

/** Table interactions in Chromium: sorting by mouse and keyboard, the CSV download, the sticky header. */
let browser: Browser;
let dir: string;
const urls: Record<string, string> = {};

const variant = (name: string): DashboardData => {
  const found = GALLERY.find((v) => v.variant === name)?.data;
  if (!found) throw new Error(`gallery variant ${name} is missing`);
  return found;
};

const TRICKY: TableData = {
  type: "table",
  id: "tricky",
  title: "Keys a spreadsheet would misread",
  span: 12,
  by: [{ column: "name", label: "Name" }],
  metrics: ["revenue"],
  percentOfTotal: [],
  rows: [
    { keys: ['=HYPERLINK("http://example.com")'], values: { revenue: 3 } },
    { keys: ["-5 widgets"], values: { revenue: 2.5 } },
    { keys: ['Quote "this", please'], values: { revenue: 0.1 + 0.2 } },
    { keys: [null], values: { revenue: null } },
  ],
  rowCount: 4,
  total: { values: { revenue: 5.8 } },
  sort: { by: "revenue", order: "desc" },
};

beforeAll(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-table-"));
  const assets = new URL("../../assets/", import.meta.url);
  await cp(new URL("runtime/hatchmark.js", assets), path.join(dir, "hatchmark.js"));
  const fonts: Record<string, string> = {};
  for (const font of FONT_FILES) {
    await cp(new URL(`fonts/${font.file}`, assets), path.join(dir, font.file));
    fonts[font.file] = font.file;
  }
  const pages: Record<string, DashboardData> = {
    top: variant("table-top-other"),
    subtotals: variant("table-subtotals-other"),
    two: variant("table-two-columns"),
    tall: variant("table-tall"),
    bars: variant("table-bars-negative"),
    tricky: dashboard("tricky", "Tricky", [TRICKY]),
  };
  for (const [name, data] of Object.entries(pages)) {
    await writeFile(
      path.join(dir, `${name}.html`),
      renderDashboardPage(data, { assets: { runtime: "hatchmark.js", fonts } }),
    );
    urls[name] = `file://${path.join(dir, `${name}.html`)}`;
  }
});

afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(name: string, width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true });
  await page.goto(urls[name] ?? "");
  return page;
}

/** Each body row as [kind, key text..., first value]. */
const rows = (page: Page) =>
  page.$$eval(".hm-table tbody tr", (trs) =>
    trs.map((tr) => [
      (tr as HTMLElement).dataset.hmKind,
      ...[...tr.querySelectorAll(".hm-key")].map((c) => c.getAttribute("data-v")),
    ]),
  );

const column = (page: Page, index: number) =>
  page.$$eval(
    ".hm-table tbody tr",
    (trs, i) => trs.map((tr) => (tr as HTMLTableRowElement).cells[i]?.getAttribute("data-v")),
    index,
  );

const sortState = (page: Page) =>
  page.$$eval(".hm-table thead th", (ths) => ths.map((th) => th.getAttribute("aria-sort")));

async function download(page: Page): Promise<string> {
  const [file] = await Promise.all([page.waitForEvent("download"), page.click(".hm-csv")]);
  const target = path.join(dir, `${Math.random().toString(36).slice(2)}.csv`);
  await file.saveAs(target);
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  return readFile(target, "utf8");
}

describe("sorting", () => {
  it("sorts a metric descending on the first click and ascending on the second, Other kept last", async () => {
    const page = await open("top");
    expect(await sortState(page)).toEqual(["none", "descending", "none", "none", "none"]);
    await page.click("thead th:nth-child(4) button");
    expect(await sortState(page)).toEqual(["none", "none", "none", "descending", "none"]);
    const orders = (await column(page, 3)).map(Number);
    expect(orders.slice(0, -1)).toEqual([...orders.slice(0, -1)].sort((a, b) => b - a));
    expect((await rows(page)).at(-1)?.[0]).toBe("other");
    await page.click("thead th:nth-child(4) button");
    expect((await sortState(page))[3]).toBe("ascending");
    const ascending = (await column(page, 3)).map(Number);
    expect(ascending.slice(0, -1)).toEqual([...ascending.slice(0, -1)].sort((a, b) => a - b));
    expect((await rows(page)).at(-1)?.[0]).toBe("other");
    const live = await page.$eval("section.hm-table > [aria-live]", (n) => n.textContent);
    expect(live).toBe("Sorted by Orders, ascending");
    await page.close();
  });

  it("sorts from the keyboard: Tab to a header, Enter or Space", async () => {
    const page = await open("top");
    await page.focus("thead th:nth-child(1) button");
    await page.keyboard.press("Enter");
    expect((await sortState(page))[0]).toBe("ascending");
    const names = (await rows(page)).filter((r) => r[0] === "row").map((r) => r[1]);
    expect(names).toEqual([...names].sort((a, b) => String(a).localeCompare(String(b))));
    await page.keyboard.press("Space");
    expect((await sortState(page))[0]).toBe("descending");
    await page.close();
  });

  it("moves groups with their subtotal rows and keeps each Other last in its group", async () => {
    const page = await open("subtotals");
    await page.click("thead th:nth-child(3) button");
    expect((await sortState(page))[2]).toBe("ascending");
    const body = await rows(page);
    const subtotals = body.filter((r) => r[0] === "subtotal").map((r) => r[1]);
    const revenues = await page.$$eval("tr[data-hm-kind=subtotal]", (trs) =>
      trs.map((tr) => Number((tr as HTMLTableRowElement).cells[2]?.getAttribute("data-v"))),
    );
    expect(revenues).toEqual([...revenues].sort((a, b) => a - b));
    expect(subtotals.at(-1)).toBe("North America");
    let region: string | null | undefined;
    let sawOther = false;
    for (const [kind, outer] of body) {
      if (kind === "subtotal") {
        region = outer;
        sawOther = false;
        continue;
      }
      expect(outer).toBe(region);
      expect(sawOther).toBe(false);
      if (kind === "other") sawOther = true;
    }
    await page.close();
  });

  it("re-hides repeated outer keys after a sort that regroups a flat two-column table", async () => {
    const page = await open("two");
    await page.click("thead th:nth-child(1) button");
    const hidden = await page.$$eval(".hm-table tbody tr", (trs) =>
      trs.map((tr) => tr.querySelector(".hm-key span")?.classList.contains("hm-sr")),
    );
    expect(hidden[0]).toBe(false);
    expect(hidden.filter(Boolean).length).toBeGreaterThan(0);
    await page.click("thead th:nth-child(3) button");
    const after = await page.$$eval(".hm-table tbody tr", (trs) =>
      trs.map((tr, i, all) => {
        const key = tr.querySelector(".hm-key")?.getAttribute("data-v");
        const previous = all[i - 1]?.querySelector(".hm-key")?.getAttribute("data-v");
        return [key === previous, tr.querySelector(".hm-key span")?.classList.contains("hm-sr")];
      }),
    );
    for (const [same, isHidden] of after) expect(isHidden).toBe(same);
    await page.close();
  });

  it("puts undefined values last in both directions", async () => {
    const page = await open("tricky");
    await page.click("thead th:nth-child(2) button");
    await page.click("thead th:nth-child(2) button");
    for (let i = 0; i < 2; i++) {
      expect((await column(page, 1)).at(-1)).toBe("");
      await page.click("thead th:nth-child(2) button");
    }
    await page.close();
  });
});

describe("CSV download", () => {
  it("is offered once the runtime runs, and saves the rows as shown, with Other and the total", async () => {
    const page = await open("top");
    expect(await page.isVisible(".hm-csv")).toBe(true);
    await page.click("thead th:nth-child(1) button");
    const text = await download(page);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe("Country,Revenue,Revenue share of total,Orders,Average order value");
    const body = lines.slice(1, -2);
    const names = body.map((l) => l.split(",")[0]);
    expect(names.at(-1)).toBe("Other");
    expect(names.slice(0, -1)).toEqual([...names.slice(0, -1)].sort());
    expect(lines.at(-2)?.startsWith("Total,1843209,1,22102,")).toBe(true);
    const us = body.find((l) => l.startsWith("United States,"));
    expect(us?.split(",")[1]).toBe("722538");
    await page.close();
  });

  it("quotes commas and quotes, keeps full precision, and defuses formula-like keys", async () => {
    const page = await open("tricky");
    const lines = (await download(page)).slice(1).split("\r\n");
    expect(lines.slice(0, 6)).toEqual([
      "Name,Revenue",
      '"\'=HYPERLINK(""http://example.com"")",3',
      "'-5 widgets,2.5",
      '"Quote ""this"", please",0.30000000000000004',
      ",",
      "Total,5.8",
    ]);
    await page.close();
  });

  it("writes subtotal rows with a Subtotal label, so the file reads without the layout", async () => {
    const page = await open("subtotals");
    const lines = (await download(page)).slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "Region,Country,Revenue,Revenue share of total,Orders,Average order value",
    );
    expect(lines[1]?.startsWith("North America,Subtotal,")).toBe(true);
    expect(lines[2]?.startsWith("North America,United States,")).toBe(true);
    expect(lines.some((l) => l.startsWith("Europe,Other,"))).toBe(true);
    await page.close();
  });
});

describe("tall tables", () => {
  for (const width of [1280, 390]) {
    it(`keeps the header and total row in view while the rows scroll (${width}px)`, async () => {
      const page = await open("tall", width);
      const wrap = page.locator(".hm-table-wrap");
      expect(await wrap.evaluate((n) => n.classList.contains("hm-tall"))).toBe(true);
      const box = await wrap.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, scroll: n.scrollHeight > n.clientHeight };
      });
      expect(box.scroll).toBe(true);
      await wrap.evaluate((n) => {
        n.scrollTop = 600;
      });
      const head = await page.$eval("thead th", (n) => n.getBoundingClientRect().top);
      const foot = await page.$eval("tfoot th", (n) => n.getBoundingClientRect().bottom);
      expect(Math.abs(head - box.top)).toBeLessThan(2);
      expect(Math.abs(foot - box.bottom)).toBeLessThan(18);
      await page.close();
    });
  }

  it("hides in-cell bars on a phone, like the share bars", async () => {
    const page = await open("bars", 390);
    expect(await page.$eval("td.hm-cellbar .hm-track", (n) => getComputedStyle(n).display)).toBe(
      "none",
    );
    await page.close();
    const desktop = await open("bars");
    expect(
      await desktop.$eval("td.hm-cellbar .hm-track", (n) => getComputedStyle(n).display),
    ).not.toBe("none");
    await desktop.close();
  });
});
