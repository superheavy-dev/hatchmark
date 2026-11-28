/// <reference lib="dom" />
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, KpiData } from "../../src/compiler/dashboard-data.js";
import {
  customRangeDashboard,
  type PeriodData,
  type SegmentData,
} from "../../src/compiler/index.js";
import { formatValue } from "../../src/render/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { buildProject, metric, Oracle, removeProjects, writeProject } from "../node/fixture.js";

const LABELS = {
  revenue: "Revenue",
  orders: "Orders",
  refund_rate: "Refund rate",
  aov: "Average order",
} as const;
type Name = keyof typeof LABELS;
const NAMES = Object.keys(LABELS) as Name[];
const TOGGLES = ["americas", "big", "nowhere"];

let browser: Browser;
let root: string;

async function project(withPeriod: boolean): Promise<string> {
  const base = { type: "aggregate", table: "orders", time: "ordered_at" };
  const { root } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "toggle-runtime",
      timezone: "America/New_York",
      sources: { orders: { type: "parquet", path: "data/orders.parquet" } },
    },
    "segments/americas.yaml": {
      label: "Americas",
      filters: [{ column: "region", op: "eq", value: "Americas" }],
    },
    "segments/big.yaml": {
      label: "Big orders",
      filters: [{ column: "amount", op: "gte", value: 100 }],
    },
    "segments/nowhere.yaml": {
      label: "Antarctica",
      filters: [{ column: "region", op: "eq", value: "Antarctica" }],
    },
    "metrics/revenue.yaml": {
      ...metric({ ...base, aggregate: "sum", column: "amount" }, { type: "currency" }),
      label: LABELS.revenue,
    },
    "metrics/orders.yaml": { ...metric({ ...base, aggregate: "count" }), label: LABELS.orders },
    "metrics/refunded.yaml": {
      ...metric({
        ...base,
        aggregate: "count",
        filters: [{ column: "status", op: "eq", value: "refunded" }],
      }),
      label: "Refunded",
    },
    "metrics/refund_rate.yaml": {
      ...metric(
        { type: "ratio", numerator: "refunded", denominator: "orders" },
        { type: "percent" },
      ),
      label: LABELS.refund_rate,
    },
    "metrics/aov.yaml": {
      ...metric({ ...base, aggregate: "avg", column: "amount" }, { type: "currency" }),
      label: LABELS.aov,
    },
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
      filters: [
        ...(withPeriod
          ? [
              {
                type: "period",
                id: "period",
                options: [{ last: 30, unit: "day" }, "last_12_months"],
                default: "last_12_months",
                custom: true,
              },
            ]
          : []),
        { type: "segment", id: "audience", label: "Audience", segments: TOGGLES, default: ["big"] },
      ],
      blocks: NAMES.map((m) => ({ type: "kpi", id: m, metric: m })),
    },
  });
  await mkdir(path.join(root, "data"), { recursive: true });
  const oracle = await Oracle.open();
  await oracle.run(
    "CREATE TABLE o AS SELECT (now() - to_hours(i * 5 + 1))::TIMESTAMPTZ AS ordered_at, " +
      "CASE WHEN i < 300 AND i % 3 = 0 THEN 'Americas' WHEN i % 3 = 1 THEN 'EMEA' ELSE 'APAC' END AS region, " +
      "((i * 37) % 250)::DOUBLE AS amount, CASE WHEN i % 7 = 0 THEN 'refunded' ELSE 'paid' END AS status FROM range(0, 1800) t(i)",
  );
  await oracle.run(
    "COPY o TO '" + path.join(root, "data", "orders.parquet") + "' (FORMAT parquet)",
  );
  oracle.close();
  expect((await buildProject(root)).code).toBe(0);
  return root;
}

let noPeriod: string;
beforeAll(async () => {
  root = await project(true);
  noPeriod = await project(false);
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await removeProjects();
});

async function embedded(at: string): Promise<SegmentData> {
  const html = await readFile(path.join(at, "dist", "d", "index.html"), "utf8");
  return JSON.parse(html.match(/data-hm-segments[^>]*>(.*?)<\/script>/s)?.[1] ?? "{}");
}

function texts(data: DashboardData): Record<Name, string> {
  return Object.fromEntries(
    NAMES.map((m) => {
      const k = data.blocks.find((b): b is KpiData => b.type === "kpi" && b.metric === m);
      const info = data.metrics[m];
      if (!k || !info) throw new Error("no kpi " + m);
      return [m, formatValue(k.value, info, data.locale, "headline")];
    }),
  ) as Record<Name, string>;
}

async function open(at: string, query = ""): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + path.join(at, "dist", "d", "index.html") + query);
  return { page, errors };
}

const idle = async (page: Page) => {
  await page.waitForTimeout(150);
  await page.waitForFunction(
    () => !document.querySelector("main.hm-grid")?.hasAttribute("aria-busy"),
  );
  await page.waitForTimeout(150);
};

async function shown(page: Page): Promise<Record<Name, string>> {
  const out: Record<string, string> = {};
  for (const m of NAMES)
    out[m] =
      (await page
        .locator(".hm-kpi", { hasText: LABELS[m] })
        .locator(".hm-kpi-value")
        .first()
        .textContent()) ?? "";
  return out as Record<Name, string>;
}

async function pressed(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-hm-segment]")]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.dataset.hmSegment)
      .join(","),
  );
}

async function preset(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () =>
      document.querySelector<HTMLElement>("[data-hm-preset][aria-checked=true]")?.dataset.hmPreset,
  );
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const canonical = (key: string) => (key === "big" ? null : key);

describe("segment toggle runtime against the embedded combinations", () => {
  it("rapid toggling without a period filter ends on the pressed combination", async () => {
    const { states } = await embedded(noPeriod);
    for (let run = 0; run < 4; run++) {
      const { page, errors } = await open(noPeriod);
      const random = rng(run + 1);
      for (let i = 0; i < 9; i++)
        await page
          .locator('[data-hm-segment="' + TOGGLES[Math.floor(random() * 3)] + '"]')
          .click({ delay: 0 });
      await idle(page);
      const key = await pressed(page);
      const want = states[key]?.data;
      if (!want) throw new Error("no state " + key);
      expect(await shown(page), "run " + run + " key " + key).toEqual(texts(want));
      expect(new URL(page.url()).searchParams.get("audience")).toBe(canonical(key));
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  it("rapid toggling keeps the chosen preset and shows that combination's preset", async () => {
    const { states } = await embedded(root);
    for (let run = 0; run < 4; run++) {
      const { page, errors } = await open(root, "?period=last_30_days");
      const random = rng(run + 11);
      for (let i = 0; i < 9; i++)
        await page
          .locator('[data-hm-segment="' + TOGGLES[Math.floor(random() * 3)] + '"]')
          .click({ delay: 0 });
      await idle(page);
      const key = await pressed(page);
      const want = states[key]?.periods?.presets.last_30_days;
      if (!want) throw new Error("no preset for " + key);
      expect(await preset(page)).toBe("last_30_days");
      expect(await shown(page), "run " + run + " key " + key).toEqual(texts(want));
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  it("a preset chosen after a toggle comes from the toggled combination", async () => {
    const { states } = await embedded(root);
    const { page, errors } = await open(root);
    await page.locator('[data-hm-segment="americas"]').click();
    await idle(page);
    await page.locator(".hm-period-button").click();
    await page.locator('[data-hm-preset="last_30_days"]').click();
    await idle(page);
    const want = states["americas,big"]?.periods?.presets.last_30_days;
    if (!want) throw new Error("no preset");
    expect(await shown(page)).toEqual(texts(want));
    expect(new URL(page.url()).search).toBe("?audience=americas%2Cbig&period=last_30_days");
    await page.reload();
    await idle(page);
    expect(await pressed(page)).toBe("americas,big");
    const got = await shown(page);
    console.log(
      "RELOAD",
      await preset(page),
      new URL(page.url()).search,
      await page.locator(".hm-period-name").textContent(),
    );
    const which = Object.entries(states).flatMap(([k, s]) =>
      Object.entries(s.periods?.presets ?? {}).flatMap(([p, d]) =>
        JSON.stringify(texts(d)) === JSON.stringify(got) ? [k + " " + p] : [],
      ),
    );
    expect(
      got,
      "after reload the page shows " + which.join(" or ") + "; URL " + new URL(page.url()).search,
    ).toEqual(texts(want));
    expect(await preset(page)).toBe("last_30_days");
    expect(errors).toEqual([]);
    await page.close();
  });

  for (const target of ["nowhere", "americas"]) {
    it(
      "a custom range then a toggle into " +
        target +
        " never leaves the previous combination's numbers",
      async () => {
        const { states } = await embedded(root);
        const from = states.big?.periods as PeriodData;
        const span = from.custom?.span;
        if (!span) throw new Error("no custom span");
        const range = { start: span.start, end: addDays(span.start, 40) };
        const key = range.start + ".." + addDays(range.end, -1);
        const { page, errors } = await open(root, "?period=" + key);
        await idle(page);
        const before = texts(
          customRangeDashboard(from.custom as NonNullable<PeriodData["custom"]>, "period", range),
        );
        expect(await shown(page)).toEqual(before);
        await page.locator('[data-hm-segment="' + target + '"]').click();
        await idle(page);
        const now = await pressed(page);
        const next = states[now]?.periods as PeriodData;
        const options: Record<Name, string>[] = [
          texts(next.presets.last_12_months as DashboardData),
        ];
        if (next.custom && next.custom.span.start <= range.start)
          options.push(texts(customRangeDashboard(next.custom, "period", range)));
        const got = await shown(page);
        const period = new URL(page.url()).searchParams.get("period");
        const name = await page.locator(".hm-period-name").textContent();
        expect(
          options.some((o) => JSON.stringify(o) === JSON.stringify(got)),
          "after turning on " +
            target +
            " (" +
            now +
            ") the page shows " +
            JSON.stringify(got) +
            " (previous combination " +
            JSON.stringify(before) +
            "), URL period=" +
            period +
            ", label " +
            name,
        ).toBe(true);
        expect(errors).toEqual([]);
        await page.close();
      },
    );
  }

  it("reads reordered, duplicated, unknown and none URL states", async () => {
    const { states } = await embedded(noPeriod);
    const cases: [string, string, string | null][] = [
      ["?audience=nowhere,americas", "americas,nowhere", "americas,nowhere"],
      ["?audience=big,big", "big", null],
      ["?audience=bogus", "big", null],
      ["?audience=", "", ""],
      ["?audience=none", "big", null],
    ];
    for (const [query, key, url] of cases) {
      const { page, errors } = await open(noPeriod, query);
      await idle(page);
      expect(await pressed(page), query).toBe(key);
      expect(await shown(page), query).toEqual(texts(states[key]?.data as DashboardData));
      if (url !== null) expect(new URL(page.url()).searchParams.get("audience"), query).toBe(url);
      expect(errors).toEqual([]);
      await page.close();
    }
  });
});

function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
