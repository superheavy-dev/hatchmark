import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlannedQuery } from "../../src/compiler/index.js";
import { fromLocal } from "../../src/compiler/instants.js";
import { windowAt } from "../../src/compiler/windows.js";
import type { Weekday } from "../../src/spec/index.js";
import { Oracle } from "./fixture.js";
import type { Anchors } from "./periods.oracle.js";
import {
  boundAt,
  type Clamp,
  DAY,
  HOUR,
  type Interval,
  iso,
  localDate,
  type Shift,
  toDateWindow,
  transitions,
  US,
  wallOf,
  wallText,
  wallToInstant,
} from "./todate.oracle.js";

const FULL = process.env.HM_SWEEP === "full";

const listIn = (into: Record<string, string[]>, key: string) => {
  const list = into[key] ?? [];
  into[key] = list;
  return list;
};
const CASES = FULL ? 40_000 : 3_000;

const ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/St_Johns",
  "America/Havana",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Kyiv",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Kathmandu",
  "Australia/Sydney",
  "Australia/Adelaide",
  "Australia/Lord_Howe",
  "Pacific/Auckland",
  "Pacific/Chatham",
  "Pacific/Kiritimati",
  "Antarctica/Troll",
];

let seed = 0x5eed1234;
const rand = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const between = (a: bigint, b: bigint) =>
  a + BigInt(Math.floor(rand() * Number((b - a) / US))) * US;

const UNITS = ["day", "week", "month", "month", "quarter", "quarter", "year", "year"] as const;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SHIFTS: Shift[] = ["none", "previous_period", "previous_period", "previous_year"];
const FROM = BigInt(Date.UTC(2024, 0, 1)) * 1000n;
const TO = BigInt(Date.UTC(2031, 0, 1)) * 1000n;

function query(unit: string, shift: Shift): PlannedQuery {
  return {
    id: "q",
    source: "orders",
    input: { type: "csv", path: "orders.csv" },
    measures: [],
    dimensions: [],
    groupingSets: [[]],
    window: { range: { to_date: unit }, shift, column: "at", horizons: [] },
    params: [],
  } as unknown as PlannedQuery;
}

function actual(
  tz: string,
  T: bigint,
  H: bigint,
  unit: string,
  anchors: Anchors,
  shift: Shift,
): Interval {
  const asOf = localDate(T - 1n, tz);
  const w = windowAt(
    query(unit, shift),
    {
      asOf,
      anchors: { ...anchors, week: anchors.week as Weekday },
      bindings: {},
      timezone: tz,
      asOfInstant: iso(T),
      horizons: [],
    },
    H * 1000n,
  );
  if (w?.kind !== "bounded") throw new Error("expected a bounded window");
  const start = boundAt(w.start, tz);
  const end = boundAt(w.end, tz);
  return start < end ? { start, end } : null;
}

type Case = {
  tz: string;
  T: bigint;
  H: bigint;
  unit: string;
  anchors: Anchors;
  shift: Shift;
  why: string;
};

const cache = new Map<string, bigint[]>();
const zoneTransitions = (tz: string) => {
  let t = cache.get(tz);
  if (t === undefined) {
    t = transitions(tz, FROM, TO);
    cache.set(tz, t);
  }
  return t;
};

function makeCase(): Case {
  const tz = pick(ZONES);
  const unit = pick(UNITS);
  const anchors: Anchors = {
    week: pick(WEEKDAYS),
    quarter: pick(["01-01", "01-01", "02-01", "04-15"]),
    year: pick(["01-01", "01-01", "07-01", "02-01"]),
  };
  const shift = pick(SHIFTS);
  const ts = zoneTransitions(tz);
  const mode = rand();
  let H: bigint;
  let why: string;
  if (mode < 0.25 || ts.length === 0) {
    H = between(FROM + 400n * DAY, TO - 40n * DAY);
    why = "random";
  } else if (mode < 0.45) {
    H = pick(ts) + BigInt(Math.floor((rand() - 0.5) * 6 * 3600)) * US;
    why = "horizon near a DST change";
  } else if (mode < 0.8) {
    const tau = pick(ts);
    const tw = wallOf(tau - 1n, tz) + 1n + BigInt(Math.floor((rand() - 0.5) * 3 * 3600)) * US;
    const lag = shift === "previous_year" ? 12 : 1;
    const months = unit === "quarter" ? 3 : unit === "year" ? 12 : 1;
    const shiftDays = unit === "day" ? 1 : unit === "week" ? 7 : 0;
    let Hw: bigint;
    if (shiftDays > 0 && shift !== "previous_year") Hw = tw + BigInt(shiftDays) * DAY;
    else {
      const dt = new Date(Number(tw / 1000n));
      const add = shift === "previous_year" ? 12 : months * lag;
      dt.setUTCMonth(dt.getUTCMonth() + add);
      Hw = BigInt(dt.getTime()) * 1000n + (tw % 1000n);
    }
    H = wallToInstant(Hw, tz);
    why = "comparison end near a DST change";
  } else if (mode < 0.92) {
    const y = 2025 + Math.floor(rand() * 5);
    const m = Math.floor(rand() * 12);
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = last - Math.floor(rand() * 4);
    const w = BigInt(Date.UTC(y, m, day)) * 1000n + BigInt(Math.floor(rand() * 86400)) * US;
    H = wallToInstant(w, tz);
    why = "month end";
  } else {
    const w = pick([
      Date.UTC(2028, 1, 29),
      Date.UTC(2028, 2, 1),
      Date.UTC(2029, 1, 28),
      Date.UTC(2028, 4, 30),
      Date.UTC(2028, 4, 31),
    ]);
    H = wallToInstant(BigInt(w) * 1000n + BigInt(Math.floor(rand() * 86400)) * US, tz);
    why = "leap year";
  }
  H += 1n;
  const T = rand() < 0.75 ? H : H + BigInt(Math.floor(rand() * 40 * 86400)) * US;
  return { tz, T, H, unit, anchors, shift, why };
}

const show = (i: Interval, tz: string) =>
  i === null
    ? "empty"
    : wallText(wallOf(i.start, tz)) +
      " .. " +
      wallText(wallOf(i.end, tz)) +
      " (" +
      iso(i.end) +
      ")";
const same = (a: Interval, b: Interval) =>
  a === null || b === null ? a === b : a.start === b.start && a.end === b.end;

function sweep(clamp: Clamp) {
  seed = 0x5eed1234;
  const failures: Record<string, string[]> = {};
  let compared = 0;
  for (let n = 0; n < CASES; n++) {
    const c = makeCase();
    const want = toDateWindow(c.tz, c.T, c.H, c.unit, c.anchors, c.shift, clamp);
    let got: Interval;
    try {
      got = actual(c.tz, c.T, c.H, c.unit, c.anchors, c.shift);
    } catch (e) {
      got = null;
      listIn(failures, "throws").push(String(e));
      continue;
    }
    compared++;
    if (same(want, got)) continue;
    const kind = c.tz + " " + c.unit + " " + c.shift + " (" + c.why + ")";
    listIn(failures, kind).push(
      "H " +
        wallText(wallOf(c.H, c.tz)) +
        " T " +
        wallText(wallOf(c.T, c.tz)) +
        " anchors " +
        JSON.stringify(c.anchors) +
        "\n    want " +
        show(want, c.tz) +
        "\n    got  " +
        show(got, c.tz),
    );
  }
  return { compared, failures };
}

const report = (r: ReturnType<typeof sweep>) =>
  Object.entries(r.failures)
    .map(([k, v]) => k + ": " + v.length + "\n  " + v.slice(0, 2).join("\n  "))
    .join("\n");

describe("to-date windows agree with the independent oracle", {
  timeout: FULL ? 1_800_000 : 120_000,
}, () => {
  it("matches the decided rule: elapsed local time, never past section 6.2's comparison for the as-of date", () => {
    const r = sweep("calendar");
    console.log(
      "calendar clamp: " +
        r.compared +
        " cases, mismatches " +
        Object.values(r.failures).flat().length +
        "\n" +
        report(r),
    );
    expect(report(r)).toBe("");
  });
});

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(() => oracle.close());

describe("wall times resolve as DuckDB reads them", { timeout: FULL ? 1_800_000 : 120_000 }, () => {
  it("fromLocal and the oracle give DuckDB's instant around every DST change", async () => {
    const zones = FULL
      ? Intl.supportedValuesOf("timeZone")
      : [
          ...ZONES,
          "Asia/Beirut",
          "Africa/Cairo",
          "America/Santiago",
          "America/Asuncion",
          "Asia/Tehran",
        ];
    const from = FULL ? BigInt(Date.UTC(2000, 0, 1)) * 1000n : FROM;
    const walls: { tz: string; w: bigint; kind: string; tau: bigint }[] = [];
    for (const tz of zones) {
      for (const tau of transitions(tz, from, TO)) {
        const a = wallOf(tau - US, tz) + US;
        const b = wallOf(tau, tz);
        const kind = b < a ? "repeated" : "skipped";
        const lo = b < a ? b : a;
        const hi = b < a ? a : b;
        for (const w of [lo - US, lo, (lo + hi) / 2n, hi - US, hi, lo - HOUR, hi + HOUR])
          walls.push({ tz, w: w - (w % US), kind: w >= lo && w < hi ? kind : "plain", tau });
      }
    }
    const probes = walls
      .filter((_, i) => i % 7 === 0)
      .flatMap((x) =>
        [-2n * HOUR, -US, 0n, 2n * HOUR].map((d) => ({ tz: x.tz, tau: x.tau, at: x.tau + d })),
      );
    await oracle.run("CREATE OR REPLACE TABLE probes (tz VARCHAR, at_us BIGINT)");
    for (let i = 0; i < probes.length; i += 2000) {
      await oracle.run(
        "INSERT INTO probes VALUES " +
          probes
            .slice(i, i + 2000)
            .map((p) => "('" + p.tz + "', " + p.at + ")")
            .join(","),
      );
    }
    const local = await oracle.rows(
      "SELECT tz, at_us, epoch_us(CAST(timezone(tz, make_timestamptz(at_us)) AS TIMESTAMP)) AS wall FROM probes",
    );
    const disagree = new Set<string>();
    for (const r of local) {
      const p = probes.find((x) => x.tz === r.tz && x.at === BigInt(r.at_us as number));
      if (p && wallOf(p.at, p.tz) !== BigInt(r.wall as number)) disagree.add(p.tz + "|" + p.tau);
    }
    await oracle.run("CREATE OR REPLACE TABLE walls (tz VARCHAR, w VARCHAR)");
    for (let i = 0; i < walls.length; i += 2000) {
      const chunk = walls.slice(i, i + 2000);
      await oracle.run(
        "INSERT INTO walls VALUES " +
          chunk.map((x) => "('" + x.tz + "', '" + wallText(x.w).replace("T", " ") + "')").join(","),
      );
    }
    const rows = await oracle.rows(
      "SELECT tz, w, epoch_us(timezone(tz, CAST(w AS TIMESTAMP))) AS us FROM walls",
    );
    const duck = new Map(rows.map((r) => [r.tz + "|" + r.w, BigInt(r.us as number)]));
    const problems: Record<string, string[]> = {};
    let tzdata = 0;
    for (const x of walls) {
      const d = duck.get(x.tz + "|" + wallText(x.w).replace("T", " "));
      if (d === undefined) continue;
      if (disagree.has(x.tz + "|" + x.tau) || (x.kind === "plain" && wallOf(d, x.tz) !== x.w)) {
        tzdata++;
        continue;
      }
      const mine = wallToInstant(x.w, x.tz);
      const core = fromLocal(x.w * 1000n, x.tz) / 1000n;
      const line =
        x.tz +
        " " +
        wallText(x.w) +
        " duckdb " +
        iso(d) +
        " core " +
        iso(core) +
        " oracle " +
        iso(mine);
      if (mine !== d) listIn(problems, "oracle " + x.kind).push(line);
      if (core !== d) listIn(problems, "fromLocal " + x.tz + " " + x.kind).push(line);
    }
    const text = Object.entries(problems)
      .map(([k, v]) => k + ": " + v.length + "\n  " + v.slice(0, 3).join("\n  "))
      .join("\n");
    console.log(
      "wall problems " +
        Object.values(problems).flat().length +
        "; " +
        walls.length +
        " wall times, " +
        tzdata +
        " skipped for tzdata differences\n" +
        text,
    );
    expect(text).toBe("");
  });
});
