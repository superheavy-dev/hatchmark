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

/** A one-column table on numeric and multi-line keys, in a locale whose number format differs. */
const keyed = (id: string, keys: (string | number)[]): DashboardData => ({
  ...dashboard(id, id, [
    {
      ...TRICKY,
      id,
      by: [{ column: "key", label: "Key" }],
      rows: keys.map((key, i) => ({ keys: [key], values: { revenue: i + 0.123456789012345 } })),
      rowCount: keys.length,
    },
  ]),
  locale: "de-DE",
});

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
    teams: variant("table-group-teams"),
    cities: variant("table-group-cities"),
    products: variant("table-group-products"),
    deep: dashboard("deep", "Deep", [
      {
        ...TRICKY,
        id: "deep",
        by: [
          { column: "region", label: "Region" },
          { column: "country", label: "Country" },
          { column: "city", label: "City" },
        ],
        rows: [
          { keys: ["Europe", "Germany", "Berlin"], values: { revenue: 30 } },
          { keys: ["North America", "Canada", "Toronto"], values: { revenue: 20 } },
          { keys: ["Europe", "France", "Paris"], values: { revenue: 10 } },
        ],
        rowCount: 3,
      },
    ]),
    bars: variant("table-bars-negative"),
    tricky: dashboard("tricky", "Tricky", [TRICKY]),
    numeric: keyed("numeric", [2, -2, 1000, -10]),
    mixed: dashboard("mixed", "Mixed", [
      {
        ...TRICKY,
        id: "mixed",
        by: [
          { column: "label", label: "Label" },
          { column: "item", label: "Item" },
        ],
        rows: [
          { keys: [1000, "a"], values: { revenue: 10 } },
          { keys: ["1000", "b"], values: { revenue: 20 } },
          { keys: ["zzz", "z"], values: { revenue: 30 } },
        ],
        rowCount: 3,
      },
    ]),
    lines: keyed("lines", [
      1000.1234567,
      0.0044,
      0.00449,
      "alpha\r\nbeta",
      "alpha\rbeta",
      "alpha\nbeta",
      '"é", two',
    ]),
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

describe("review regressions (HAT-55)", () => {
  it("sorts a numeric grouping column by value, not by its formatted text", async () => {
    const page = await open("numeric");
    await page.getByRole("button", { name: "Key", exact: true }).press("Enter");
    expect(await page.locator("tbody .hm-key span").allTextContents()).toEqual([
      "−10",
      "−2",
      "2",
      "1.000",
    ]);
    await page.close();
  });

  it("keeps the number 1000 and the text 1000 as two groups after a sort", async () => {
    const page = await open("mixed");
    const labels = () =>
      page
        .locator("tbody th span")
        .evaluateAll((spans) => spans.map((s) => [s.textContent, s.classList.contains("hm-sr")]));
    const expected = [
      ["1,000", false],
      ["1000", false],
      ["zzz", false],
    ];
    await page.getByRole("button", { name: "Item", exact: true }).click();
    expect(await labels()).toEqual(expected);
    await page.close();
  });

  it("exports grouping values unformatted, line breaks included", async () => {
    const page = await open("lines");
    const text = await download(page);
    const body = text.slice(text.indexOf("\r\n") + 2);
    const keys = [
      1000.1234567,
      0.0044,
      0.00449,
      "alpha\r\nbeta",
      "alpha\rbeta",
      "alpha\nbeta",
      '"é", two',
    ];
    const expected = keys.map((key, i) => {
      const field = String(key);
      const quoted = /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
      return `${quoted},${i + 0.123456789012345}`;
    });
    expect(body.startsWith(`${expected.join("\r\n")}\r\n`)).toBe(true);
    await page.close();
  });

  it("keeps a focused header out from under the pinned first column (390 px)", async () => {
    const page = await open("tall", 390);
    const wrap = page.locator(".hm-table-wrap");
    await wrap.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    const info = await page.evaluate(() => {
      const button = document.activeElement as HTMLElement;
      const r = button.getBoundingClientRect();
      const pinned = document.querySelector(".hm-table thead th")?.getBoundingClientRect();
      return { name: button.textContent?.trim(), left: r.left, pinned: pinned?.right ?? 0 };
    });
    expect(info.name).toBe("% of total");
    expect(info.left).toBeGreaterThanOrEqual(info.pinned);
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
      const cells = await page.$$eval("tfoot tr > *", (ns) =>
        ns.map((n) => ({
          position: getComputedStyle(n).position,
          bottom: n.getBoundingClientRect().bottom,
        })),
      );
      for (const cell of cells) {
        expect(cell.position).toBe("sticky");
        expect(Math.abs(cell.bottom - foot)).toBeLessThan(0.5);
      }
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

describe("in-cell bar and scrollbar layout", () => {
  /** Each column's track left and right edges across the body rows that draw one. */
  const tracks = (page: Page) =>
    page.$$eval(".hm-table tbody tr", (trs) => {
      const columns: Record<number, { left: number; right: number }[]> = {};
      for (const tr of trs)
        [...tr.children].forEach((cell, i) => {
          const track = cell.querySelector(".hm-track");
          if (!track) return;
          const r = track.getBoundingClientRect();
          columns[i] = [...(columns[i] ?? []), { left: r.left, right: r.right }];
        });
      return Object.values(columns);
    });
  const aligned = (columns: { left: number; right: number }[][]) => {
    expect(columns.length).toBeGreaterThan(0);
    for (const edges of columns) {
      expect(edges.length).toBeGreaterThan(1);
      const lefts = edges.map((e) => e.left);
      const rights = edges.map((e) => e.right);
      expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(0.5);
      expect(Math.max(...rights) - Math.min(...rights)).toBeLessThan(0.5);
    }
  };

  for (const name of ["subtotals", "bars", "top"]) {
    it(`starts and ends every bar track of a column at the same x, before and after a sort (${name})`, async () => {
      const page = await open(name);
      aligned(await tracks(page));
      await page.locator("thead th").last().locator("button").click();
      aligned(await tracks(page));
      await page.close();
    });
  }

  it("keeps the last column a cell padding clear of the scrollbar, with header, body and total aligned", async () => {
    const classic = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    const page = await classic.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(urls.tall ?? "");
    await page.addStyleTag({ content: ".hm-tall::-webkit-scrollbar{width:15px;background:#888}" });
    const box = await page.$eval(".hm-table-wrap", (node) => {
      const wrap = node as HTMLElement;
      const last = (selector: string) => {
        const cell = wrap.querySelector(selector) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(cell);
        return {
          cell: cell.getBoundingClientRect().right,
          text: range.getBoundingClientRect().right,
        };
      };
      const r = wrap.getBoundingClientRect();
      const style = getComputedStyle(wrap);
      return {
        scrollbar: wrap.offsetWidth - wrap.clientWidth - wrap.clientLeft * 2,
        edge: r.left + wrap.clientLeft + wrap.clientWidth,
        padding: Number.parseFloat(style.paddingRight),
        head: last("thead tr > :last-child"),
        body: last("tbody tr > :last-child"),
        foot: last("tfoot tr > :last-child"),
      };
    });
    expect(box.scrollbar).toBeGreaterThan(0);
    expect(box.edge - box.body.text).toBeGreaterThanOrEqual(16);
    expect(Math.abs(box.head.cell - box.body.cell)).toBeLessThan(0.5);
    expect(Math.abs(box.foot.cell - box.body.cell)).toBeLessThan(0.5);
    expect(Math.abs(box.foot.text - box.body.text)).toBeLessThan(0.5);
    await classic.close();
  });
});

describe("narrow layouts of grouped tables", () => {
  /** Visible text of the narrow-only labels in each body row, with the row's outer key values. */
  const labels = (page: Page) =>
    page.$$eval(".hm-table tbody tr", (trs) =>
      trs
        .filter((tr) => getComputedStyle(tr).display !== "none")
        .map((tr) => {
          const fill = tr.querySelector(".hm-fill");
          const mobile = [...(fill?.querySelectorAll<HTMLElement>(".hm-m") ?? [])];
          return {
            kind: (tr as HTMLElement).dataset.hmKind,
            outer: [...tr.querySelectorAll(".hm-outer")].map((c) => c.getAttribute("data-v")),
            label: mobile.filter((m) => m.offsetHeight > 0).map((m) => m.textContent),
            hidden: mobile.every((m) => m.getAttribute("aria-hidden") === "true"),
          };
        }),
    );
  const columns = (page: Page) =>
    page.$$eval(".hm-table thead th.hm-key", (ths) =>
      ths.map((th) => ({
        width: th.getBoundingClientRect().width,
        position: getComputedStyle(th).position,
        left: getComputedStyle(th).left,
      })),
    );

  it("with subtotals, names each group in a full-width row and pins only the innermost key column (390px)", async () => {
    const page = await open("subtotals", 390);
    const [outer, inner] = await columns(page);
    expect(outer?.width).toBeLessThan(1);
    expect(inner?.left).toBe("0px");
    const before = await labels(page);
    for (const row of before.filter((r) => r.kind === "subtotal"))
      expect(row.label).toEqual(row.outer);
    const leaves = await page.$$eval("tbody tr[data-hm-kind=row]", (trs) =>
      trs.map((tr) => tr.hasAttribute("data-hm-lead")),
    );
    before
      .filter((r) => r.kind === "row")
      .forEach((row, i) => {
        expect(row.label).toEqual(leaves[i] ? row.outer : []);
      });
    expect(before.every((r) => r.hidden)).toBe(true);
    const wrap = page.locator(".hm-table-wrap");
    await wrap.evaluate((n) => {
      n.scrollLeft = 400;
    });
    const edges = await page.evaluate(() => ({
      wrap: document.querySelector(".hm-table-wrap")?.getBoundingClientRect().left,
      fill: document.querySelector("tbody .hm-fill")?.getBoundingClientRect().left,
    }));
    expect(Math.abs((edges.fill ?? 0) - (edges.wrap ?? 0))).toBeLessThan(1);
    await page.locator("thead th").nth(2).locator("button").click();
    expect(await labels(page)).toHaveLength(before.length);
    for (const row of (await labels(page)).filter((r) => r.kind === "subtotal"))
      expect(row.label).toEqual(row.outer);
    await page.close();
  });

  it("without subtotals, shows the outer value under the inner one, also after a sort by a metric (390px)", async () => {
    const page = await open("two", 390);
    const header = await page.$eval("thead th.hm-fill", (th) => th.textContent);
    expect(header).toBe("CountryRegion");
    const check = async () => {
      for (const row of (await labels(page)).filter((r) => r.kind === "row"))
        expect(row.label).toEqual(row.outer);
    };
    await check();
    await page.locator("thead th").last().locator("button").click();
    await check();
    await page.close();
    const deep = await open("deep", 390);
    expect((await labels(deep)).map((r) => r.label)).toEqual([
      ["Europe · Germany"],
      ["North America · Canada"],
      ["Europe · France"],
    ]);
    await deep.close();
  });

  it("keeps the desktop layout unchanged above the narrow breakpoint", async () => {
    for (const name of ["subtotals", "two"]) {
      const page = await open(name);
      const [outer] = await columns(page);
      expect(outer?.width).toBeGreaterThan(100);
      expect((await labels(page)).every((r) => r.label.length === 0)).toBe(true);
      await page.close();
    }
  });

  it("indents the three levels of a deep subtotal table", async () => {
    const page = await open("cities", 390);
    const x = (selector: string) =>
      page.$eval(selector, (n) => {
        const range = document.createRange();
        range.selectNodeContents(n);
        return (
          range.getBoundingClientRect().left -
          (n.closest("td,th")?.getBoundingClientRect().left ?? 0)
        );
      });
    const one = await x('tr[data-hm-level="1"] .hm-fill .hm-m');
    const two = await x('tr[data-hm-level="2"] .hm-fill .hm-m');
    const leaf = await x('tr[data-hm-kind="row"] .hm-fill span');
    expect(two).toBeGreaterThan(one);
    expect(leaf).toBeGreaterThan(two);
    await page.close();
  });

  for (const width of [1280, 390]) {
    it(`folds a one-row group into its row instead of repeating its numbers (${width}px)`, async () => {
      const page = await open("teams", width);
      const visible = await page.$$eval(".hm-table tbody tr", (trs) =>
        trs
          .filter((tr) => getComputedStyle(tr).display !== "none")
          .map((tr) => tr.querySelector("td[data-v]:not(.hm-key)")?.getAttribute("data-v")),
      );
      expect(visible.filter((v) => v === "74900")).toHaveLength(1);
      const row = page.locator("tbody tr[data-hm-lead]");
      if (width === 1280) {
        expect(
          await row.locator(".hm-outer span").evaluate((s) => s.classList.contains("hm-sr")),
        ).toBe(false);
      } else {
        expect(await row.locator(".hm-fill .hm-msub").textContent()).toBe("Partnerships");
      }
      await page.close();
    });
  }

  it("keeps each row's group readable to screen readers on a phone", async () => {
    const page = await open("two", 390);
    const outer = await page.$$eval("tbody .hm-outer > span", (spans) =>
      spans.map((s) => ({ display: getComputedStyle(s).display, text: s.textContent })),
    );
    expect(outer.length).toBeGreaterThan(0);
    for (const span of outer) {
      expect(span.display).not.toBe("none");
      expect(span.text).not.toBe("");
    }
    await page.close();
  });

  it("skips hidden outer headers in keyboard order and keeps a focused header clear of the pinned column", async () => {
    const page = await open("subtotals", 390);
    await page.locator(".hm-table-wrap").evaluate((n) => {
      n.scrollLeft = n.scrollWidth;
    });
    await page.locator("button[data-hm-csv]").focus();
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      const th = await page.evaluate(
        () => document.activeElement?.closest("th")?.textContent ?? "",
      );
      if (th !== "") order.push(th);
    }
    expect(order[0]).toBe("Country");
    expect(order[1]).toBe("Revenue");
    const [fill, focused] = await page.evaluate(() => [
      document.querySelector("thead .hm-fill")?.getBoundingClientRect().right ?? 0,
      (document.activeElement as HTMLElement).getBoundingClientRect().left,
    ]);
    expect(focused).toBeGreaterThanOrEqual(fill);
    await page.close();
  });
});

describe("preview-only scrollbar options", () => {
  it("draws a thin themed scrollbar with ?scroll=thin", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${urls.tall}?scroll=thin`);
    const style = await page.$eval(".hm-table-wrap", (n) => ({
      width: getComputedStyle(n).scrollbarWidth,
      color: getComputedStyle(n).scrollbarColor,
    }));
    expect(style.width).toBe("thin");
    expect(style.color).not.toBe("auto");
    await page.close();
  });

  for (const width of [1280, 390]) {
    it(`lets a tall table grow with the page and pins its header and total to the viewport with ?scroll=page (${width}px)`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      await page.goto(`${urls.tall}?scroll=page`);
      const wrap = page.locator(".hm-table-wrap");
      expect(await wrap.evaluate((n) => n.scrollHeight - n.clientHeight)).toBeLessThan(2);
      const top = await wrap.evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
      await page.evaluate((y) => window.scrollTo(0, y), top + 500);
      await page.waitForTimeout(100);
      const box = await page.evaluate(() => ({
        head: document.querySelector("thead th")?.getBoundingClientRect().top ?? -1,
        foot: document.querySelector("tfoot th")?.getBoundingClientRect().bottom ?? -1,
        cells: [...document.querySelectorAll("tfoot tr > *")].map(
          (c) => c.getBoundingClientRect().bottom,
        ),
      }));
      expect(Math.abs(box.head)).toBeLessThan(1);
      expect(Math.abs(box.foot - 700)).toBeLessThan(1);
      for (const bottom of box.cells) expect(Math.abs(bottom - box.foot)).toBeLessThan(1);
      await page.close();
    });
  }
});
