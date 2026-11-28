import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { TableData } from "../../src/compiler/index.js";
import { renderFragment } from "../../src/render/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

const TZ = "America/New_York";
const TIMED = "at,market,channel,amount,units\n";
const SOURCES: Record<string, string> = {
  sales:
    TIMED +
    [
      "2026-10-27T15:00:00Z,A,web,1,1",
      "2026-10-28T15:00:00Z,A,web,2,1",
      "2026-11-01T03:59:00Z,A,web,4,1",
      "2026-11-01T04:00:00Z,B,store,8,1",
      "2026-11-01T05:30:00Z,A,store,16,1",
      "2026-11-01T06:30:00Z,B,web,32,1",
      "2026-11-02T04:59:00Z,A,web,64,1",
      "2026-11-02T05:00:00Z,B,web,128,1",
      "2026-11-03T18:00:00Z,A,store,256,1",
      "2026-11-04T23:03:00Z,A,web,512,1",
    ].join("\n"),
  refunds:
    TIMED +
    [
      "2026-10-26T15:00:00Z,A,web,1,0",
      "2026-10-27T15:00:00Z,B,web,2,0",
      "2026-11-01T05:30:00Z,A,web,4,0",
      "2026-11-02T15:00:00Z,B,store,8,0",
      "2026-11-03T04:59:59Z,A,web,16,0",
      "2026-11-03T05:00:00Z,A,web,32,0",
    ].join("\n"),
  tickets:
    TIMED +
    [
      "2026-10-26T15:00:00Z,A,web,1,0",
      "2026-11-01T05:30:00Z,B,web,2,0",
      "2026-11-02T15:00:00Z,A,store,4,0",
      "2026-11-03T04:59:59.999999Z,A,web,8,0",
    ].join("\n"),
  returns:
    TIMED +
    [
      "2026-10-24T15:00:00Z,A,web,1,0",
      "2026-10-25T15:00:00Z,B,web,2,0",
      "2026-10-31T15:00:00Z,A,store,4,0",
      "2026-11-02T04:30:00Z,A,web,8,0",
    ].join("\n"),
  orders:
    "at,shipped,market,channel,amount,units\n" +
    [
      "2026-10-30T15:00:00Z,2026-10-31T15:00:00Z,A,web,1,1",
      "2026-11-01T15:00:00Z,2026-11-01T20:00:00Z,B,web,2,1",
      "2026-11-02T15:00:00Z,2026-11-02T20:00:00Z,A,store,4,1",
      "2026-11-03T15:00:00Z,,A,store,8,1",
      "2026-11-04T15:00:00Z,,B,web,16,1",
    ].join("\n"),
  daily:
    "d,market,channel,amount,units\n" +
    ["2026-10-28,A,web,1,0", "2026-11-01,B,web,2,0", "2026-11-03,A,store,4,0"].join("\n"),
};

type Time = { source: string; column: string; date?: true };
const SUM: Record<
  string,
  { label: string; table: string; field: string; time?: Time; filter?: [string, string] }
> = {
  revenue: {
    label: "Revenue",
    table: "sales",
    field: "amount",
    time: { source: "sales", column: "at" },
  },
  units: { label: "Units", table: "sales", field: "units" },
  refunds: {
    label: "Refunds",
    table: "refunds",
    field: "amount",
    time: { source: "refunds", column: "at" },
  },
  tickets: {
    label: "Tickets",
    table: "tickets",
    field: "amount",
    time: { source: "tickets", column: "at" },
  },
  returns: {
    label: "Returns",
    table: "returns",
    field: "amount",
    time: { source: "returns", column: "at" },
  },
  placed: {
    label: "Placed",
    table: "orders",
    field: "amount",
    time: { source: "orders", column: "at" },
  },
  shipped: {
    label: "Shipped",
    table: "orders",
    field: "amount",
    time: { source: "orders", column: "shipped" },
  },
  daily: {
    label: "Daily",
    table: "daily",
    field: "amount",
    time: { source: "daily", column: "d", date: true },
  },
  web: {
    label: "Web revenue",
    table: "sales",
    field: "amount",
    time: { source: "sales", column: "at" },
    filter: ["channel", "web"],
  },
  constructor: {
    label: "Constructor",
    table: "sales",
    field: "amount",
    time: { source: "sales", column: "at" },
  },
};
const RATIO: Record<string, { label: string; numerator: string; denominator: string }> = {
  rate: { label: "Refund rate", numerator: "refunds", denominator: "revenue" },
  inverse: { label: "Inverse", numerator: "revenue", denominator: "refunds" },
  per_ticket: { label: "Per ticket", numerator: "revenue", denominator: "tickets" },
  ship_rate: { label: "Ship rate", numerator: "shipped", denominator: "placed" },
};

const ratioOf = (m: string) => (Object.hasOwn(RATIO, m) ? RATIO[m] : undefined);
const sumOf = (m: string) => (Object.hasOwn(SUM, m) ? SUM[m] : undefined);

function metricFiles(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const [name, m] of Object.entries(SUM)) {
    files[`metrics/${name}.yaml`] = metric({
      type: "aggregate",
      label: m.label,
      table: m.table,
      aggregate: "sum",
      column: m.field,
      ...(m.time ? { time: m.time.column } : {}),
      ...(m.filter ? { filters: [{ column: m.filter[0], op: "eq", value: m.filter[1] }] } : {}),
    });
  }
  for (const [name, r] of Object.entries(RATIO)) {
    files[`metrics/${name}.yaml`] = metric({ type: "ratio", ...r });
  }
  return files;
}

type Range = "month_to_date" | "last_7_days" | "all_time" | { start: string; end: string };
interface Case {
  metrics: string[];
  range: Range;
  asOf: "latest_data" | "latest_common_data" | string;
  by?: string[];
  limit?: number;
  other?: boolean;
  subtotals?: boolean;
  lagDays?: Record<string, number>;
}

async function build(c: Case) {
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Windows",
      timezone: TZ,
      sources: Object.fromEntries(
        Object.keys(SOURCES).map((s) => [
          s,
          {
            type: "csv",
            path: `${s}.csv`,
            ...(c.lagDays?.[s] ? { freshness: { lag: { days: c.lagDays[s] } } } : {}),
          },
        ]),
      ),
    },
    ...Object.fromEntries(Object.entries(SOURCES).map(([s, csv]) => [`${s}.csv`, `${csv}\n`])),
    ...metricFiles(),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: c.asOf, range: c.range, compare: "none" },
      blocks: [
        {
          id: "t",
          type: "table",
          by: c.by ?? ["market"],
          metrics: c.metrics,
          ...(c.limit !== undefined ? { limit: c.limit } : {}),
          ...(c.other ? { other: true } : {}),
          ...(c.subtotals ? { subtotals: true } : {}),
        },
      ],
    },
  });
  expect(fixture.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const result = await run(fixture.root, fixture.project, "d");
  if (result.data === undefined) throw new Error(JSON.stringify(result.diagnostics));
  const block = result.data.blocks[0] as TableData;
  const html = renderFragment(result.data);
  const subtitle = html.match(/<\/h2><p id="hm-t-s">([^<]+)/)?.[1];
  const described = html.includes('aria-describedby="hm-t-s"');
  const notes = Object.fromEntries(
    [...html.matchAll(/role="tooltip" id="hm-t-w(\d+)">([^<]+)</g)].map(([, i, text]) => [
      c.metrics[Number(i)],
      text,
    ]),
  );
  const sortDescribed = [...html.matchAll(/class="hm-sort" aria-describedby="hm-t-w(\d+)"/g)].map(
    ([, i]) => c.metrics[Number(i)],
  );
  return { root: fixture.root, block, subtitle, described, notes, sortDescribed };
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const words = (start: string, end: string) => {
  const last = addDays(end, -1);
  return start === last
    ? `${day(start)}, ${start.slice(0, 4)}`
    : `${day(start)} – ${day(last)}, ${last.slice(0, 4)}`;
};
type Horizon = { end: string; midday: boolean; micros: number; lastDate: string; wall: string };
type Effective =
  | { untimed: true }
  | { empty: "no_data" | "no_complete_day" }
  | { start?: string; end: string; endAt?: string; micros?: number };

async function oracleFor(root: string, c: Case) {
  const oracle = await Oracle.open();
  const read = (s: string) => `read_csv('${path.join(root, `${s}.csv`)}')`;
  const local = (t: Time) =>
    t.date ? `"${t.column}"` : `CAST(timezone('${TZ}', "${t.column}"::TIMESTAMPTZ) AS DATE)`;
  const instant = (t: Time) =>
    t.date ? `timezone('${TZ}', CAST("${t.column}" AS TIMESTAMP))` : `"${t.column}"::TIMESTAMPTZ`;
  const horizons = new Map<string, Horizon>();
  const horizonOf = async (t: Time): Promise<Horizon> => {
    const key = `${t.source}.${t.column}`;
    const known = horizons.get(key);
    if (known) return known;
    const through = t.date
      ? `timezone('${TZ}', CAST(max("${t.column}") + 1 AS TIMESTAMP))`
      : `max("${t.column}"::TIMESTAMPTZ) + INTERVAL 1 MICROSECOND`;
    const lag = c.lagDays?.[t.source] ?? 0;
    const [row] = await oracle.rows(`
      WITH h AS (SELECT ${through} - INTERVAL ${lag} DAY AS through FROM ${read(t.source)})
      SELECT CAST(CAST(timezone('${TZ}', through) AS DATE) AS VARCHAR) AS end_day,
        CAST(CAST(timezone('${TZ}', through - INTERVAL 1 MICROSECOND) AS DATE) AS VARCHAR) AS last_date,
        strftime(timezone('${TZ}', through), '%H:%M:%S.%f') <> '00:00:00.000000' AS midday,
        strftime(timezone('${TZ}', through), '%Y-%m-%dT%H:%M:%S.%f') AS wall,
        epoch_us(through) AS micros FROM h`);
    const h = {
      end: String(row?.end_day),
      lastDate: String(row?.last_date),
      midday: Boolean(row?.midday),
      micros: Number(row?.micros),
      wall: String(row?.wall),
    };
    horizons.set(key, h);
    return h;
  };
  const timesOf = (m: string): Time[] => {
    const r = ratioOf(m);
    if (r) return [...timesOf(r.numerator), ...timesOf(r.denominator)];
    const t = sumOf(m)?.time;
    return t ? [t] : [];
  };
  const own = new Map<string, Horizon | undefined>();
  for (const m of c.metrics) {
    const hs = await Promise.all(timesOf(m).map(horizonOf));
    own.set(m, hs.length ? hs.reduce((a, b) => (b.micros < a.micros ? b : a)) : undefined);
  }
  const voters = [...own.values()].filter((h): h is Horizon => h !== undefined);
  const fixed = c.asOf !== "latest_data" && c.asOf !== "latest_common_data";
  let capMicros = Number.POSITIVE_INFINITY;
  let capEnd = "9999-12-31";
  let asOf: string;
  if (fixed) {
    capEnd = addDays(c.asOf, 1);
    asOf = c.asOf;
  } else {
    const pick = voters.reduce((a, b) =>
      (c.asOf === "latest_data" ? b.micros > a.micros : b.micros < a.micros) ? b : a,
    );
    capMicros = pick.micros;
    asOf = pick.lastDate;
  }
  const base = (): { start: string; end: string } | "all" => {
    if (c.range === "all_time") return "all";
    if (c.range === "month_to_date")
      return { start: `${asOf.slice(0, 8)}01`, end: addDays(asOf, 1) };
    if (c.range === "last_7_days") return { start: addDays(asOf, -6), end: addDays(asOf, 1) };
    return c.range;
  };
  const effective = (m: string): Effective => {
    let h = own.get(m);
    if (h === undefined) return { untimed: true };
    if (capMicros < h.micros) h = voters.find((v) => v.micros === capMicros) as Horizon;
    const capped = capEnd < h.end;
    const end = capped ? capEnd : h.end;
    const midday = capped ? false : h.midday;
    const b = base();
    if (b === "all") return { end };
    if (end >= b.end) return b;
    if (c.range === "month_to_date") {
      if (midday ? end < b.start : end <= b.start) return { empty: "no_data" };
      return midday
        ? { start: b.start, end: addDays(end, 1), endAt: h.wall, micros: h.micros }
        : { start: b.start, end };
    }
    if (end <= b.start) return { empty: midday && end === b.start ? "no_complete_day" : "no_data" };
    if (c.range === "last_7_days") return { start: addDays(end, -7), end };
    return { start: b.start, end };
  };
  const windows = Object.fromEntries(c.metrics.map((m) => [m, effective(m)])) as Record<
    string,
    Effective
  >;

  type Dated = { start?: string; end: string; endAt?: string; micros?: number };
  const isDated = (w: Effective): w is Dated => "end" in w;
  const keyOf = (w: Dated) => `${w.start ?? ""}|${w.end}|${w.endAt ?? ""}`;
  const counts = new Map<string, { w: Dated; n: number }>();
  for (const m of c.metrics) {
    const w = windows[m] as Effective;
    if (!isDated(w)) continue;
    counts.set(keyOf(w), { w, n: (counts.get(keyOf(w))?.n ?? 0) + 1 });
  }
  let main: Dated | undefined;
  let most = 0;
  for (const { w, n } of counts.values())
    if (n > most) {
      main = w;
      most = n;
    }
  const clock = (at: string) => {
    const h = Number(at.slice(11, 13));
    return `${h % 12 === 0 ? 12 : h % 12}:${at.slice(14, 16)} ${h < 12 ? "AM" : "PM"}`;
  };
  const through = (w: Dated) =>
    w.endAt === undefined
      ? words(addDays(w.end, -1), w.end)
      : `${words(w.endAt.slice(0, 10), addDays(w.endAt.slice(0, 10), 1))}, ${clock(w.endAt)}`;
  const allEmpty = c.metrics.every((m) => "empty" in (windows[m] as Effective));
  const subtitle = allEmpty
    ? undefined
    : main === undefined
      ? "all time"
      : main.start
        ? `${words(main.start, main.end)}${main.endAt === undefined ? "" : `, through ${clock(main.endAt)}`}`
        : `through ${through(main)}`;
  const behind = (w: Dated) => {
    const days = main ? (Date.parse(main.end) - Date.parse(w.end)) / 86_400_000 : 0;
    return days > 0 ? ` · ${days} ${days === 1 ? "day" : "days"} behind` : "";
  };
  const noteMap = new Map<string, string>();
  for (const m of c.metrics) {
    const w = windows[m] as Effective;
    if ("untimed" in w) {
      if (main) noteMap.set(m, "All time");
    } else if ("empty" in w) {
      noteMap.set(m, w.empty === "no_data" ? "No data in this period" : "No complete day yet");
    } else if (main && keyOf(w) !== keyOf(main)) {
      const read =
        w.start && w.start !== main.start ? words(w.start, w.end) : `Data through ${through(w)}`;
      noteMap.set(m, `${read}${behind(w)}`);
    }
  }
  const notes = Object.fromEntries(noteMap);
  const mainWindow = main;

  const sum = async (m: string, w: Effective, group: string) => {
    const s = sumOf(m);
    if (!s) throw new Error(m);
    if ("empty" in w) return {} as Record<string, number | null>;
    const conds = [
      ...(s.time && "end" in w && w.micros === undefined
        ? [`${local(s.time)} < DATE '${w.end}'`]
        : []),
      ...(s.time && "micros" in w && w.micros !== undefined
        ? [`epoch_us(${instant(s.time)}) < ${w.micros}`]
        : []),
      ...(s.time && "end" in w && w.start ? [`${local(s.time)} >= DATE '${w.start}'`] : []),
      ...(s.filter ? [`${s.filter[0]} = '${s.filter[1]}'`] : []),
    ];
    const rows = await oracle.rows(`
      SELECT ${group} AS k, sum(${s.field})::DOUBLE AS v FROM ${read(s.table)}
      ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} GROUP BY ALL`);
    return Object.fromEntries(rows.map((r) => [String(r.k), r.v as number])) as Record<
      string,
      number | null
    >;
  };
  const value = async (m: string, group = "market"): Promise<Record<string, number | null>> => {
    const w = windows[m] as Effective;
    const r = ratioOf(m);
    if (!r) return sum(m, w, group);
    const n = await sum(r.numerator, w, group);
    const d = await sum(r.denominator, w, group);
    return Object.fromEntries(
      [...new Set([...Object.keys(n), ...Object.keys(d)])].map((k) => {
        const b = d[k] ?? 0;
        return [k, b === 0 ? null : (n[k] ?? 0) / b];
      }),
    );
  };
  return { windows, subtitle, notes, main: mainWindow, value, close: () => oracle.close() };
}

async function attack(c: Case) {
  const engine = await build(c);
  const want = await oracleFor(engine.root, c);
  try {
    expect(engine.block.rows.length).toBeGreaterThan(0);
    for (const m of c.metrics) {
      const sql = await want.value(m);
      const empty = "empty" in (want.windows[m] as Effective);
      for (const r of engine.block.rows.filter((x) => x.kind === undefined)) {
        const k = String(r.keys[0]);
        const exp = empty ? null : (sql[k] ?? (sumOf(m) ? 0 : null));
        const got = r.values[m] ?? null;
        if (got === null || exp === null) expect({ m, k, got }).toEqual({ m, k, got: exp });
        else expect({ m, k, got }).toEqual({ m, k, got: expect.closeTo(exp, 9) });
      }
    }
    expect(engine.described).toBe(engine.subtitle !== undefined);
    expect(engine.subtitle).toBe(want.subtitle);
    expect(engine.notes).toEqual(want.notes);
    expect(engine.sortDescribed).toEqual(c.metrics.filter((m) => Object.hasOwn(want.notes, m)));
    if (want.main?.start)
      expect(engine.block.window).toEqual({
        start: want.main.start,
        end: want.main.end,
        ...(want.main.endAt ? { endAt: want.main.endAt } : {}),
      });
    else if (want.main) expect(engine.block.through).toBe(addDays(want.main.end, -1));
    else expect([engine.block.window, engine.block.through]).toEqual([undefined, undefined]);
    return { ...engine, want };
  } finally {
    want.close();
  }
}

it("last 7 days: sources ending mid-day, at local midnight, and on the DST day", async () => {
  const { want } = await attack({
    metrics: ["revenue", "refunds", "returns", "units"],
    range: "last_7_days",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Oct 28 – Nov 3, 2026",
    {
      refunds: "Oct 27 – Nov 2, 2026 · 1 day behind",
      returns: "Oct 25 – Oct 31, 2026 · 3 days behind",
      units: "All time",
    },
  ]);
});

it("month to date: untimed first, a source inside its first day, a source whose newest row is at midnight", async () => {
  const { want, block } = await attack({
    metrics: ["units", "returns", "revenue", "refunds"],
    range: "month_to_date",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Nov 1, 2026, through 11:30 PM",
    {
      units: "All time",
      revenue: "Data through Nov 4, 2026, 6:03 PM",
      refunds: "Data through Nov 3, 2026, 12:00 AM",
    },
  ]);
  expect(block.window).toEqual({
    start: "2026-11-01",
    end: "2026-11-02",
    endAt: "2026-11-01T23:30:00.000001",
  });
  expect(block.windows).toEqual({
    revenue: { start: "2026-11-01", end: "2026-11-05", endAt: "2026-11-04T18:03:00.000001" },
    refunds: { start: "2026-11-01", end: "2026-11-04", endAt: "2026-11-03T00:00:00.000001" },
  });
  const a = block.rows.find((r) => r.keys[0] === "A")?.values;
  expect([a?.returns, a?.revenue, a?.refunds]).toEqual([8, 16 + 64 + 256 + 512, 4 + 16 + 32]);
});

it("all time with a fixed as-of before the newest data groups the metrics it caps", async () => {
  const { want } = await attack({
    metrics: ["units", "revenue", "refunds", "returns"],
    range: "all_time",
    asOf: "2026-11-02",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "through Nov 2, 2026",
    { units: "All time", returns: "Data through Oct 31, 2026 · 2 days behind" },
  ]);
});

it("all time under latest_data", async () => {
  const { want } = await attack({
    metrics: ["revenue", "refunds", "units"],
    range: "all_time",
    asOf: "latest_data",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "through Nov 3, 2026",
    { refunds: "Data through Nov 2, 2026 · 1 day behind", units: "All time" },
  ]);
});

it("latest_data names the stale metric; latest_common_data keeps one window", async () => {
  const latest = await attack({
    metrics: ["revenue", "refunds"],
    range: "month_to_date",
    asOf: "latest_data",
  });
  expect([latest.want.subtitle, latest.want.notes]).toEqual([
    "Nov 1 – Nov 4, 2026, through 6:03 PM",
    { refunds: "Data through Nov 3, 2026, 12:00 AM · 1 day behind" },
  ]);
  const common = await attack({
    metrics: ["revenue", "refunds"],
    range: "month_to_date",
    asOf: "latest_common_data",
  });
  expect([common.want.subtitle, common.want.notes]).toEqual([
    "Nov 1 – Nov 3, 2026, through 12:00 AM",
    {},
  ]);
  expect(common.block.window?.endAt).toBe("2026-11-03T00:00:00.000001");
});

it("ratios across two sources read through the most stale operand, in either position", async () => {
  const { want } = await attack({
    metrics: ["revenue", "rate", "inverse", "per_ticket"],
    range: "month_to_date",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Nov 1 – Nov 3, 2026, through 12:00 AM",
    {
      revenue: "Data through Nov 4, 2026, 6:03 PM",
      per_ticket: "Data through Nov 2, 2026 · 1 day behind",
    },
  ]);
});

it("a ratio first, then its fresher operand", async () => {
  const { want } = await attack({
    metrics: ["per_ticket", "revenue"],
    range: "last_7_days",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Oct 27 – Nov 2, 2026",
    { revenue: "Oct 28 – Nov 3, 2026" },
  ]);
});

it("two time columns of one source, and a ratio between them", async () => {
  const { want } = await attack({
    metrics: ["placed", "shipped", "ship_rate"],
    range: "month_to_date",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Nov 1 – Nov 2, 2026, through 3:00 PM",
    { placed: "Data through Nov 4, 2026, 10:00 AM" },
  ]);
});

it("a date column reads whole days next to a timestamp source's partial day, and shares its window when cut at the same midnight", async () => {
  const { want } = await attack({
    metrics: ["revenue", "daily"],
    range: "month_to_date",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Nov 1 – Nov 4, 2026, through 6:03 PM",
    { daily: "Data through Nov 3, 2026 · 1 day behind" },
  ]);
  const common = await attack({
    metrics: ["revenue", "daily"],
    range: "month_to_date",
    asOf: "latest_common_data",
  });
  expect([common.want.subtitle, common.want.notes]).toEqual(["Nov 1 – Nov 3, 2026", {}]);
  expect(common.block.window).toEqual({ start: "2026-11-01", end: "2026-11-04" });
});

it("a metric filter that drops the newest row keeps the source's horizon", async () => {
  const { want } = await attack({
    metrics: ["web", "revenue", "refunds"],
    range: "month_to_date",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Nov 1 – Nov 4, 2026, through 6:03 PM",
    { refunds: "Data through Nov 3, 2026, 12:00 AM · 1 day behind" },
  ]);
});

it("a freshness lag moves only that source's window", async () => {
  const { want } = await attack({
    metrics: ["refunds", "revenue"],
    range: "month_to_date",
    asOf: "2026-11-05",
    lagDays: { sales: 2 },
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Nov 1 – Nov 3, 2026, through 12:00 AM",
    { revenue: "Data through Nov 2, 2026, 6:03 PM · 1 day behind" },
  ]);
});

it("an explicit range ending before every horizon keeps one window", async () => {
  const { want } = await attack({
    metrics: ["revenue", "refunds", "returns"],
    range: { start: "2026-10-25", end: "2026-10-31" },
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual(["Oct 25 – Oct 30, 2026", {}]);
});

it("a metric named constructor in a mixed table", async () => {
  const { want } = await attack({
    metrics: ["units", "constructor", "refunds", "returns"],
    range: "last_7_days",
    asOf: "2026-11-05",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "Oct 28 – Nov 3, 2026",
    {
      units: "All time",
      refunds: "Oct 27 – Nov 2, 2026 · 1 day behind",
      returns: "Oct 25 – Oct 31, 2026 · 3 days behind",
    },
  ]);
});

it("all time picks the through most metrics read, not the first", async () => {
  const { want } = await attack({
    metrics: ["refunds", "revenue", "web"],
    range: "all_time",
    asOf: "latest_data",
  });
  expect([want.subtitle, want.notes]).toEqual([
    "through Nov 3, 2026",
    { refunds: "Data through Nov 2, 2026 · 1 day behind" },
  ]);
});

it("an empty metric next to untimed ones only", async () => {
  const { want } = await attack({
    metrics: ["units", "returns"],
    range: "month_to_date",
    asOf: "2026-11-05",
    lagDays: { returns: 2 },
  });
  expect([want.subtitle, want.notes]).toEqual(["all time", { returns: "No data in this period" }]);
});

it("subtotals, Other and the total read each metric's own window", async () => {
  const c: Case = {
    metrics: ["revenue", "refunds", "units"],
    range: "last_7_days",
    asOf: "2026-11-05",
    by: ["market", "channel"],
    subtotals: true,
    limit: 1,
    other: true,
  };
  const engine = await build(c);
  const want = await oracleFor(engine.root, c);
  try {
    expect([want.subtitle, want.notes]).toEqual([
      "Oct 28 – Nov 3, 2026",
      { refunds: "Oct 27 – Nov 2, 2026 · 1 day behind", units: "All time" },
    ]);
    expect(engine.subtitle).toBe(want.subtitle);
    expect(engine.notes).toEqual(want.notes);
    expect(engine.block.rows.some((r) => r.kind === "other")).toBe(true);
    for (const m of c.metrics) {
      const markets = await want.value(m);
      const cells = await want.value(m, "market || '/' || channel");
      for (const r of engine.block.rows) {
        const k = String(r.keys[0]);
        if (r.kind === "subtotal")
          expect({ m, k, v: r.values[m] }).toEqual({ m, k, v: markets[k] ?? 0 });
        if (r.kind === undefined)
          expect({ m, k, v: r.values[m] }).toEqual({ m, k, v: cells[`${k}/${r.keys[1]}`] ?? 0 });
        if (r.kind === "other") {
          const shown = engine.block.rows
            .filter((x) => x.kind === undefined && x.keys[0] === r.keys[0])
            .reduce((a, x) => a + (x.values[m] ?? 0), 0);
          expect({ m, k, v: r.values[m] }).toEqual({ m, k, v: (markets[k] ?? 0) - shown });
        }
      }
      const total = Object.values(markets).reduce((a: number, b) => a + (b ?? 0), 0);
      expect({ m, total: engine.block.total?.values[m] }).toEqual({ m, total });
    }
  } finally {
    want.close();
  }
});

it("every window empty: the empty state, no span and no description", async () => {
  const toDate = await build({
    metrics: ["returns"],
    range: "month_to_date",
    asOf: "2026-11-05",
    lagDays: { returns: 2 },
  });
  expect(toDate.block.empty).toBe("no_data");
  expect(toDate.subtitle).toBeUndefined();
  expect(toDate.described).toBe(false);
  const explicit = await build({
    metrics: ["returns"],
    range: { start: "2026-11-01", end: "2026-11-08" },
    asOf: "2026-11-05",
  });
  expect(explicit.block.empty).toBe("no_complete_day");
  expect(explicit.subtitle).toBeUndefined();
  expect(explicit.described).toBe(false);
});
