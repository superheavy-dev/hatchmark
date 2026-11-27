import type { TableData, TableRow } from "../compiler/dashboard-data.js";
import { isNumber, metricOf, type RenderContext } from "./chart.js";
import { formatKey, formatValue } from "./format.js";
import { esc, r } from "./svg.js";

/** Rows past which the table scrolls inside its card under a sticky header and total row. */
export const TALL_TABLE_ROWS = 15;

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
  const keyClass = (i: number) =>
    `hm-key${i === 0 ? "" : " hm-key2"}${i === width - 1 ? " hm-fill" : ""}`;
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
  const header = (label: string, by: string, cls: string, numeric: boolean, csv = label) => {
    const text = esc(label);
    const content = numeric ? `${CARET}${text}` : `${text}${CARET}`;
    const csvAttr = csv === label ? "" : ` data-csv="${esc(csv)}"`;
    return `<th scope="col"${cls ? ` class="${cls}"` : ""} aria-sort="${sortState(by)}" data-hm-num="${numeric ? 1 : 0}"${csvAttr}><button type="button" class="hm-sort">${content}</button></th>`;
  };
  const head = [
    ...block.by.map((b, i) => header(b.label, b.column, keyClass(i), false)),
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
    const cls = [bars.has(name) ? "hm-bar" : "", isNumber(value) ? "" : "hm-null"]
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
  const keyCell = (i: number, text: string, cls: string, hidden: boolean, csv = text) => {
    const tag = i === 0 ? 'th scope="row"' : "td";
    const content = text === "" ? "" : `<span${hidden ? ' class="hm-sr"' : ""}>${esc(text)}</span>`;
    const title = text === "" || hidden ? "" : ` title="${esc(text)}"`;
    return `<${tag} class="${keyClass(i)}${cls}"${title} data-v="${esc(csv)}">${content}</${tag.split(" ")[0]}>`;
  };
  const keysOf = (row: TableRow, previous: TableRow | undefined): string[] => {
    const level = row.kind === "subtotal" ? (row.level ?? 1) : undefined;
    const otherAt = row.kind === "other" ? (block.subtotals ? width - 1 : 0) : undefined;
    return row.keys.map((key, i) => {
      const text = formatKey(key, locale);
      const nullCls = key === null ? " hm-null" : "";
      if (level !== undefined) {
        if (i >= level) return keyCell(i, "", "", false, i === level ? "Subtotal" : "");
        return keyCell(i, text, nullCls, i < level - 1, key === null ? "" : text);
      }
      if (otherAt !== undefined) {
        if (i > otherAt) return keyCell(i, "", "", false);
        if (i < otherAt) return keyCell(i, text, nullCls, true, key === null ? "" : text);
        return keyCell(
          i,
          `Other (${(row.count ?? 0).toLocaleString(locale)})`,
          " hm-other",
          false,
          "Other",
        );
      }
      const repeat = block.subtotals
        ? i < width - 1
        : i < width - 1 &&
          previous !== undefined &&
          previous.kind === undefined &&
          previous.keys.slice(0, i + 1).every((k, j) => k === row.keys[j]);
      return keyCell(i, text, nullCls, repeat, key === null ? "" : text);
    });
  };
  const rows = block.rows
    .map((row, index) => {
      const kind = row.kind ?? "row";
      const level = row.kind === "subtotal" ? ` data-hm-level="${row.level ?? 1}"` : "";
      const cls = row.kind === undefined ? "" : ` class="hm-${row.kind}"`;
      const keys = keysOf(row, block.rows[index - 1]).join("");
      const cells = values(
        (m) => row.values[m],
        (m) => row.share?.[m],
        row.kind !== "subtotal",
      );
      return `<tr${cls} data-hm-kind="${kind}"${level}>${keys}${cells}</tr>`;
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
  return `<div class="hm-table-wrap${tall}" tabindex="0" role="region" aria-labelledby="hm-${esc(block.id)}-t"><table class="hm-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody>${total}</table></div>${empty}${note}`;
}
