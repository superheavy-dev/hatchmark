// Source horizons need microseconds (RFC 0001 section 6.1), which Date and Date.parse drop,
// so instants are bigint microseconds since 1970-01-01T00:00:00Z.
export const DAY_US = 86_400_000_000n;

const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

export function parseInstant(text: string): bigint {
  const match =
    /^(\d{4,5})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?Z?$/.exec(text);
  if (match === null) throw new RangeError(`not an instant: ${text}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", f = ""] = match;
  const seconds =
    BigInt(daysFromCivil(Number(y), Number(mo), Number(d))) * 86_400n +
    BigInt(Number(h) * 3600 + Number(mi) * 60 + Number(s));
  return seconds * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

export function formatWall(us: bigint): string {
  const seconds = floorDiv(us, 1_000_000n);
  const micros = us - seconds * 1_000_000n;
  const days = floorDiv(seconds, 86_400n);
  const rest = Number(seconds - days * 86_400n);
  const { y, m, d } = civilFromDays(Number(days));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m)}-${p(d)}T${p(Math.floor(rest / 3600))}:${p(Math.floor(rest / 60) % 60)}:${p(rest % 60)}.${String(micros).padStart(6, "0")}`;
}

export const formatInstant = (us: bigint) => `${formatWall(us)}Z`;

const formatters = new Map<string, Intl.DateTimeFormat>();

function offsetSeconds(us: bigint, timezone: string): bigint {
  let format = formatters.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, format);
  }
  const seconds = floorDiv(us, 1_000_000n);
  const parts = Object.fromEntries(
    format.formatToParts(new Date(Number(seconds) * 1000)).map((p) => [p.type, p.value]),
  );
  const year =
    parts.era === "BC" || parts.era === "B" ? 1 - Number(parts.year) : Number(parts.year);
  const wall =
    BigInt(daysFromCivil(year, Number(parts.month), Number(parts.day))) * 86_400n +
    BigInt(Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second));
  return wall - seconds;
}

export function toLocal(us: bigint, timezone: string): bigint {
  return us + offsetSeconds(us, timezone) * 1_000_000n;
}

function readings(wall: bigint, timezone: string): { before: bigint; shown: bigint[] } {
  const before = wall - offsetSeconds(wall - DAY_US, timezone) * 1_000_000n;
  const after = wall - offsetSeconds(wall + DAY_US, timezone) * 1_000_000n;
  const shown = [...new Set([before, after])].filter((us) => toLocal(us, timezone) === wall);
  return { before, shown };
}

export function fromLocal(wall: bigint, timezone: string): bigint {
  const { before, shown } = readings(wall, timezone);
  if (shown.length === 0) return before;
  return shown.reduce((a, b) => (a > b ? a : b));
}

export function isRepeated(wall: bigint, timezone: string): boolean {
  return readings(wall, timezone).shown.length > 1;
}

/**
 * The local wall time of the last microsecond read before an instant. An instant whose local wall
 * time is midnight ends the day before, even when a fall-back repeats that midnight.
 */
export function lastWallBefore(us: bigint, timezone: string): bigint {
  const wall = toLocal(us, timezone);
  return wall % DAY_US === 0n ? wall - 1n : toLocal(us - 1n, timezone);
}

export const describeInstant = (us: bigint, timezone: string) =>
  formatWall(toLocal(us, timezone)).slice(0, 16).replace("T", " ");
