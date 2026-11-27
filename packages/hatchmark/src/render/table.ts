import type { TableData, TableRow } from "../compiler/dashboard-data.js";
import { isNumber, metricOf, type RenderContext } from "./chart.js";
import { formatKey, formatValue } from "./format.js";
import { esc, r } from "./svg.js";

/** Rows past which the table scrolls inside its card under a sticky header and total row. */
export const TALL_TABLE_ROWS = 15;

/** An attribute value that keeps carriage returns and line feeds, which HTML parsing would fold. */
const attr = (text: string) => esc(text).replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");

const CARET = `<svg class="hm-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** A bar's start and width as fractions of its track, measured from zero across both signs. */
function barGeometry(
  value: number,
  scale: { neg: number; pos: number },
): { left: number; width: number } {
  const range = scale.neg + scale.pos;
  if (range <= 0) return { left: 0, width: 0 };
  const zero = scale.neg / range;
  const width = Math.abs(value) / range;
  return { left: value < 0 ? zero - width : zero, width };
}

function track(geometry: { left: number; width: number }, zero: number | undefined): string {
  const clamp = (v: number) => r(Math.max(0, Math.min(1, v)) * 100);
  const axis = zero === undefined ? "" : `<i class="hm-zero" style="left:${clamp(zero)}%"></i>`;
  const left = geometry.left > 0 ? `margin-left:${clamp(geometry.left)}%;` : "";
  return `<span class="hm-track" aria-hidden="true">${axis}<span style="${left}width:${clamp(geometry.width)}%"></span></span>`;
}

/**
 * A real HTML table: one column per by column, one per metric, a share column after every metric
 * in percentOfTotal (track bar plus percent), and the total row in the footer. Headers are sort
 * buttons the runtime wires up; every cell carries its raw value in data-v for sorting and the CSV
 * download. Subtotal rows lead their group, an Other row closes its group, and in-cell bars scale
 * across group and Other rows (never subtotals or the total). Long keys wrap to at most two lines
 * and keep their full text in a title. An outer key that repeats the row above, or that a subtotal
 * row already names, is left to screen readers, so groups read as groups.
 */
export function renderTable(block: TableData, ctx: RenderContext): string {
  const locale = ctx.data.locale;
  const width = block.by.length;
  const metrics = block.metrics.map((m) => metricOf(ctx, m));
  const shareFormat = { format: { type: "percent", decimals: 1 } } as const;
  const bars = new Set(block.bars ?? []);
  const scaled = block.rows.filter((row) => row.kind !== "subtotal");
  const grouped = width > 1;
  const keyClass = (i: number) =>
    `hm-key${i === 0 ? "" : " hm-key2"}${i === width - 1 ? " hm-fill" : grouped ? " hm-outer" : ""}`;
  const levelOf = (row: TableRow) => row.level ?? 1;
  const solo = new Set<number>();
  block.rows.forEach((row, index) => {
    if (row.kind !== "subtotal") return;
    const level = levelOf(row);
    let children = 0;
    for (let j = index + 1; j < block.rows.length; j++) {
      const next = block.rows[j] as TableRow;
      const nested = next.kind === "subtotal";
      if (nested && levelOf(next) <= level) break;
      if (level === width - 1 ? !nested : nested && levelOf(next) === level + 1) children++;
    }
    if (children === 1) solo.add(index);
  });
  const revealed: Set<number>[] = [];
  const stack: { level: number; solo: boolean }[] = [];
  block.rows.forEach((row, index) => {
    if (row.kind === "subtotal") stack.length = Math.min(stack.length, levelOf(row) - 1);
    revealed.push(new Set(stack.filter((a) => a.solo).map((a) => a.level - 1)));
    if (row.kind === "subtotal") stack.push({ level: levelOf(row), solo: solo.has(index) });
  });
  /** Text only the narrow layout shows; in body rows it repeats key cells, so screen readers skip it. */
  const mobile = (text: string, sub = false, spoken = false) =>
    text === ""
      ? ""
      : `<span class="hm-m${sub ? " hm-msub" : ""}"${spoken ? "" : ' aria-hidden="true"'}>${esc(text)}</span>`;
  const maxShare = Object.fromEntries(
    block.percentOfTotal.map((m) => [
      m,
      Math.max(0, ...scaled.map((row) => row.share?.[m]).filter(isNumber)),
    ]),
  );
  const barScale = Object.fromEntries(
    [...bars].map((m) => {
      const values = scaled.map((row) => row.values[m]).filter(isNumber);
      const neg = values.reduce((most, v) => Math.max(most, -v), 0);
      const pos = values.reduce((most, v) => Math.max(most, v), 0);
      return [m, { neg, pos }];
    }),
  );
  const sortState = (by: string) =>
    block.sort?.by === by ? (block.sort.order === "asc" ? "ascending" : "descending") : "none";
  const header = (
    label: string,
    by: string,
    cls: string,
    numeric: boolean,
    csv = label,
    extra = "",
  ) => {
    const text = esc(label);
    const content = numeric ? `${CARET}${text}` : `${text}${CARET}`;
    const csvAttr = csv === label ? "" : ` data-csv="${esc(csv)}"`;
    return `<th scope="col"${cls ? ` class="${cls}"` : ""} aria-sort="${sortState(by)}" data-hm-num="${numeric ? 1 : 0}"${csvAttr}><button type="button" class="hm-sort">${content}</button>${extra}</th>`;
  };
  const outerLabels = block.by
    .slice(0, -1)
    .map((b) => b.label)
    .join(" · ");
  const head = [
    ...block.by.map((b, i) =>
      header(
        b.label,
        b.column,
        keyClass(i),
        false,
        b.label,
        i === width - 1 && grouped && !block.subtotals ? mobile(outerLabels, true, true) : "",
      ),
    ),
    ...metrics.flatMap((m) => [
      header(m.label, m.name, "", true),
      ...(block.percentOfTotal.includes(m.name)
        ? [
            header(
              `${block.percentOfTotal.length > 1 ? `${m.label} ` : ""}% of total`,
              `${m.name}:share`,
              "hm-share",
              true,
              `${m.label} share of total`,
            ),
          ]
        : []),
    ]),
  ].join("");
  const raw = (value: number | null | undefined) => (isNumber(value) ? String(value) : "");
  const cell = (value: number | null | undefined, name: string, bar: boolean) => {
    const scale = barScale[name];
    const drawn =
      bar && scale !== undefined
        ? track(
            isNumber(value) ? barGeometry(value, scale) : { left: 0, width: 0 },
            scale.neg > 0 && scale.pos > 0 ? scale.neg / (scale.neg + scale.pos) : undefined,
          )
        : "";
    const cls = [bars.has(name) ? "hm-cellbar" : "", isNumber(value) ? "" : "hm-null"]
      .filter(Boolean)
      .join(" ");
    return `<td${cls ? ` class="${cls}"` : ""} data-v="${raw(value)}">${drawn}${esc(formatValue(value ?? null, metricOf(ctx, name), locale, "full"))}</td>`;
  };
  const shareCell = (share: number | null | undefined, name: string, bar: boolean) => {
    const fraction =
      isNumber(share) && (maxShare[name] ?? 0) > 0 ? share / (maxShare[name] as number) : 0;
    const drawn = bar ? track({ left: 0, width: fraction }, undefined) : "";
    return `<td class="hm-share${isNumber(share) ? "" : " hm-null"}" data-v="${raw(share)}">${drawn}${esc(formatValue(share ?? null, shareFormat, locale, "full"))}</td>`;
  };
  const values = (
    get: (m: string) => number | null | undefined,
    share: (m: string) => number | null | undefined,
    bar: boolean,
  ) =>
    block.metrics
      .flatMap((m) => [
        cell(get(m), m, bar && bars.has(m)),
        ...(block.percentOfTotal.includes(m) ? [shareCell(share(m), m, bar)] : []),
      ])
      .join("");
  const keyCell = (
    i: number,
    text: string,
    cls: string,
    hidden: boolean,
    value: string | number | boolean | null = text,
    extra = "",
  ) => {
    const tag = i === 0 ? 'th scope="row"' : "td";
    const content = `${text === "" ? "" : `<span${hidden ? ' class="hm-sr"' : ""}>${esc(text)}</span>`}${extra}`;
    const title = text === "" || hidden ? "" : ` title="${esc(text)}"`;
    return `<${tag} class="${keyClass(i)}${cls}"${title}${typeof value === "number" ? ' data-t="n"' : ""} data-v="${attr(value === null ? "" : String(value))}">${content}</${tag.split(" ")[0]}>`;
  };
  const keysOf = (row: TableRow, previous: TableRow | undefined, shown: Set<number>): string[] => {
    const level = row.kind === "subtotal" ? (row.level ?? 1) : undefined;
    const otherAt = row.kind === "other" ? (block.subtotals ? width - 1 : 0) : undefined;
    const other = `Other (${(row.count ?? 0).toLocaleString(locale)})`;
    const outer = (indices: number[]) =>
      indices.map((i) => formatKey(row.keys[i] ?? null, locale)).join(" · ");
    const inner = width - 1;
    const extra = !grouped
      ? ""
      : level !== undefined
        ? mobile(formatKey(row.keys[level - 1] ?? null, locale))
        : otherAt !== undefined
          ? otherAt < inner
            ? mobile(other)
            : ""
          : block.subtotals
            ? mobile(outer([...shown].sort()), true)
            : mobile(outer(Array.from({ length: inner }, (_, i) => i)), true);
    return row.keys.map((key, i) => {
      const text = formatKey(key, locale);
      const nullCls = key === null ? " hm-null" : "";
      const tail = i === inner ? extra : "";
      if (level !== undefined) {
        if (i >= level) return keyCell(i, "", "", false, i === level ? "Subtotal" : "", tail);
        return keyCell(i, text, nullCls, i < level - 1 && !shown.has(i), key, tail);
      }
      if (otherAt !== undefined) {
        if (i > otherAt) return keyCell(i, "", "", false, "", tail);
        if (i < otherAt) return keyCell(i, text, nullCls, !shown.has(i), key);
        return keyCell(i, other, " hm-other", false, "Other");
      }
      const repeat = block.subtotals
        ? i < width - 1 && !shown.has(i)
        : i < width - 1 &&
          previous !== undefined &&
          previous.kind === undefined &&
          previous.keys.slice(0, i + 1).every((k, j) => k === row.keys[j]);
      return keyCell(i, text, nullCls, repeat, key, tail);
    });
  };
  const rows = block.rows
    .map((row, index) => {
      const kind = row.kind ?? "row";
      const level = row.kind === "subtotal" ? ` data-hm-level="${row.level ?? 1}"` : "";
      const cls = row.kind === undefined ? "" : ` class="hm-${row.kind}"`;
      const keys = keysOf(row, block.rows[index - 1], revealed[index] ?? new Set()).join("");
      const lead = row.kind !== "subtotal" && solo.has(index - 1) ? " data-hm-lead" : "";
      const single = solo.has(index) ? " data-hm-solo" : lead;
      const cells = values(
        (m) => row.values[m],
        (m) => row.share?.[m],
        row.kind !== "subtotal",
      );
      return `<tr${cls} data-hm-kind="${kind}"${level}${single}>${keys}${cells}</tr>`;
    })
    .join("");
  const total = block.total
    ? `<tfoot><tr><th scope="row" class="hm-key"${width > 1 ? ` colspan="${width}"` : ""} data-v="Total">Total</th>${values(
        (m) => block.total?.values[m],
        (m) => block.total?.share?.[m] ?? (isNumber(block.total?.values[m]) ? 1 : null),
        false,
      )}</tr></tfoot>`
    : "";
  const shown = block.rows.filter((row) => row.kind === undefined).length;
  const folded = block.rows.some((row) => row.kind === "other");
  const covered = folded
    ? `. Other combines the remaining ${block.rowCount - shown}`
    : block.total
      ? `. The total covers all ${block.rowCount}`
      : "";
  const note =
    block.rowCount > shown
      ? `<p class="hm-table-note">Showing ${shown} of ${block.rowCount} rows${covered}.</p>`
      : "";
  const empty =
    block.rows.length === 0 ? `<p class="hm-table-note">No rows in this period.</p>` : "";
  const tall = block.rows.length > TALL_TABLE_ROWS ? " hm-tall" : "";
  return `<div class="hm-table-wrap${tall}" tabindex="0" role="region" aria-labelledby="hm-${esc(block.id)}-t"><table class="hm-table${grouped ? (block.subtotals ? " hm-ma" : " hm-mb") : ""}${grouped && block.subtotals && width > 2 ? " hm-deep" : ""}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody>${total}</table></div>${empty}${note}`;
}
