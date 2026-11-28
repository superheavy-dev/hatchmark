import type { MapData, MapRegion, MapScale } from "../compiler/dashboard-data.js";
import type { Geography } from "../geo/types.js";
import type { Format } from "../spec/index.js";
import { CAPTION, isNumber, lowerFirst, metricOf, type RenderContext, SHARE } from "./chart.js";
import {
  formatKey,
  formatScientific,
  formatSpan,
  formatValue,
  type NumberStyle,
} from "./format.js";
import { textWidth } from "./measure.js";
import { esc, langAttr, r, scriptJson, svgText } from "./svg.js";
import { type MapColor, onMapColor, type Theme } from "./theme.js";

/** At or above this card width the bar list sits beside the map, else below it. */
export const MAP_SIDE_MIN = 640;
export const MAP_LIST_WIDTH = 260;
export const MAP_LIST_GAP = 24;
const MAX_HEIGHT = 520;
const LEADER_SWATCH = 8;
const TILE_LABEL_MIN = 8;
const TILE_LABEL_SHARE = 0.5;

/**
 * The fill of each class, lowest first. Sequential scales take the theme's ramp for their number
 * of classes (a scale whose breaks collapsed below 3 classes takes the ends or the middle of the
 * 3-class ramp). Diverging scales take the diverging ramp with arms as long as the longer side of
 * the midpoint, each side's classes aligned to the arm's inner end, and the neutral for a class
 * that straddles the midpoint.
 */
export function classColors(scale: MapScale): MapColor[] {
  const n = scale.breaks.length + 1;
  const mid = scale.midpoint;
  if (mid === undefined) {
    if (n >= 3)
      return Array.from({ length: n }, (_, k) => `seq${Math.min(n, 7)}-${k + 1}` as MapColor);
    return n === 2 ? ["seq3-1", "seq3-3"] : ["seq3-2"];
  }
  const side = Array.from({ length: n }, (_, k) => {
    const lo = k === 0 ? Number.NEGATIVE_INFINITY : (scale.breaks[k - 1] as number);
    const hi = k === n - 1 ? Number.POSITIVE_INFINITY : (scale.breaks[k] as number);
    return hi <= mid ? -1 : lo >= mid ? 1 : 0;
  });
  const below = side.filter((s) => s < 0).length;
  const above = side.filter((s) => s > 0).length;
  const neutral = side.includes(0) ? 1 : 0;
  const arm = Math.min(3, Math.max(2, below, above));
  const count = 2 * arm + neutral;
  let b = 0;
  let a = 0;
  return side.map((s) => {
    const index = s < 0 ? arm - below + 1 + b++ : s > 0 ? arm + neutral + 1 + a++ : arm + 1;
    return `div${count}-${index}` as MapColor;
  });
}

/** The fill of a region: its class colour, or undefined for no data. */
export function regionColor(
  region: MapRegion | undefined,
  colors: MapColor[],
): MapColor | undefined {
  return region?.class === undefined ? undefined : colors[region.class];
}

/** Where the map and its list go at a card width. */
export function mapLayout(block: MapData, width: number) {
  const side = block.pair === "bars" && width >= MAP_SIDE_MIN;
  const mapWidth = side ? width - MAP_LIST_WIDTH - MAP_LIST_GAP : width;
  return { side, mapWidth };
}

function mapScaleAt(geography: Geography, width: number): number {
  return Math.min(width / geography.width, MAX_HEIGHT / geography.height);
}

/**
 * A choropleth's regions, drawn once in the geography's own coordinates and scaled to the plot by
 * its viewBox: each region filled with its value's class colour, or left open over the no-data
 * layer underneath. Borders and inset frames keep their width in pixels at any scale.
 */
export function renderMapSvg(block: MapData, ctx: RenderContext, geography: Geography): string {
  const { paint } = ctx;
  const byId = new Map(block.regions.map((g) => [g.id, g]));
  const colors = classColors(block.scale);
  const stroke = ` stroke-width="${ctx.theme.map.regionStroke}" vector-effect="non-scaling-stroke"`;
  const filled: string[] = [];
  const open: string[] = [];
  for (const g of geography.regions) {
    const fill = regionColor(byId.get(g.id), colors);
    const id = `hm-${esc(block.id)}-${esc(g.id)}`;
    if (fill)
      filled.push(
        `<path id="${id}" d="${g.d}" data-hm-r="${esc(g.id)}"${paint.attrs(fill, "card", "hm-region")}${stroke}/>`,
      );
    else
      open.push(
        `<path id="${id}" d="${g.d}" data-hm-r="${esc(g.id)}"${paint.attrs(undefined, "card", "hm-region hm-nodata")}${stroke}/>`,
      );
  }
  const frames = geography.insets.map(
    (f) =>
      `<rect x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}"${paint.attrs("none", "borderStrong")} stroke-width="${ctx.theme.map.insetStroke}" vector-effect="non-scaling-stroke"/>`,
  );
  const label =
    block.title ??
    `${metricOf(ctx, block.metric).label} by ${block.geo === "us-states" ? "state" : "country"}`;
  return `<svg class="hm-map-svg" viewBox="0 0 ${geography.width} ${geography.height}" role="img" aria-label="${esc(label)}" aria-describedby="hm-${esc(block.id)}-d" data-hm-kind="map"><g class="hm-regions" stroke-linejoin="round">${filled.join("")}<g fill="none" pointer-events="all">${open.join("")}</g></g>${frames.join("")}<g class="hm-hover"/></svg>`;
}

/**
 * The layers a map needs per plot width, in the geography's coordinates like the regions: under
 * them, the no-data crosshatch, whose tile is a fixed size in pixels; over them, on us-states, the
 * labels of the small north-eastern states and DC in the column the geography leaves for them,
 * with leader lines, at the theme's text size.
 */
export function mapLayers(
  block: MapData,
  ctx: RenderContext,
  geography: Geography,
  width: number,
  variant: string,
): { under: string; over: string } {
  const { paint } = ctx;
  const s = mapScaleAt(geography, width);
  const u = (px: number) => Math.round((px / s) * 1e3) / 1e3;
  const byId = new Map(block.regions.map((g) => [g.id, g]));
  const colors = classColors(block.scale);
  const hatch = `hm-nd-${esc(block.id)}-${variant}`;
  const box = `viewBox="0 0 ${geography.width} ${geography.height}" aria-hidden="true"`;
  const holes = geography.regions
    .filter((g) => regionColor(byId.get(g.id), colors) === undefined)
    .map((g) => `<use href="#hm-${esc(block.id)}-${esc(g.id)}"/>`);
  const under =
    holes.length === 0
      ? ""
      : `<svg class="hm-map-layer" ${box}><defs>${noDataPattern(ctx, hatch, s)}</defs><g fill="url(#${hatch})">${holes.join("")}</g></svg>`;
  const { leader } = ctx.theme;
  const rows = geography.regions
    .flatMap((g) => (g.leader === undefined ? [] : [g.leader.y]))
    .sort((a, b) => a - b);
  const pitch = Math.min(...rows.slice(1).map((y, i) => y - (rows[i] as number))) * s;
  const labels = geography.regions.flatMap((g) => {
    if (g.leader === undefined || pitch < leader.size) return [];
    const fill = regionColor(byId.get(g.id), colors);
    const sw = u(LEADER_SWATCH);
    const { x, y } = g.leader;
    const swatch = fill
      ? `<rect x="${x}" y="${r(y - sw / 2)}" width="${sw}" height="${sw}" rx="${u(1)}"${paint.attrs(fill)}/>`
      : `<rect x="${x}" y="${r(y - sw / 2)}" width="${sw}" height="${sw}" rx="${u(1)}" fill="url(#${hatch}-k)"${paint.attrs(undefined, "textSubtle")} stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    return [
      `<g class="hm-leader" data-hm-r="${esc(g.id)}"><path d="M${g.label[0]},${g.label[1]}L${r(x - u(leader.gap))},${y}"${paint.attrs("none", "textSubtle")} stroke-width="${leader.lineWidth}" vector-effect="non-scaling-stroke"/><circle cx="${g.label[0]}" cy="${g.label[1]}" r="${u(leader.dot)}"${paint.attrs("textSubtle")}/>${swatch}${svgText(paint, r(x + sw + u(leader.gap)), y, g.id, { size: u(leader.size), color: "textMuted" })}</g>`,
    ];
  });
  const over =
    geography.labels === "inside"
      ? tileLabels(
          ctx,
          geography,
          new Map(geography.regions.map((g) => [g.id, regionColor(byId.get(g.id), colors)])),
          s,
          box,
        )
      : labels.length === 0
        ? ""
        : `<svg class="hm-map-layer hm-map-labels" ${box}><defs>${noDataPattern(ctx, `${hatch}-k`, s)}</defs>${labels.join("")}</svg>`;
  return { under, over };
}

function tileLabels(
  ctx: RenderContext,
  geography: Geography,
  fills: Map<string, MapColor | undefined>,
  scale: number,
  box: string,
): string {
  const pitch = Math.sqrt(geography.regions[0]?.area ?? 0) * scale;
  const size = Math.min(ctx.theme.leader.size, Math.floor(pitch * TILE_LABEL_SHARE));
  if (size < TILE_LABEL_MIN) return "";
  const u = (px: number) => Math.round((px / scale) * 1e3) / 1e3;
  const texts = geography.regions.map(
    (g) =>
      `<text x="${g.label[0]}" y="${g.label[1]}" dy="0.35em" text-anchor="middle" font-size="${u(size)}" font-weight="500"${tileLabelPaint(ctx, fills.get(g.id))}>${esc(g.id)}</text>`,
  );
  return `<svg class="hm-map-layer hm-map-tiles" ${box}>${texts.join("")}</svg>`;
}

function tileLabelPaint(ctx: RenderContext, fill: MapColor | undefined): string {
  if (fill === undefined) return ctx.paint.attrs("textMuted");
  if (ctx.paint.mode === undefined) return ` class="hm-on-${fill}"`;
  return ` fill="${onMapColor(ctx.theme, ctx.paint.mode, fill)}"`;
}

/**
 * The no-data crosshatch on land: lines at 45 and 135 degrees on a square tile, so it never reads as
 * the single hatch of a partial period. scale is the drawing's scale, so the tile stays the theme's
 * size in pixels.
 */
export function noDataPattern(ctx: RenderContext, id: string, scale: number): string {
  const { paint, theme } = ctx;
  const t = theme.noData.spacing;
  const opacity =
    paint.mode === undefined ? "" : ` stroke-opacity="${theme.noData.opacity[paint.mode]}"`;
  const transform =
    scale === 1 ? "" : ` patternTransform="scale(${Math.round((1 / scale) * 1e5) / 1e5})"`;
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${t}" height="${t}"${transform}><rect width="${t}" height="${t}"${paint.attrs("land")}/><path d="M0,0L${t},${t}M${t},0L0,${t}"${paint.attrs("none", "textSubtle", "hm-nd-line")} stroke-width="${theme.noData.strokeWidth}"${opacity}/></pattern>`;
}

/** A region's text for the list, tooltip and table. */
export function regionTexts(block: MapData, ctx: RenderContext, region: MapRegion) {
  const metric = metricOf(ctx, block.metric);
  const ranked = block.regions.filter((g) => isNumber(g.value)).length;
  return {
    value: formatValue(region.value, metric, ctx.data.locale, "full"),
    short: formatValue(region.value, metric, ctx.data.locale, "compact"),
    rank: region.rank === undefined ? "" : `#${region.rank} of ${ranked}`,
    share:
      region.share === undefined ? "" : formatValue(region.share, SHARE, ctx.data.locale, "full"),
  };
}

/** The legend's class edges as text: every break, in the metric's format. */
export function breakLabels(block: MapData, ctx: RenderContext): string[] {
  const metric = metricOf(ctx, block.metric);
  const labels = (style: NumberStyle, format: Format) =>
    block.scale.breaks.map((b) => formatValue(b, { format }, ctx.data.locale, style));
  const distinct = (texts: string[]) => texts.every((t, i) => i === 0 || t !== texts[i - 1]);
  const compact = labels("compact", metric.format);
  if (distinct(compact)) return compact;
  for (let decimals = 0; decimals <= 6; decimals++) {
    const full = labels("full", { ...metric.format, decimals } as Format);
    if (distinct(full)) return full;
  }
  for (let digits = 1; digits <= 17; digits++) {
    const scientific = block.scale.breaks.map((b) =>
      formatScientific(b, metric, ctx.data.locale, digits),
    );
    if (distinct(scientific)) return scientific;
  }
  return labels("full", metric.format);
}

/**
 * Map styles: the list beside the map comes from the layout rules (hm-ms<i>); otherwise the list
 * sits under the map and scrolls past 320 px. A hovered region gets a card-coloured halo and a
 * text-coloured outline above every other region; its row gets the outline on its bar.
 */
export function mapStyles(theme: Theme): string {
  return [
    `.hm-map{display:flex;flex-direction:column;gap:12px}.hm-map-legend{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 16px;font-size:12px;line-height:16px;color:var(--hm-text-muted)}.hm-map-classes{display:block;max-width:100%;height:auto}.hm-map-none{display:inline-flex;align-items:center;gap:6px;padding-top:0}.hm-nd-line{stroke-opacity:var(--hm-nodata)}`,
    `.hm-map-body{display:grid;grid-template-columns:minmax(0,1fr);gap:16px ${MAP_LIST_GAP}px}.hm-map-plot{position:relative;min-width:0}.hm-map-frame{position:relative;margin:0 auto}.hm-map-svg{display:block;width:100%;height:auto;overflow:visible}.hm-map-svg:focus{outline:none}.hm-map-svg:focus-visible{outline:2px solid var(--hm-focus);outline-offset:2px}.hm-map-layers{position:absolute;inset:0;pointer-events:none}.hm-map-layers svg{display:block;width:100%;height:100%;overflow:visible}.hm-map-labels .hm-leader{pointer-events:auto}.hm-map-empty{position:absolute;left:0;right:0;top:45%;text-align:center;color:var(--hm-text-muted)}`,
    `.hm-map .hm-region,.hm-map .hm-leader{cursor:default}.hm-map .hm-hover path{fill:none;pointer-events:none}.hm-hover .hm-halo{stroke:var(--hm-card)}.hm-hover .hm-outline{stroke:var(--hm-text)}`,
    `.hm-map-side{min-width:0}.hm-map-side-in{display:flex;flex-direction:column;gap:8px}.hm-map-list{display:grid;grid-template-columns:auto fit-content(40%) minmax(48px,1fr) auto;column-gap:8px;align-content:start;list-style:none;margin:0;padding:0 4px 0 0;max-height:320px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--hm-border-strong) transparent}`,
    `.hm-map-list li{grid-column:1/-1;display:grid;grid-template-columns:subgrid;align-items:center;height:24px;font-size:12px;line-height:16px;border-radius:${theme.radius.control}px;padding:0 4px}.hm-ml-k{color:var(--hm-text-subtle);text-align:right}.hm-ml-n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hm-text-muted)}.hm-ml-bar{height:8px;background:var(--hm-card-alt)}.hm-ml-bar i{display:block;height:8px;min-width:1px}.hm-ml-v{text-align:right;white-space:nowrap}.hm-ml-v.hm-null{color:var(--hm-text-subtle)}`,
    `.hm-map-list li.hm-on .hm-ml-n{color:var(--hm-text);font-weight:500}.hm-map-list li.hm-on .hm-ml-bar i{outline:1.5px solid var(--hm-text);outline-offset:-0.75px}.hm-map-note{font-size:12px;line-height:16px;color:var(--hm-text-subtle)}`,
    `.hm-map .hm-tip-k{color:var(--hm-text-muted)}`,
  ].join("");
}

/** The card heading of a map: its title (else what it measures by region) and the window. */
export function mapHeading(
  block: MapData,
  ctx: RenderContext,
): { title: string; subtitle: string } {
  const what = `${metricOf(ctx, block.metric).label} by ${block.geo === "us-states" ? "state" : "country"}`;
  const window = block.window ?? ctx.data.period.current;
  const span = window ? formatSpan(window, ctx.data.locale) : "";
  return {
    title: block.title ?? what,
    subtitle: block.title ? [what, span].filter(Boolean).join(", ") : span,
  };
}

const SWATCH_MIN = 36;
const SWATCH_MAX = 64;
const LEGEND_STAGGER = 320;

function legend(block: MapData, ctx: RenderContext): string {
  const { paint } = ctx;
  const colors = classColors(block.scale);
  const labels = breakLabels(block, ctx);
  const style = { size: CAPTION } as const;
  const swatch = Math.min(
    SWATCH_MAX,
    Math.max(SWATCH_MIN, ...labels.map((l) => Math.ceil(textWidth(l, style)) + 8)),
  );
  const width = colors.length * swatch;
  const stagger = width > LEGEND_STAGGER && labels.length > 1;
  const top = stagger ? 16 : 0;
  const height = top + 10 + 4 + 16;
  const pad = Math.ceil(Math.max(0, ...labels.map((l) => textWidth(l, style))) / 2);
  const boxes = colors.map(
    (c, k) =>
      `<rect x="${pad + k * swatch}" y="${top}" width="${swatch - 1}" height="10"${paint.attrs(c)}/>`,
  );
  const ticks = labels.map((l, k) => {
    const x = pad + (k + 1) * swatch - 0.5;
    const up = stagger && k % 2 === 1;
    return `${svgText(paint, x, up ? 8 : top + 10 + 4 + 8, l, { ...style, anchor: "middle", color: "textMuted", lang: ctx.data.locale })}`;
  });
  const svgWidth = width + 2 * pad;
  const classes = `<svg class="hm-map-classes" width="${svgWidth}" height="${height}" viewBox="0 0 ${svgWidth} ${height}" aria-hidden="true">${boxes.join("")}${ticks.join("")}</svg>`;
  const id = `hm-nd-${esc(block.id)}-lg`;
  const none = `<span class="hm-map-none"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><defs>${noDataPattern(ctx, id, 1)}</defs><rect x="0.5" y="0.5" width="13" height="13" fill="url(#${id})"${paint.attrs(undefined, "borderStrong")}/></svg>No data</span>`;
  return `<div class="hm-map-legend" aria-hidden="true">${classes}${none}</div>`;
}

function matchNote(block: MapData, ctx: RenderContext): string {
  const left = block.match.filter((m) => m.region === null && m.rows > 0);
  if (left.length === 0) return "";
  const rows = left.reduce((n, m) => n + m.rows, 0);
  const names = [...left]
    .sort((a, b) => b.rows - a.rows)
    .slice(0, 3)
    .map((m) => formatKey(m.key, ctx.data.locale));
  const more = left.length - names.length;
  return `<p class="hm-map-note">Not on the map: ${rows === 1 ? "1 row" : `${rows.toLocaleString("en-US")} rows`} with ${esc(names.join(", "))}${more > 0 ? ` and ${more} more` : ""}.</p>`;
}

function barList(block: MapData, ctx: RenderContext, names: Map<string, string>): string {
  const colors = classColors(block.scale);
  const peak = Math.max(0, ...block.regions.map((g) => Math.abs(g.value ?? 0)));
  const lang = langAttr(ctx.data.locale);
  const rows = block.regions.map((g) => {
    const texts = regionTexts(block, ctx, g);
    const color = regionColor(g, colors);
    const share = peak === 0 || !isNumber(g.value) ? 0 : (Math.abs(g.value) / peak) * 100;
    const bar = color
      ? `<i class="hm-bg-${color}" style="width:${Math.round(share * 10) / 10}%"></i>`
      : "";
    return `<li data-hm-r="${esc(g.id)}"><span class="hm-ml-k">${g.rank ?? ""}</span><span class="hm-ml-n" title="${esc(names.get(g.id) ?? g.id)}">${esc(names.get(g.id) ?? g.id)}</span><span class="hm-ml-bar">${bar}</span><span class="hm-ml-v${isNumber(g.value) ? "" : " hm-null"}"${lang}>${esc(texts.short)}</span></li>`;
  });
  return `<ol class="hm-map-list" aria-label="${esc(metricOf(ctx, block.metric).label)}, ranked">${rows.join("")}</ol>`;
}

/** One sentence for screen readers: what the map shows and its top and bottom regions. */
export function describeMap(
  block: MapData,
  ctx: RenderContext,
  names: Map<string, string>,
): string {
  const metric = metricOf(ctx, block.metric);
  const ranked = block.regions.filter((g) => isNumber(g.value));
  const kind = block.geo === "us-states" ? "US states" : "countries";
  if (ranked.length === 0) return `Map of ${kind}: no ${lowerFirst(metric.label)} in this period.`;
  const first = ranked[0] as MapRegion;
  const last = ranked.at(-1) as MapRegion;
  const value = (g: MapRegion) => formatValue(g.value, metric, ctx.data.locale, "full");
  return `Map of ${metric.label.toLowerCase() === metric.label ? metric.label : lowerFirst(metric.label)} for ${ranked.length} ${kind}, from ${names.get(first.id) ?? first.id} (${value(first)}) to ${names.get(last.id) ?? last.id} (${value(last)}).`;
}

function mapTable(
  block: MapData,
  ctx: RenderContext,
  caption: string,
  names: Map<string, string>,
): string {
  const lang = langAttr(ctx.data.locale);
  const metric = metricOf(ctx, block.metric);
  const shares = block.additive && block.regions.some((g) => g.share !== undefined);
  const head = `<tr><th scope="col">${block.geo === "us-states" ? "State" : "Country"}</th><th scope="col">${esc(metric.label)}</th><th scope="col">Rank</th>${shares ? '<th scope="col">Share of total</th>' : ""}</tr>`;
  const rows = block.regions
    .map((g) => {
      const t = regionTexts(block, ctx, g);
      return `<tr><th scope="row">${esc(names.get(g.id) ?? g.id)}</th><td${lang}>${esc(t.value)}</td><td>${esc(t.rank)}</td>${shares ? `<td${lang}>${esc(t.share)}</td>` : ""}</tr>`;
    })
    .join("");
  const total = block.additive
    ? `<tfoot><tr><th scope="row">Total</th><td${lang}>${esc(formatValue(block.total, metric, ctx.data.locale, "full"))}</td><td></td>${shares ? "<td></td>" : ""}</tr></tfoot>`
    : "";
  return `<div class="hm-sr"><table><caption>${esc(caption)}</caption><thead>${head}</thead><tbody>${rows}</tbody>${total}</table></div>`;
}

function runtimeData(block: MapData, ctx: RenderContext, names: Map<string, string>) {
  const regions: Record<string, { n: string; v?: string; k?: string; s?: string }> = {};
  for (const [id, n] of names) regions[id] = { n };
  for (const g of block.regions) {
    const t = regionTexts(block, ctx, g);
    regions[g.id] = {
      n: names.get(g.id) ?? g.id,
      v: t.value,
      ...(t.rank ? { k: t.rank } : {}),
      ...(t.share ? { s: `${t.share} of total` } : {}),
    };
  }
  return {
    label: metricOf(ctx, block.metric).label,
    regions,
    none: "No data",
    order: block.regions.map((g) => g.id),
  };
}

/**
 * A map card's body: the legend, the map drawn once per distinct width the layouts give it, the
 * ranked bar list (beside the map where the card is wide enough, under it otherwise), the note on
 * rows that are not on the map, and a screen-reader description and table.
 */
export function mapBody(
  block: MapData,
  ctx: RenderContext,
  caption: string,
  widths: number[],
  geography: Geography | undefined,
): string {
  if (geography === undefined) {
    return `<p class="hm-map-note">The ${esc(block.geo)} boundaries are not loaded on this page.</p>`;
  }
  const names = new Map(geography.regions.map((g) => [g.id, g.name]));
  const variants = new Map<number, { under: string; over: string; layouts: number[] }>();
  const side: number[] = [];
  widths.forEach((width, index) => {
    const layout = mapLayout(block, width);
    if (layout.side) side.push(index);
    const s = mapScaleAt(geography, layout.mapWidth);
    const found = variants.get(s);
    if (found) {
      found.layouts.push(index);
      return;
    }
    variants.set(s, {
      ...mapLayers(block, ctx, geography, layout.mapWidth, String(index)),
      layouts: [index],
    });
  });
  const layer = (part: "under" | "over") =>
    [...variants.values()]
      .filter((v) => v[part] !== "")
      .map(
        (v) =>
          `<div class="hm-v hm-map-layers ${v.layouts.map((l) => `hm-l${l}`).join(" ")}">${v[part]}</div>`,
      )
      .join("");
  const plot = `<div class="hm-map-frame" style="max-width:${Math.floor((geography.width * MAX_HEIGHT) / geography.height)}px">${layer("under")}${renderMapSvg(block, ctx, geography)}${layer("over")}</div>`;
  const tiles = block.shape === "tiles";
  const empty =
    block.regions.length === 0
      ? `<p class="hm-map-empty"${tiles ? ' style="position:static;margin-bottom:12px"' : ""}>${block.empty === "no_complete_day" ? "No complete day yet" : `No ${esc(lowerFirst(metricOf(ctx, block.metric).label))} in this period`}</p>`
      : "";
  const list = block.pair === "bars" ? barList(block, ctx, names) : "";
  const note = matchNote(block, ctx);
  const sideClass = side.map((i) => ` hm-ms${i}`).join("");
  return [
    `<figure class="hm-chart hm-map" data-hm-map="${esc(block.id)}">`,
    `<script type="application/json">${scriptJson(runtimeData(block, ctx, names))}</script>`,
    legend(block, ctx),
    `<div class="hm-map-body${block.pair === "bars" ? sideClass : ""}"><div class="hm-map-plot">${tiles ? empty + plot : plot + empty}</div>`,
    list || note
      ? `<div class="hm-map-side"><div class="hm-map-side-in">${list}${note}</div></div>`
      : "",
    "</div>",
    `<figcaption class="hm-sr" id="hm-${esc(block.id)}-d">${esc(describeMap(block, ctx, names))}</figcaption>`,
    mapTable(block, ctx, caption, names),
    "</figure>",
  ].join("");
}
