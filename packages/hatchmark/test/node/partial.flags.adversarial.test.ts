import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, Value } from "../../src/compiler/dashboard-data.js";
import { renderFragment } from "../../src/render/page.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const TZ = "America/New_York";
const FULL = process.env.HM_SWEEP === "full";
type Grain = "day" | "week" | "month" | "quarter" | "year";
interface Part {
  label: string;
  metric: string;
  values: Value[];
  partial?: { index: number; elapsed: number; edge?: "start" }[];
}
interface Chart {
  id: string;
  type: string;
  stack?: boolean | string;
  axis: { kind: string; grain: Grain; buckets: string[]; window: { start: string; end: string } };
  series: Part[];
  totals?: Value[] | undefined;
  grains?: {
    options: { key: string; axis: Chart["axis"]; series: Part[]; totals?: Value[] | undefined }[];
  };
}
interface Runtime {
  headers: string[];
  status?: string[];
  totalStatus?: string[];
  heads?: string[];
  series: { label: string; partial?: number[] }[];
}
interface Source {
  name: string;
  column: "at" | "day";
  rows: [string, number, (string | undefined)?][];
}
interface Expect {
  index: number;
  edge?: "start";
  days: number;
  of: number;
  last: string;
  from: string;
  horizon: string;
}

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

function every(
  fromUtc: string,
  toUtc: string,
  hours: number,
  region = false,
): [string, number, (string | undefined)?][] {
  const out: [string, number, (string | undefined)?][] = [];
  const regions = ["North America", "Europe", "Asia-Pacific"];
  let k = 0;
  const end = Date.parse(toUtc);
  for (let t = Date.parse(fromUtc); t < end; t += hours * 3_600_000) {
    out.push([new Date(t).toISOString(), 10 + (k % 7) * 3, region ? regions[k % 3] : undefined]);
    k++;
  }
  out.push([new Date(end).toISOString(), 25, region ? regions[k % 3] : undefined]);
  return out;
}
function daily(fromUtc: string, toUtc: string): [string, number][] {
  const out: [string, number][] = [];
  for (let t = Date.parse(fromUtc); t <= Date.parse(toUtc); t += 86_400_000) {
    out.push([new Date(t).toISOString().slice(0, 10), 7]);
  }
  return out;
}

async function project(sources: Source[], dashboards: Record<string, unknown>) {
  const files: Record<string, unknown> = {
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "HAT-81",
      timezone: TZ,
      weekStart: "sunday",
      locale: "en-US",
      currency: "USD",
      sources: Object.fromEntries(
        sources.map((s) => [s.name, { type: "csv", path: s.name + ".csv" }]),
      ),
    },
  };
  for (const s of sources) {
    const region = s.rows.some((r) => r[2] !== undefined);
    files[s.name + ".csv"] =
      [
        s.column + ",v" + (region ? ",region" : ""),
        ...s.rows.map((r) => r.filter((x) => x !== undefined).join(",")),
      ].join("\n") + "\n";
    files["metrics/" + s.name + ".json"] = metric(
      { type: "aggregate", table: s.name, aggregate: "sum", column: "v", time: s.column },
      { type: "currency" },
    );
  }
  for (const [name, d] of Object.entries(dashboards)) files["dashboards/" + name + ".json"] = d;
  return writeProject(files);
}
async function horizons(root: string, sources: Source[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of sources) {
    const file = path.join(root, s.name + ".csv");
    const [row] = await oracle.rows(
      s.column === "day"
        ? "SELECT strftime(max(CAST(\"day\" AS DATE)) + INTERVAL 1 DAY, '%Y-%m-%d %H:%M:%S.%f') AS h FROM read_csv('" +
            file +
            "', all_varchar = true)"
        : "SELECT strftime(max(timezone('" +
            TZ +
            "', CAST(\"at\" AS TIMESTAMPTZ))) + INTERVAL 1 MICROSECOND, '%Y-%m-%d %H:%M:%S.%f') AS h FROM read_csv('" +
            file +
            "', all_varchar = true)",
    );
    out[s.name] = String(row?.h);
  }
  return out;
}

const trunc = (grain: Grain, ts: string) =>
  grain === "week"
    ? "(CAST(TIMESTAMP '" + ts + "' AS DATE) - CAST(dayofweek(TIMESTAMP '" + ts + "') AS INTEGER))"
    : "CAST(date_trunc('" + grain + "', TIMESTAMP '" + ts + "') AS DATE)";
async function cutBy(
  grain: Grain,
  h: string,
  buckets: string[],
  clipStart?: string,
): Promise<Expect[]> {
  const out: Expect[] = [];
  const [row] = await oracle.rows(
    "WITH b AS (SELECT " +
      trunc(grain, h) +
      " AS s) SELECT strftime(s, '%Y-%m-%d') AS s, " +
      "strftime(s + INTERVAL 1 " +
      grain +
      ", '%Y-%m-%d') AS e, " +
      "date_diff('day', s, s + INTERVAL 1 " +
      grain +
      ") AS m, " +
      "date_diff('day', s, CAST(TIMESTAMP '" +
      h +
      "' - INTERVAL 1 MICROSECOND AS DATE)) + 1 AS n, " +
      "strftime(CAST(TIMESTAMP '" +
      h +
      "' - INTERVAL 1 MICROSECOND AS DATE), '%Y-%m-%d') AS last, " +
      "TIMESTAMP '" +
      h +
      "' > CAST(s AS TIMESTAMP) AS inside FROM b",
  );
  if (clipStart !== undefined) {
    const [c] = await oracle.rows(
      "WITH b AS (SELECT " +
        trunc(grain, clipStart + " 00:00:00") +
        " AS s) SELECT strftime(s, '%Y-%m-%d') AS s, " +
        "date_diff('day', s, s + INTERVAL 1 " +
        grain +
        ") AS m, " +
        "date_diff('day', DATE '" +
        clipStart +
        "', least(s + INTERVAL 1 " +
        grain +
        ", CAST(CAST(TIMESTAMP '" +
        h +
        "' - INTERVAL 1 MICROSECOND AS DATE) + 1 AS TIMESTAMP))) AS n, " +
        "strftime(least(CAST(s + INTERVAL 1 " +
        grain +
        " AS DATE), CAST(TIMESTAMP '" +
        h +
        "' - INTERVAL 1 MICROSECOND AS DATE) + 1) - 1, '%Y-%m-%d') AS last FROM b",
    );
    if (c && String(c.s) < clipStart && String(c.s) === buckets[0]) {
      out.push({
        index: 0,
        edge: "start",
        days: Number(c.n),
        of: Number(c.m),
        last: String(c.last),
        from: clipStart,
        horizon: h,
      });
    }
  }
  const i = buckets.indexOf(String(row?.s));
  if (row?.inside && i >= 0 && !(i === 0 && out.length > 0)) {
    out.push({
      index: i,
      days: Number(row.n),
      of: Number(row.m),
      last: String(row.last),
      from: String(row.s),
      horizon: h,
    });
  }
  return out;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (d: string) => MONTH[Number(d.slice(5, 7)) - 1] + " " + Number(d.slice(8, 10));
function span(from: string, last: string, asOfYear: string): string {
  if (from.slice(0, 4) !== last.slice(0, 4))
    return md(from) + ", " + from.slice(0, 4) + " \u2013 " + md(last) + ", " + last.slice(0, 4);
  const y = from.slice(0, 4) === asOfYear ? "" : ", " + from.slice(0, 4);
  if (from === last) return md(from) + y;
  if (from.slice(0, 7) === last.slice(0, 7))
    return md(from) + "\u2013" + Number(last.slice(8, 10)) + y;
  return md(from) + " \u2013 " + md(last) + y;
}
function clock(h: string): string {
  const t = new Date(Date.parse(h.slice(0, 19).replace(" ", "T") + "Z"));
  const hh = t.getUTCHours();
  return (
    (hh % 12 === 0 ? 12 : hh % 12) +
    ":" +
    String(t.getUTCMinutes()).padStart(2, "0") +
    " " +
    (hh < 12 ? "AM" : "PM")
  );
}
function statusOf(e: Expect, grain: Grain): string {
  const count = e.days + " of " + e.of + " days";
  if (e.edge === "start") return "Partial " + grain + " \u00B7 " + count;
  if (grain === "day") return "In progress \u00B7 through " + clock(e.horizon);
  return "In progress \u00B7 " + count;
}

function runtimeOf(html: string, id: string): Runtime | undefined {
  const m = html.match(
    new RegExp('data-hm-chart="' + id + '"><script type="application/json">(.*?)</script>'),
  );
  return m ? (JSON.parse(m[1] as string) as Runtime) : undefined;
}
function figure(html: string, id: string): string {
  return html.split('data-hm-chart="' + id + '"')[1]?.split("</figure>")[0] ?? "";
}

interface Want {
  horizon: Record<string, string>;
  clipStart?: string | undefined;
  asOfYear: string;
}
async function audit(
  html: string,
  id: string,
  c: Omit<Chart, "id" | "grains">,
  want: Want,
): Promise<string[]> {
  const bad: string[] = [];
  const rt = runtimeOf(html, id);
  if (!rt) return [id + ": no runtime data"];
  const { grain, buckets } = c.axis;
  const flagged = new Map<number, { k: number; e: Expect }[]>();
  for (const [k, s] of c.series.entries()) {
    const h = want.horizon[s.metric] as string;
    const exp = (await cutBy(grain, h, buckets, want.clipStart)).filter(
      (e) => e.index < buckets.length,
    );
    const got = (s.partial ?? []).map((p) => p.index + (p.edge ? "s" : "")).join(",");
    const wantFlags = exp.map((e) => e.index + (e.edge ? "s" : "")).join(",");
    if (got !== wantFlags)
      bad.push(
        id +
          " " +
          s.label +
          ": partial flags [" +
          got +
          "] vs SQL [" +
          wantFlags +
          "] (horizon " +
          h +
          ")",
      );
    const rtp = (rt.series[k]?.partial ?? []).join(",");
    if (rtp !== exp.map((e) => e.index).join(","))
      bad.push(id + " " + s.label + ": runtime partial [" + rtp + "] vs SQL");
    for (const e of exp) {
      const list = flagged.get(e.index) ?? [];
      list.push({ k, e });
      flagged.set(e.index, list);
    }
  }
  const fig = figure(html, id);
  const rows = (fig.split("<tbody>")[1] ?? "").split("</tr>").slice(0, buckets.length);
  const stacked = c.totals !== undefined && c.stack === true;
  for (const [i] of buckets.entries()) {
    const parts = flagged.get(i) ?? [];
    const least = parts.reduce<Expect | undefined>(
      (a, { e }) =>
        a === undefined || e.days < a.days || (grain === "day" && e.horizon < a.horizon) ? e : a,
      undefined,
    );
    const status = rt.status?.[i] ?? "";
    const expected = least ? statusOf(least, grain) : "";
    const bareDay = grain === "day" && least !== undefined && status === "In progress";
    if (status !== expected && !bareDay)
      bad.push(id + " " + buckets[i] + ': status "' + status + '" vs "' + expected + '"');
    if (least) {
      const complete = c.series.some(
        (s, k) =>
          s.values[i] !== null && s.values[i] !== undefined && !parts.some((p) => p.k === k),
      );
      const header = rt.headers[i] ?? "";
      const covered = span(least.from, least.last, want.asOfYear);
      if (!complete && header !== covered)
        bad.push(id + " " + buckets[i] + ': date line "' + header + '" vs "' + covered + '"');
      if (complete && header === covered && least.days < least.of)
        bad.push(
          id +
            " " +
            buckets[i] +
            ': date line "' +
            header +
            '" names the partial span, but a complete series shows its whole ' +
            grain +
            " beside it",
        );
      const note = least.edge === "start" ? "partial " + grain : "in progress";
      const th = rows[i]?.match(/<th scope="row">(.*?)<\/th>/)?.[1] ?? "";
      if (!th.includes(note))
        bad.push(id + " " + buckets[i] + ': table row "' + th + '" lacks "' + note + '"');
    }
    if (stacked) {
      const total = c.totals?.[i];
      const summedPartial = parts.some(({ k }) => typeof c.series[k]?.values[i] === "number");
      const wantTotal = typeof total === "number" && summedPartial ? expected : "";
      const gotTotal = rt.totalStatus?.[i] ?? "";
      if (gotTotal !== wantTotal && !(bareDay && wantTotal !== "" && gotTotal === "In progress"))
        bad.push(
          id + " " + buckets[i] + ': Total status "' + gotTotal + '" vs "' + wantTotal + '"',
        );
      const cell = [...(rows[i] ?? "").matchAll(/<td>(.*?)<\/td>/g)].at(-1)?.[1] ?? "";
      const hasNote = cell.includes(" \u00B7 ");
      if (hasNote !== (wantTotal !== ""))
        bad.push(id + " " + buckets[i] + ': table Total "' + cell + '"');
    }
  }
  for (const svg of fig.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
    const [L, R, n] = (svg.match(/data-hm-x="([^"]*)"/)?.[1] ?? "").split(",").map(Number) as [
      number,
      number,
      number,
    ];
    const x = (i: number) => (n > 1 ? L + (i * (R - L)) / (n - 1) : (L + R) / 2);
    const slot = (i: number): [number, number] => [
      i > 0 ? (x(i - 1) + x(i)) / 2 : L,
      i < n - 1 ? (x(i) + x(i + 1)) / 2 : R,
    ];
    if (c.type === "line" || c.type === "area") {
      for (const m of withoutReadout(svg).matchAll(
        /<rect x="([\d.-]+)" y="[\d.-]+" width="([\d.-]+)" height="[\d.-]+" fill="url\(#[^)]*-textSubtle\)"/g,
      )) {
        const a = Number(m[1]);
        const b = a + Number(m[2]);
        const inside = [...flagged.keys()].some((i) => {
          const [s0, s1] = slot(i);
          return a >= s0 - 0.6 && b <= s1 + 0.6;
        });
        if (!inside) {
          const over = buckets.filter((_, i) => x(i) > a + 0.6 && x(i) < b - 0.6);
          bad.push(
            id +
              " (" +
              Math.round(R) +
              " px): hatched region " +
              a.toFixed(1) +
              "\u2013" +
              b.toFixed(1) +
              " runs past its partial slot, over " +
              over.join(" "),
          );
        }
      }
      const rings = (svg.match(/<circle [^>]*r="3.5"[^>]*stroke-width="1.75"/g) ?? []).length;
      const wantRings = [...flagged.entries()].reduce(
        (a, [i, ps]) => a + ps.filter(({ k }) => typeof c.series[k]?.values[i] === "number").length,
        0,
      );
      if (rings !== wantRings) bad.push(id + ": " + rings + " hollow points vs " + wantRings);
    } else {
      const tints = (svg.match(/fill-opacity="0.1"\/>/g) ?? []).length;
      const drawn = (k: number, i: number) =>
        (c as Chart & { percent?: boolean }).percent
          ? (c.series[k] as Part & { share?: Value[] })?.share?.[i]
          : c.series[k]?.values[i];
      const wantTints = [...flagged.entries()].reduce(
        (a, [i, ps]) =>
          a + ps.filter(({ k }) => typeof drawn(k, i) === "number" && drawn(k, i) !== 0).length,
        0,
      );
      if (tints !== wantTints) bad.push(id + ": " + tints + " hatched bar parts vs " + wantTints);
    }
  }
  return bad;
}

async function auditBlock(html: string, b: Chart, want: Want): Promise<string[]> {
  if (!b.grains) return audit(html, b.id, b, want);
  const bad: string[] = [];
  for (const o of b.grains.options) {
    const id = b.id + "-" + o.key.replace(":", "-");
    bad.push(
      ...(await audit(html, id, { ...b, axis: o.axis, series: o.series, totals: o.totals }, want)),
    );
  }
  return bad;
}

const orders: Source = {
  name: "revenue",
  column: "at",
  rows: every("2026-01-01T05:00:00Z", "2026-06-28T17:12:00Z", 5, true),
};
const returns: Source = {
  name: "returns",
  column: "at",
  rows: every("2026-01-01T05:00:00Z", "2026-04-15T20:00:00Z", 7),
};
const refunds: Source = {
  name: "refunds",
  column: "at",
  rows: every("2026-01-01T05:00:00Z", "2026-04-22T13:30:00Z", 11),
};
const MAIN = [orders, returns, refunds];

const stackBlocks = (prefix: string) => [
  {
    type: "area",
    id: prefix + "a3",
    metrics: ["revenue", "returns", "refunds"],
    grain: "month",
    grains: ["week", "month", "quarter"],
    stack: true,
  },
  {
    type: "bar",
    id: prefix + "b3",
    metrics: ["revenue", "returns", "refunds"],
    grain: "week",
    stack: true,
  },
  {
    type: "bar",
    id: prefix + "pct",
    metrics: ["revenue", "returns"],
    grain: "month",
    stack: "percent",
  },
  {
    type: "bar",
    id: prefix + "split",
    metrics: ["revenue"],
    split: "region",
    grain: "month",
    grains: ["week", "month"],
    stack: true,
  },
  { type: "line", id: prefix + "l2", metrics: ["revenue", "returns"], grain: "month" },
  { type: "area", id: prefix + "a2", metrics: ["revenue", "returns"], grain: "month", stack: true },
  { type: "bar", id: prefix + "day", metrics: ["revenue", "returns"], grain: "day", stack: true },
  { type: "line", id: prefix + "lday", metrics: ["revenue", "returns"], grain: "day" },
];

async function scenario(
  name: string,
  sources: Source[],
  period: Record<string, unknown>,
  blocks: unknown[],
  extra: Partial<Want> = {},
) {
  const p = await project(sources, { d: { title: name, period, blocks } });
  const { data, diagnostics } = await run(p.root, p.project, "d");
  if (data === undefined)
    throw new Error(JSON.stringify(diagnostics.filter((x) => x.severity === "error")));
  const d = data as DashboardData;
  const html = renderFragment(d);
  const own = await horizons(p.root, sources);
  return { d, html, own, diagnostics, extra };
}

async function check(
  s: Awaited<ReturnType<typeof scenario>>,
  horizon: Record<string, string>,
  clipStart?: string,
) {
  const bad: string[] = [];
  for (const b of s.d.blocks as unknown as Chart[]) {
    if (b.axis?.kind !== "time") continue;
    bad.push(
      ...(await auditBlock(s.html, b, {
        horizon,
        clipStart,
        asOfYear: String(s.d.asOf).slice(0, 4),
      })),
    );
  }
  return bad;
}

function withoutReadout(svg: string): string {
  const start = svg.indexOf('<g class="hm-readout">');
  if (start < 0) return svg;
  let depth = 0;
  for (const m of svg.slice(start).matchAll(/<g[\s>]|<\/g>/g)) {
    depth += m[0] === "</g>" ? -1 : 1;
    if (depth === 0) return svg.slice(0, start) + svg.slice(start + (m.index ?? 0) + 4);
  }
  return svg.slice(0, start);
}

function ok(bad: string[]): void {
  expect(bad.length, "\n" + bad.map((b) => "• " + b).join("\n") + "\n").toBe(0);
}

const blocked = (s: Awaited<ReturnType<typeof scenario>>, ids: string[]) =>
  ids.filter((id) => !s.d.blocks.some((b) => b.id === id));

describe("partial flags, counts and the partial stacked Total against SQL horizons (HAT-81; day grain in latest_data only, HM_SWEEP=full for all)", () => {
  it("latest_data: Revenue through Jun 28 1:12 PM, Returns Apr 15 4:00 PM, Refunds Apr 22 9:30 AM", async () => {
    const s = await scenario(
      "latest",
      MAIN,
      { asOf: "latest_data", range: "year_to_date", compare: "none" },
      stackBlocks(""),
    );
    expect(blocked(s, ["a3", "b3", "pct", "split", "l2", "a2", "day", "lday"])).toEqual([]);
    ok(await check(s, s.own));
  });

  it("latest_common_data: every series ends at the oldest horizon", async () => {
    const s = await scenario(
      "common",
      MAIN,
      { asOf: "latest_common_data", range: "year_to_date", compare: "none" },
      FULL ? stackBlocks("") : stackBlocks("").slice(0, 6),
    );
    const oldest = Object.values(s.own).sort()[0] as string;
    ok(await check(s, Object.fromEntries(Object.keys(s.own).map((k) => [k, oldest]))));
  });

  it("fixed as-of Apr 20: Revenue cut at Apr 21 00:00, Returns at its own Apr 15 horizon", async () => {
    const s = await scenario(
      "fixed",
      MAIN,
      { asOf: "2026-04-20", range: "year_to_date", compare: "none" },
      FULL ? stackBlocks("") : stackBlocks("").slice(0, 6),
    );
    const cap = "2026-04-21 00:00:00.000000";
    ok(
      await check(
        s,
        Object.fromEntries(Object.entries(s.own).map(([k, h]) => [k, h < cap ? h : cap])),
      ),
    );
  });

  it("fixed as-of Apr 30: April complete for Revenue, no phantom May bucket", async () => {
    const s = await scenario(
      "eom",
      MAIN,
      { asOf: "2026-04-30", range: "year_to_date", compare: "none" },
      stackBlocks("").slice(0, 6),
    );
    const cap = "2026-05-01 00:00:00.000000";
    ok(
      await check(
        s,
        Object.fromEntries(Object.entries(s.own).map(([k, h]) => [k, h < cap ? h : cap])),
      ),
    );
  });

  it("edges clip: window from Wed May 13, a clipped first week and month", async () => {
    const range = { start: "2026-05-13", end: "2026-07-01" };
    const s = await scenario("clip", [orders], { asOf: "latest_data", range, compare: "none" }, [
      {
        type: "bar",
        id: "cw",
        metrics: ["revenue"],
        split: "region",
        grain: "week",
        stack: true,
        edges: "clip",
      },
      {
        type: "area",
        id: "cm",
        metrics: ["revenue"],
        grain: "month",
        grains: ["week", "month"],
        edges: "clip",
      },
      { type: "line", id: "cl", metrics: ["revenue"], grain: "week", edges: "clip" },
    ]);
    expect(blocked(s, ["cw", "cm", "cl"])).toEqual([]);
    ok(await check(s, s.own, range.start));
  });

  it("edges clip with a single bucket that is both clipped and in progress (Jun 10 to Jun 28)", async () => {
    const range = { start: "2026-06-10", end: "2026-07-01" };
    const s = await scenario("clip1", [orders], { asOf: "latest_data", range, compare: "none" }, [
      {
        type: "bar",
        id: "one",
        metrics: ["revenue"],
        split: "region",
        grain: "month",
        stack: true,
        edges: "clip",
      },
    ]);
    ok(await check(s, s.own, range.start));
  });

  it("hide and show: no partial marks, status or Total note anywhere", async () => {
    const s = await scenario(
      "modes",
      MAIN,
      { asOf: "latest_data", range: "year_to_date", compare: "none" },
      [
        {
          type: "area",
          id: "hide",
          metrics: ["revenue", "returns"],
          grain: "month",
          stack: true,
          incomplete: "hide",
        },
        {
          type: "bar",
          id: "hideb",
          metrics: ["revenue", "returns", "refunds"],
          grain: "week",
          stack: true,
          incomplete: "hide",
        },
        {
          type: "bar",
          id: "show",
          metrics: ["revenue", "returns"],
          grain: "month",
          stack: true,
          incomplete: "show",
        },
      ],
    );
    const bad: string[] = [];
    for (const id of ["hide", "hideb", "show"]) {
      const fig = figure(s.html, id);
      const rt = runtimeOf(s.html, id);
      if (/in progress|partial (week|month)/i.test(fig.replace(/<script[\s\S]*?<\/script>/, "")))
        bad.push(id + ": text names a partial bucket");
      if ((rt?.status ?? []).some(Boolean) || (rt?.totalStatus ?? []).some(Boolean))
        bad.push(id + ": status in runtime");
      if (/fill-opacity="0.1"\/>|-textSubtle\)/.test(fig)) bad.push(id + ": hatched marks");
    }
    ok(bad);
  });

  it("midnight timestamps and DATE columns: a row at Apr 15 00:00 counts Apr 15", async () => {
    const midnight: Source = {
      name: "midnight",
      column: "at",
      rows: daily("2026-01-01T05:00:00Z", "2026-03-07T05:00:00Z")
        .map(([d]): [string, number] => [d + "T05:00:00Z", 7])
        .concat(
          daily("2026-03-08T04:00:00Z", "2026-04-15T04:00:00Z").map(([d]) => [d + "T04:00:00Z", 7]),
        ),
    };
    const dated: Source = {
      name: "dated",
      column: "day",
      rows: daily("2026-01-01T00:00:00Z", "2026-04-15T00:00:00Z"),
    };
    const s = await scenario(
      "midnight",
      [midnight, dated],
      { asOf: "latest_data", range: "year_to_date", compare: "none" },
      [
        {
          type: "bar",
          id: "mm",
          metrics: ["midnight"],
          grain: "month",
          grains: ["week", "month", "quarter"],
        },
        {
          type: "bar",
          id: "dm",
          metrics: ["dated"],
          grain: "month",
          grains: ["week", "month", "quarter"],
        },
        { type: "bar", id: "md", metrics: ["midnight"], grain: "day" },
      ],
    );
    ok(await check(s, s.own));
  });

  for (const [label, sources] of [
    [
      "fall back: Revenue through 1:30 AM EST on Nov 1, Returns through Oct 31 11:00 PM",
      [
        {
          name: "revenue",
          column: "at",
          rows: every("2026-10-01T04:00:00Z", "2026-11-01T06:30:00Z", 3),
        },
        {
          name: "returns",
          column: "at",
          rows: every("2026-10-01T04:00:00Z", "2026-11-01T03:00:00Z", 5),
        },
      ],
    ],
    [
      "spring forward: Revenue through 3:30 AM EDT on Mar 8, Returns through Mar 7 11:00 PM",
      [
        {
          name: "revenue",
          column: "at",
          rows: every("2026-02-01T05:00:00Z", "2026-03-08T07:30:00Z", 3),
        },
        {
          name: "returns",
          column: "at",
          rows: every("2026-02-01T05:00:00Z", "2026-03-08T04:00:00Z", 5),
        },
      ],
    ],
  ] as [string, Source[]][]) {
    it("DST " + label, async () => {
      const start = sources[0]?.rows[0]?.[0].slice(0, 7) + "-01";
      const s = await scenario(
        "dst",
        sources,
        {
          asOf: "latest_data",
          range: {
            start,
            end: start.slice(0, 5) + String(Number(start.slice(5, 7)) + 2).padStart(2, "0") + "-01",
          },
          compare: "none",
        },
        [
          {
            type: "bar",
            id: "m",
            metrics: ["revenue", "returns"],
            grain: "month",
            grains: ["day", "week", "month"],
            stack: true,
          },
          { type: "area", id: "w", metrics: ["revenue", "returns"], grain: "week", stack: true },
        ],
      );
      ok(await check(s, s.own));
    });
  }
});
