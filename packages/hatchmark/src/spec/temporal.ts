/**
 * A filter value compared with a date or timestamp column, parsed strictly (ISO 8601, extended
 * format) so its meaning never depends on a database's cast rules:
 *
 * - "date": zero-padded YYYY-MM-DD, a calendar day in the project time zone.
 * - "instant": YYYY-MM-DDTHH:MM[:SS[.ffffff]] with Z or ±HH:MM, an exact moment, given in UTC.
 * - "local": the same without an offset, a wall-clock time in the project time zone.
 *
 * Text is normalized to what DuckDB reads unambiguously: "YYYY-MM-DD", or "YYYY-MM-DD
 * HH:MM:SS.ffffff" (with "+00" appended for instants).
 */
export type TemporalValue =
  | { kind: "date"; text: string }
  | { kind: "instant"; text: string }
  | { kind: "local"; text: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?$/;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function validDate(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Parses a filter value for a date or timestamp column; undefined when it is not strict ISO 8601. */
export function parseTemporal(value: string): TemporalValue | undefined {
  const date = DATE.exec(value);
  if (date) {
    const [, y = "", m = "", d = ""] = date;
    return validDate(Number(y), Number(m), Number(d)) ? { kind: "date", text: value } : undefined;
  }
  const match = DATETIME.exec(value);
  if (!match) return undefined;
  const [, ys = "", ms = "", ds = "", hs = "", mins = "", ss = "00", fraction = "", offset] = match;
  const [y, m, d, h, min, s] = [ys, ms, ds, hs, mins, ss].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!validDate(y, m, d) || h > 23 || min > 59 || s > 59) return undefined;
  const micros = fraction.padEnd(6, "0");
  if (offset === undefined) {
    return { kind: "local", text: `${ys}-${ms}-${ds} ${hs}:${mins}:${pad(s)}.${micros}` };
  }
  let shift = 0;
  if (offset !== "Z") {
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return undefined;
    shift = (offset[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const t = new Date(Date.UTC(y, m - 1, d, h, min - shift, s));
  const utc = `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  return { kind: "instant", text: `${utc}.${micros}+00` };
}

/**
 * A strict spelling of a value that is close to one (unpadded parts, a space for T), for a fix;
 * undefined when there is no single obvious repair.
 */
export function temporalRepair(value: string): string | undefined {
  const loose =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!loose) return undefined;
  const [, y = "", m = "", d = "", h, min, s, fraction, offset] = loose;
  let text = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  if (h !== undefined) {
    text += `T${h.padStart(2, "0")}:${min}${s === undefined ? "" : `:${s}`}${fraction === undefined ? "" : `.${fraction}`}${offset ?? ""}`;
  }
  return text !== value && parseTemporal(text) !== undefined ? text : undefined;
}
