import {
  type Anchors,
  addDays,
  addUnits,
  bucket,
  resolveGrain,
  windows,
} from "./periods.oracle.js";

export const US = 1_000_000n;
export const HOUR = 3_600n * US;
export const DAY = 24n * HOUR;

const formats = new Map<string, Intl.DateTimeFormat>();
function format(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, f);
  }
  return f;
}

const floor = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));

export function wallOf(us: bigint, tz: string): bigint {
  const s = floor(us, US);
  const p: Record<string, string> = {};
  for (const part of format(tz).formatToParts(new Date(Number(s) * 1000)))
    p[part.type] = part.value;
  const wallMs = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return BigInt(wallMs) * 1000n + (us - s * US);
}

export const offsetAt = (us: bigint, tz: string) => wallOf(us, tz) - us;

export const wallDate = (d: string) => BigInt(Date.parse(d + "T00:00:00Z")) * 1000n;
export const dateOfWall = (w: bigint) =>
  new Date(Number(floor(w, 1000n))).toISOString().slice(0, 10);
export const localDate = (us: bigint, tz: string) => dateOfWall(wallOf(us, tz));

function firstWhere(lo: bigint, hi: bigint, pred: (us: bigint) => boolean): bigint {
  let a = floor(lo, US);
  let b = floor(hi, US) + 1n;
  while (a < b) {
    const m = floor(a + b, 2n);
    if (pred(m * US)) b = m;
    else a = m + 1n;
  }
  return a * US;
}

export function dayStart(d: string, tz: string): bigint {
  return wallToInstant(wallDate(d), tz);
}

export function wallToInstant(w: bigint, tz: string): bigint {
  const offsets = new Set<bigint>();
  for (let k = -36n; k <= 36n; k++) offsets.add(offsetAt(w + k * HOUR, tz));
  const shown = [...offsets].map((o) => w - o).filter((us) => wallOf(us, tz) === w);
  if (shown.length > 0) return shown.reduce((a, b) => (a > b ? a : b));
  const lastBefore = firstWhere(w - 40n * HOUR, w + 40n * HOUR, (us) => wallOf(us, tz) > w) - US;
  return w - offsetAt(lastBefore, tz);
}

export type Interval = { start: bigint; end: bigint } | null;
const interval = (start: bigint, end: bigint): Interval => (start < end ? { start, end } : null);

export type Shift = "none" | "previous_period" | "previous_year";
export type Clamp = "unit" | "calendar";

export function toDateWindow(
  tz: string,
  T: bigint,
  H: bigint,
  unit: string,
  anchors: Anchors,
  shift: Shift,
  clamp: Clamp = "unit",
): Interval {
  const asOf = localDate(T - 1n, tz);
  const S = bucket(asOf, resolveGrain(unit, anchors));
  const E = addDays(asOf, 1);
  const hw = wallOf(H, tz);
  const range = { to_date: unit };
  if (hw >= wallDate(E)) {
    if (shift === "none") return interval(dayStart(S, tz), dayStart(E, tz));
    const [ps, pe] = windows(range, asOf, anchors, shift).previous;
    return interval(dayStart(ps, tz), dayStart(pe, tz));
  }
  if (hw <= wallDate(S)) return null;
  if (shift === "none") return interval(dayStart(S, tz), H);
  const prevStart = shift === "previous_year" ? addUnits(S, "year", -1) : addUnits(S, unit, -1);
  const limit =
    clamp === "unit"
      ? addUnits(prevStart, unit, 1)
      : windows(range, asOf, anchors, shift).previous[1];
  const cut = wallDate(prevStart) + (hw - wallDate(S));
  if (cut >= wallDate(limit)) return interval(dayStart(prevStart, tz), dayStart(limit, tz));
  return interval(dayStart(prevStart, tz), wallToInstant(cut, tz));
}

export function boundAt(bound: string, tz: string): bigint {
  if (!bound.endsWith("Z")) return dayStart(bound, tz);
  const m = /^(.{19})(?:\.(\d{1,6}))?Z$/.exec(bound);
  if (m === null) throw new Error("bad bound " + bound);
  return BigInt(Date.parse(m[1] + "Z")) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function transitions(tz: string, from: bigint, to: bigint): bigint[] {
  const out: bigint[] = [];
  let prev = offsetAt(from, tz);
  for (let t = from + DAY / 2n; t < to; t += DAY / 2n) {
    const o = offsetAt(t, tz);
    if (o !== prev) {
      const before = prev;
      out.push(firstWhere(t - DAY / 2n, t, (us) => offsetAt(us, tz) !== before));
      prev = o;
    }
  }
  return out;
}

export const iso = (us: bigint) => {
  const s = floor(us, US);
  return (
    new Date(Number(s) * 1000).toISOString().slice(0, 19) +
    "." +
    String(us - s * US).padStart(6, "0") +
    "Z"
  );
};
export const wallText = (w: bigint) => iso(w).slice(0, 26);
