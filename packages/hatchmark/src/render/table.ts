import type { TableData } from "../compiler/dashboard-data.js";
import { isNumber, metricOf, type RenderContext } from "./chart.js";
import { formatKey, formatValue } from "./format.js";
import { esc, r } from "./svg.js";

/**
 * A real HTML table: one column per by column, one per metric, a share column after every metric
 * in percentOfTotal (track bar plus percent), and the total row in the footer. Long keys wrap to at
 * most two lines and keep their full text in a title. An outer key that repeats the row above is
 * left to screen readers, so groups read as groups.
 */
export function renderTable(block: TableData, ctx: RenderContext): string {
  const locale = ctx.data.locale;
  const metrics = block.metrics.map((m) => metricOf(ctx, m));
  const shareFormat = { format: { type: "percent", decimals: 1 } } as const;
  const keyClass = (i: number) =>
    `hm-key${i === 0 ? "" : " hm-key2"}${i === block.by.length - 1 ? " hm-fill" : ""}`;
  const maxShare = Object.fromEntries(
    block.percentOfTotal.map((m) => [
      m,
      Math.max(0, ...block.rows.map((row) => row.share?.[m]).filter(isNumber)),
    ]),
  );
  const head = [
    ...block.by.map((b, i) => `<th scope="col" class="${keyClass(i)}">${esc(b.label)}</th>`),
    ...metrics.flatMap((m) => [
      `<th scope="col">${esc(m.label)}</th>`,
      ...(block.percentOfTotal.includes(m.name)
        ? [
            `<th scope="col" class="hm-share">${block.percentOfTotal.length > 1 ? `${esc(m.label)} ` : ""}% of total</th>`,
          ]
        : []),
    ]),
  ].join("");
  const cell = (value: number | null | undefined, name: string) =>
    `<td${isNumber(value) ? "" : ' class="hm-null"'}>${esc(formatValue(value ?? null, metricOf(ctx, name), locale, "full"))}</td>`;
  const shareCell = (share: number | null | undefined, name: string, bar: boolean) => {
    const width =
      isNumber(share) && (maxShare[name] ?? 0) > 0 ? share / (maxShare[name] as number) : 0;
    const track = bar
      ? `<span class="hm-track" aria-hidden="true"><span style="width:${r(Math.max(0, Math.min(1, width)) * 100)}%"></span></span>`
      : "";
    return `<td class="hm-share${isNumber(share) ? "" : " hm-null"}">${track}${esc(formatValue(share ?? null, shareFormat, locale, "full"))}</td>`;
  };
  const values = (
    get: (m: string) => number | null | undefined,
    share: (m: string) => number | null | undefined,
    bar: boolean,
  ) =>
    block.metrics
      .flatMap((m) => [
        cell(get(m), m),
        ...(block.percentOfTotal.includes(m) ? [shareCell(share(m), m, bar)] : []),
      ])
      .join("");
  const rows = block.rows
    .map((row, r) => {
      const previous = block.rows[r - 1]?.keys;
      const keys = row.keys.map((key, i) => {
        const text = formatKey(key, locale);
        const repeat =
          i < row.keys.length - 1 && previous?.slice(0, i + 1).every((k, j) => k === row.keys[j]);
        const cls = `${keyClass(i)}${key === null ? " hm-null" : ""}`;
        const tag = i === 0 ? 'th scope="row"' : "td";
        return `<${tag} class="${cls}" title="${esc(text)}"><span${repeat ? ' class="hm-sr"' : ""}>${esc(text)}</span></${tag.split(" ")[0]}>`;
      });
      return `<tr>${keys.join("")}${values(
        (m) => row.values[m],
        (m) => row.share?.[m],
        true,
      )}</tr>`;
    })
    .join("");
  const total = block.total
    ? `<tfoot><tr><th scope="row" class="hm-key"${block.by.length > 1 ? ` colspan="${block.by.length}"` : ""}>Total</th>${values(
        (m) => block.total?.values[m],
        (m) => block.total?.share?.[m] ?? (isNumber(block.total?.values[m]) ? 1 : null),
        false,
      )}</tr></tfoot>`
    : "";
  const shown = block.rows.length;
  const note =
    block.rowCount > shown
      ? `<p class="hm-table-note">Showing ${shown} of ${block.rowCount} rows${block.total ? `. The total covers all ${block.rowCount}` : ""}.</p>`
      : "";
  const empty = shown === 0 ? `<p class="hm-table-note">No rows in this period.</p>` : "";
  return `<div class="hm-table-wrap" tabindex="0" role="region" aria-labelledby="hm-${esc(block.id)}-t"><table class="hm-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody>${total}</table></div>${empty}${note}`;
}
