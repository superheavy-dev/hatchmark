import { afterAll, expect, it } from "vitest";
import { explainDefaults } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const PROJECTS = FULL ? 280 : 40;

afterAll(removeProjects);

type Unit = "day" | "week" | "month" | "quarter" | "year";
type Grain = Unit | { unit: Unit; anchor: string };
type Range = string | Record<string, unknown>;
type Config = {
  timezone: string;
  weekStart?: string;
  anchors?: { week?: string; quarter?: string; year?: string };
};
type Block = {
  type: string;
  id?: string;
  grain?: Grain;
  grains?: Grain[];
  edges?: string;
  incomplete?: string;
};
type Dash = {
  blocks: Block[];
  period?: { asOf: string; range: Range; compare: string };
  filters?: { type: string; options: unknown[]; default: unknown }[];
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAYS: string[] = [];
for (let t = Date.UTC(2019, 0, 1, 12); t <= Date.UTC(2031, 11, 31, 12); t += 86_400_000) {
  DAYS.push(new Date(t).toISOString());
}
const CSV = `at,v\n${DAYS.map((d) => `${d},1`).join("\n")}\n`;

const ZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "Asia/Seoul",
  "America/St_Johns",
];
const WD = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MD = ["01-01", "07-01", "04-01", "10-01", "02-01", "03-15", "12-28", "02-28", "11-05"];
const AS_OF = [
  "2024-02-29",
  "2024-03-01",
  "2024-02-28",
  "2028-02-29",
  "2023-12-31",
  "2024-12-31",
  "2025-01-01",
  "2026-01-01",
  "2026-12-31",
  "2026-11-30",
  "2026-11-27",
  "2026-03-08",
  "2026-03-29",
  "2026-11-01",
  "2026-10-25",
  "2026-04-05",
  "2026-10-04",
  "2026-01-31",
  "2026-04-30",
  "2026-06-30",
  "2026-07-01",
  "2026-09-30",
  "2026-03-31",
  "2025-06-15",
  "2027-02-28",
  "2021-01-03",
  "2022-01-01",
];
const FORCED: Partial<Config>[] = [
  { weekStart: "sunday" },
  { anchors: { week: "saturday", year: "07-01" } },
  { anchors: { year: "03-15", quarter: "06-15" } },
  {},
];
const NAMED: Record<string, Record<string, unknown>> = {
  last_7_days: { last: 7, unit: "day" },
  last_30_days: { last: 30, unit: "day" },
  last_90_days: { last: 90, unit: "day" },
  last_12_months: { last: 12, unit: "month" },
  month_to_date: { to_date: "month" },
  quarter_to_date: { to_date: "quarter" },
  year_to_date: { to_date: "year" },
  last_complete_month: { last_complete: "month" },
  last_complete_quarter: { last_complete: "quarter" },
  last_complete_year: { last_complete: "year" },
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);
const ymd = (s: string) => s.split("-").map(Number) as [number, number, number];
const date = (y: number, m: number, d: number) => iso(Date.UTC(y, m - 1, d));
const addDays = (s: string, n: number) => iso(ms(s) + n * 86_400_000);
const addMonths = (s: string, n: number) => {
  const [y, m, d] = ymd(s);
  const i = y * 12 + m - 1 + n;
  return date(Math.floor(i / 12), (i % 12) + 1, d);
};
const unitOf = (g: Grain): Unit => (typeof g === "string" ? g : g.unit);
const ownAnchor = (g: Grain) => (typeof g === "string" ? undefined : g.anchor);

function projectAnchors(config: Partial<Config>) {
  const year = config.anchors?.year ?? "01-01";
  return {
    week: config.anchors?.week ?? config.weekStart ?? "monday",
    year,
    quarter: config.anchors?.quarter ?? year,
  };
}
type Anchors = ReturnType<typeof projectAnchors>;

function resolve(g: Grain, anchors: Anchors): [Unit, string | undefined] {
  const u = unitOf(g);
  if (u === "day" || u === "month") return [u, undefined];
  return [u, ownAnchor(g) ?? anchors[u]];
}

function bucketOf(s: string, [u, a]: [Unit, string | undefined]): string {
  if (u === "day") return s;
  const [y, m] = ymd(s);
  if (u === "month") return date(y, m, 1);
  if (u === "week") {
    const weekday = (new Date(ms(s)).getUTCDay() + 6) % 7;
    return addDays(s, -((weekday - WD.indexOf(a as string) + 7) % 7));
  }
  const am = Number((a as string).slice(0, 2));
  const ad = Number((a as string).slice(3));
  const offsets = u === "quarter" ? [0, 3, 6, 9] : [0];
  const starts = [y - 1, y].flatMap((yy) =>
    offsets.map((k) => date(yy, ((am - 1 + k) % 12) + 1, ad)),
  );
  return starts
    .filter((c) => c <= s)
    .sort()
    .at(-1) as string;
}

function step(s: string, u: Unit, n: number): string {
  if (u === "day") return addDays(s, n);
  if (u === "week") return addDays(s, 7 * n);
  return addMonths(s, { month: 1, quarter: 3, year: 12 }[u] * n);
}

function rangeStart(range: Range, asOf: string, anchors: Anchors): string | undefined {
  if (range === "all_time") return undefined;
  const s = typeof range === "string" ? (NAMED[range] as Record<string, unknown>) : range;
  if ("start" in s) return s.start as string;
  if ("last_complete" in s) {
    const g = resolve(s.last_complete as Unit, anchors);
    const own = bucketOf(asOf, g);
    const next = addDays(asOf, 1);
    return bucketOf(next, g) === next ? own : bucketOf(addDays(own, -1), g);
  }
  if ("to_date" in s) return bucketOf(asOf, resolve(s.to_date as Unit, anchors));
  const u = s.unit as Unit;
  const n = s.last as number;
  if (u === "day") return addDays(asOf, -(n - 1));
  return step(bucketOf(asOf, resolve(u, anchors)), u, -(n - 1));
}

function rangeUnit(range: Range): Unit | undefined {
  if (range === "all_time") return undefined;
  const s = typeof range === "string" ? (NAMED[range] as Record<string, unknown>) : range;
  if ("start" in s) return undefined;
  return (s.last_complete ?? s.to_date ?? s.unit) as Unit;
}

function format(s: string, weekday: boolean, asOf: string): string {
  const [y, m, d] = ymd(s);
  const prefix = weekday ? `${SHORT_DAYS[new Date(ms(s)).getUTCDay()]} ` : "";
  return `${prefix}${MONTHS[m - 1]} ${d}${String(y) === asOf.slice(0, 4) ? "" : `, ${y}`}`;
}

function generate(p: number, r: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const anchors: Record<string, string> = {};
  let weekStart: string | undefined;
  const w = r();
  if (w < 0.3) anchors.week = pick(["monday", "sunday", "saturday", "wednesday"]);
  else if (w < 0.4) weekStart = pick(["monday", "sunday"]);
  if (r() < 0.5) anchors.year = pick(MD);
  if (r() < 0.15) {
    const base = anchors.year ?? "01-01";
    const m = ((Number(base.slice(0, 2)) - 1 + 3 * Math.floor(r() * 4)) % 12) + 1;
    anchors.quarter = String(m).padStart(2, "0") + base.slice(2);
    if (r() < 0.5) delete anchors.year;
  }
  const chosen: Partial<Config> = FORCED[p] ?? {
    ...(Object.keys(anchors).length > 0 ? { anchors } : {}),
    ...(weekStart === undefined ? {} : { weekStart }),
  };
  const config = {
    ...PROJECT_DEFAULTS,
    name: "Sweep",
    timezone: pick(ZONES),
    sources: { orders: { type: "csv", path: "orders.csv" } },
    ...chosen,
  };
  const grain = (): Grain => {
    const u = pick(["day", "week", "week", "month", "quarter", "year"] as const);
    if (u === "day" || u === "month" || r() < 0.5) return u;
    return { unit: u, anchor: u === "week" ? pick(WD) : pick(MD) };
  };
  const range = (): Range => {
    const k = r();
    if (k < 0.35) return pick([...Object.keys(NAMED), "all_time"]);
    const unit = pick(["day", "week", "month", "quarter", "year"]);
    if (k < 0.55) return { last: 1 + Math.floor(r() * 14), unit };
    if (k < 0.7) return { to_date: unit };
    if (k < 0.85) return { last_complete: unit };
    const a = iso(Math.floor(18300 + r() * 2500) * 86_400_000);
    const b = iso(Math.floor(18300 + r() * 2500) * 86_400_000);
    if (a === b) return { start: a, end: iso(Math.floor(20801 + r() * 99) * 86_400_000) };
    return a < b ? { start: a, end: b } : { start: b, end: a };
  };
  const dashboards: Record<string, Dash & { title: string }> = {};
  for (let d = 0; d < 6; d++) {
    const asOf = r() < 0.15 ? pick(["latest_data", "latest_common_data"]) : pick(AS_OF);
    const periodRange = range();
    const filters: NonNullable<Dash["filters"]> = [];
    if (r() < 0.3) {
      const other = r() < 0.2 ? "all_time" : range();
      filters.push({ type: "period", options: [periodRange, other], default: other });
    }
    const blocks: Block[] = [];
    const grainDefault = r() < 0.3 ? pick(["week", "month", "quarter"] as const) : undefined;
    const count = 3 + Math.floor(r() * 4);
    for (let b = 0; b < count; b++) {
      const g = grain();
      const block: Block & Record<string, unknown> = {
        type: pick(["line", "area", "bar"]),
        id: `b${b}`,
        metrics: ["orders"],
        grain: g,
      };
      if (grainDefault !== undefined && r() < 0.6) {
        const week: Grain =
          r() < 0.5 ? "week" : { unit: "week", anchor: projectAnchors(chosen).week };
        block.grains = [
          g,
          ...(["week", "month", "quarter"] as const)
            .filter((x) => x !== unitOf(g))
            .map((x) => (x === "week" ? week : x)),
        ];
      } else if (r() < 0.2) {
        block.grains = [g, ...(["month", "year"] as const).filter((x) => x !== unitOf(g))];
      }
      if (r() < 0.15) block.edges = pick(["snap", "clip"]);
      if (r() < 0.1) block.incomplete = pick(["mark", "hide", "show"]);
      blocks.push(block);
    }
    if (grainDefault !== undefined) {
      filters.push({ type: "grain", options: ["week", "month", "quarter"], default: grainDefault });
    }
    if (r() < 0.2) blocks.push({ type: "kpi", metric: "orders" } as Block);
    dashboards[`dashboards/d${d}.yaml`] = {
      title: `D${d}`,
      blocks,
      ...(r() < 0.9 ? { period: { asOf, range: periodRange, compare: "none" } } : {}),
      ...(filters.length > 0 ? { filters: filters.map((f) => ({ ...f, id: f.type })) } : {}),
    };
  }
  return { config, chosen, dashboards };
}

function notesIn(zone: string, compute: () => ReturnType<typeof explainDefaults>) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return compute();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

it(
  `HM4040 notes and first buckets match an independent window oracle on ${PROJECTS} random projects (HM_SWEEP=full for 280)`,
  async () => {
    const r = rng(1);
    const wrong: unknown[] = [];
    const counts = { projects: 0, dated: 0 };
    for (let p = 0; p < PROJECTS; p++) {
      const { config, chosen, dashboards } = generate(p, r);
      const fixture = await writeProject({
        "hatchmark.yaml": config,
        "orders.csv": CSV,
        "metrics/orders.yaml": metric({
          type: "aggregate",
          table: "orders",
          aggregate: "sum",
          column: "v",
          time: "at",
        }),
        ...dashboards,
      });
      const errors = [...fixture.diagnostics, ...checkReferences(fixture.project)].filter(
        (x) => x.severity === "error",
      );
      if (p < FORCED.length) expect(errors, `project ${p}`).toEqual([]);
      if (errors.length > 0) continue;
      counts.projects++;
      const notes = notesIn(p % 2 === 0 ? "America/Los_Angeles" : "Asia/Seoul", () =>
        explainDefaults(fixture.project),
      );
      const at = (file: string, pointer: string) =>
        notes.filter((n) => n.file === file && n.pointer === pointer).map((n) => n.message);
      const A = projectAnchors(chosen);
      const relied = { week: false, quarter: false, year: false };
      for (const [file, dash] of Object.entries(dashboards)) {
        const id = file.slice("dashboards/".length, -".yaml".length);
        const pf = dash.filters?.find((f) => f.type === "period");
        const gf = dash.filters?.find((f) => f.type === "grain");
        const asOf = dash.period?.asOf ?? "latest_data";
        const periodRange = dash.period?.range ?? "last_12_months";
        const range = (pf?.default ?? periodRange) as Range;
        const offered = (pf?.options ?? [periodRange]) as Range[];
        for (const each of [...offered, periodRange]) {
          const u = rangeUnit(each);
          if (u === "week" || u === "quarter" || u === "year") relied[u] = true;
        }
        const periodNote = at(file, "/title").some((m) => m.startsWith("uses the default period"));
        if (periodNote !== (dash.period === undefined)) wrong.push(["period note", p, file]);
        const { data } = await run(fixture.root, fixture.project, id);
        if (data === undefined) {
          wrong.push(["no build", p, file]);
          continue;
        }
        const built = data.blocks as unknown as {
          id: string;
          grain?: string;
          axis?: { kind: string; buckets: string[]; grain?: string };
        }[];
        const fixed = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
        dash.blocks.forEach((b, i) => {
          if (b.grain === undefined) return;
          const first = b.grain;
          const grains = [
            first,
            ...(b.grains ?? []).filter((g) => JSON.stringify(g) !== JSON.stringify(first)),
          ];
          for (const g of grains) {
            const u = unitOf(g);
            if ((u === "week" || u === "quarter" || u === "year") && ownAnchor(g) === undefined) {
              relied[u] = true;
            }
          }
          const key = (g: Grain) => JSON.stringify(resolve(g, A));
          const shown =
            gf !== undefined && (b.grains ?? []).some((g) => key(g) === key(gf.default as Grain))
              ? (gf.default as Grain)
              : first;
          const g = resolve(shown, A);
          const engine = built.find((x) => x.id === b.id);
          const engineGrain = engine?.grain ?? engine?.axis?.grain;
          if (engineGrain !== undefined && engineGrain !== g[0]) {
            wrong.push(["shown grain", p, file, i, shown, engineGrain]);
          }
          const messages = at(file, `/blocks/${i}/grain`);
          const edges = messages.filter((m) => m.startsWith("uses edges"));
          const incomplete = messages.filter((m) => m.startsWith("uses incomplete"));
          const wantEdges =
            b.edges === undefined &&
            grains.some((x) => unitOf(x) !== "day") &&
            offered.some((o) => o !== "all_time");
          if (wantEdges !== edges.length > 0) wrong.push(["edges note", p, file, i, edges]);
          if ((b.incomplete === undefined) !== incomplete.length > 0) {
            wrong.push(["incomplete note", p, file, i]);
          }
          if (incomplete[0] !== undefined && !incomplete[0].includes(`a ${g[0]} `)) {
            wrong.push(["incomplete unit", p, file, i, incomplete[0]]);
          }
          if (!fixed) return;
          const start = rangeStart(range, asOf, A);
          if (start === undefined) return;
          const bucket = bucketOf(start, g);
          const engineFirst = engine?.axis?.kind === "time" ? engine.axis.buckets[0] : undefined;
          if (
            engineFirst !== undefined &&
            engineFirst !== bucket &&
            !(b.edges === "clip" && b.incomplete === "hide")
          ) {
            wrong.push([
              "first bucket",
              p,
              file,
              i,
              config.timezone,
              A,
              range,
              asOf,
              shown,
              engineFirst,
              bucket,
            ]);
          }
          if (edges[0] === undefined || g[0] === "day") return;
          counts.dated++;
          const want =
            bucket === start
              ? `uses edges: snap: the first ${g[0]} starts at the start of the ${g[0]} that holds the range start`
              : `uses edges: snap: the first ${g[0]} starts on ${format(bucket, g[0] === "week", asOf)}, before the range starts on ${format(start, false, asOf)}`;
          if (edges[0] !== want)
            wrong.push(["edges dates", p, file, i, A, range, asOf, edges[0], want]);
        });
      }
      const configNotes = at("hatchmark.yaml", "/name");
      const set = chosen.anchors ?? {};
      const want = {
        week: relied.week && set.week === undefined && chosen.weekStart === undefined,
        quarter: relied.quarter && set.quarter === undefined && set.year === undefined,
        year: relied.year && set.year === undefined,
      };
      for (const unit of ["week", "quarter", "year"] as const) {
        const has = configNotes.some((m) => m.includes(`${unit} anchor`));
        if (want[unit] !== has) wrong.push([`${unit} anchor note`, p, chosen]);
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(counts.projects).toBeGreaterThanOrEqual(FORCED.length);
    expect(counts.dated).toBeGreaterThan(0);
  },
  FULL ? 3_600_000 : 300_000,
);
