// WebKit does not scroll a focused, clipped table with the arrow keys, so the runtime does. The KPI
// tooltip is position:fixed so the strip's overflow does not clip it, and .hm-root's container-type
// makes .hm-root its containing block.

import { loadEngine, mountPeriod, type PeriodView, writeParam } from "./period-control.js";
import { wireTable } from "./table.js";

interface RuntimeSeries {
  label: string;
  color: number | string;
  group?: number;
  name?: string;
  v: (number | null)[];
  text: string[];
  short: string[];
  y?: (number | null)[];
  pct?: string[];
  partial?: number[];
}

interface RuntimeChart {
  kind: "line" | "bar" | "pie" | "scatter";
  swatch: "line" | "square";
  colors?: number[];
  cuts?: number[];
  groups?: string[];
  headers: string[];
  series: RuntimeSeries[];
  total?: string[];
  heads?: string[];
  status?: string[];
  totalStatus?: string[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

const numbers = (svg: Element, name: string): number[] =>
  (svg.getAttribute(`data-hm-${name}`) ?? "").split(",").map(Number);

const scatterPoints = (svg: Element): number[][] =>
  (svg.getAttribute("data-hm-pts") ?? "")
    .split(",")
    .filter((p) => p !== "")
    .map((p) => p.split(" ").map(Number));

const SCATTER_PICK = 24;

const span = (svg: Element, name: string, parts: number): [number, number] => {
  const [a = 0, b = 0] = numbers(svg, name);
  return [a, parts > 0 ? (b - a) / parts : 0];
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function attach(figure: HTMLElement, chart: RuntimeChart): void {
  const n = chart.headers.length;
  const kpi = figure.classList.contains("hm-kpi");
  const live = element("div", "hm-sr");
  live.setAttribute("aria-live", "polite");
  figure.append(live);
  let tip: HTMLDivElement | undefined;
  let overlay: SVGElement | undefined;
  let current: { svg: SVGSVGElement; index: number } | undefined;

  const hide = () => {
    overlay?.remove();
    overlay = undefined;
    if (current && chart.kind === "pie") current.svg.classList.remove("hm-dim");
    if (tip) tip.style.display = "none";
    if (current) resetReadout(current.svg);
    current = undefined;
  };

  const resetReadout = (svg: SVGSVGElement) => {
    if (!svg.hasAttribute("data-hm-readout")) return;
    let last = -1;
    for (const s of chart.series) {
      for (let i = n - 1; i > last; i--) {
        if (s.v[i] !== null && s.v[i] !== undefined) {
          last = i;
          break;
        }
      }
    }
    if (last >= 0) fillReadout(svg, last);
  };

  const fillReadout = (svg: SVGSVGElement, index: number) => {
    const head = svg.querySelector(".hm-rh");
    if (head) head.textContent = (chart.heads ?? chart.headers)[index] ?? "";
    const status = svg.querySelector(".hm-rs");
    if (status) status.textContent = chart.status?.[index] ?? "";
    const hatched = chart.series.some((s) => s.partial?.includes(index));
    const show = (node: Element | null, on: boolean) =>
      node?.setAttribute("visibility", on ? "visible" : "hidden");
    show(svg.querySelector(".hm-rsw"), hatched && Boolean(chart.status?.[index]));
    chart.series.forEach((s, k) => {
      const value = svg.querySelector(`.hm-rv-${k}`);
      if (value) value.textContent = s.short[index] ?? "";
      const partial = Boolean(s.partial?.includes(index));
      const hatch = svg.querySelector(`.hm-rq-${k}`);
      if (hatch) {
        show(hatch, partial);
        show(svg.querySelector(`.hm-rd-${k}`), !partial);
      }
    });
  };

  const tooltip = (index: number): HTMLDivElement => {
    if (!tip) {
      tip = element("div", chart.swatch === "square" ? "hm-tip hm-tip-sq" : "hm-tip");
      tip.setAttribute("aria-hidden", "true");
      figure.append(tip);
    }
    tip.replaceChildren(element("div", "hm-tip-h", chart.headers[index] ?? ""));
    const scatter = chart.kind === "scatter";
    const status = chart.status?.[index];
    const hatched = chart.series.some((s) => s.partial?.includes(index));
    if (status) {
      const line = element("div", "hm-tip-s");
      if (hatched) line.append(element("i", "hm-tip-hatch"));
      line.append(status);
      tip.append(line);
    }
    const rows = chart.series.map((s, k) => ({ s, k, v: s.v[index] ?? null }));
    if (rows.length > 1 && !scatter && !chart.groups) {
      rows.sort(
        (a, b) =>
          (b.v ?? Number.NEGATIVE_INFINITY) - (a.v ?? Number.NEGATIVE_INFINITY) || a.k - b.k,
      );
    }
    rows.forEach(({ s, k }) => {
      if (s.group !== undefined && chart.series[k - 1]?.group !== s.group) {
        tip?.append(element("div", "hm-tip-g", chart.groups?.[s.group] ?? ""));
      }
      const row = element("div", "hm-tip-r");
      const name = element("span", "hm-tip-n");
      const slot = chart.colors ? chart.colors[index] : s.color;
      const key = `${chart.swatch === "square" ? "f" : "c"}${slot}`;
      if (s.partial?.includes(index)) name.append(element("i", `hm-tip-hatch hm-h-f${slot}`));
      else if (rows.length > 1 && !scatter)
        name.append(element("i", slot === 0 ? "hm-b-context" : `hm-b-${key}`));
      name.append(s.label);
      const value = element("span", "hm-tip-v", s.text[index] ?? "");
      if (s.pct) value.append(element("span", "hm-tip-p", s.pct[index] ?? ""));
      row.append(name, value);
      tip?.append(row);
    });
    if (chart.total) {
      const row = element("div", "hm-tip-r hm-tip-t");
      const value = element("span", "hm-tip-v", chart.total[index] ?? "");
      if (chart.series.some((s) => s.pct)) value.append(element("span", "hm-tip-p"));
      const status = chart.totalStatus?.[index];
      const marked = Boolean(status) && hatched;
      const name = element("span", marked ? "hm-tip-n" : "", marked ? "" : "Total");
      if (marked) name.append(element("i", "hm-tip-hatch"), "Total");
      row.append(name, value);
      tip.append(row);
      if (status) tip.append(element("div", "hm-tip-s hm-tip-ts", status));
    }
    tip.style.display = "flex";
    return tip;
  };

  const place = (svg: SVGSVGElement, x: number, y: number) => {
    if (!tip) return;
    const box = svg.getBoundingClientRect();
    const frame = figure.getBoundingClientRect();
    const px = box.left - frame.left + (x * box.width) / svg.viewBox.baseVal.width;
    const py = box.top - frame.top + (y * box.height) / svg.viewBox.baseVal.height;
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left = px + 14;
    if (left + width > frame.width) left = px - 14 - width;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, Math.min(frame.height - height, py))}px`;
  };

  const placeKpi = (svg: SVGSVGElement, x: number) => {
    if (!tip) return;
    const box = svg.getBoundingClientRect();
    const px = box.left + (x * box.width) / svg.viewBox.baseVal.width;
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const right = innerWidth - 4;
    const bottom = innerHeight - 4;
    const note = (figure.querySelector(".hm-kpi-note") ?? svg).getBoundingClientRect().bottom + 4;
    let left = Math.max(4, Math.min(right - width, px - width / 2));
    let top = box.bottom + 8;
    if (top + height > bottom) {
      const side = px + 14 + width <= right ? px + 14 : px - 14 - width;
      if (note + height <= bottom && side >= 4) {
        left = side;
        top = note;
      } else top = figure.getBoundingClientRect().top - height - 8;
    }
    tip.style.left = tip.style.top = "0";
    const origin = tip.getBoundingClientRect();
    tip.style.left = `${left - origin.left}px`;
    tip.style.top = `${top - origin.top}px`;
  };

  const show = (svg: SVGSVGElement, index: number) => {
    if (current?.svg === svg && current.index === index) return;
    overlay?.remove();
    current = { svg, index };
    const [left = 0, top = 0, right = 0, bottom = 0] = numbers(svg, "plot");
    if (chart.kind === "scatter") {
      const [cx = 0, cy = 0, radius = 0] = scatterPoints(svg)[index] ?? [];
      overlay = svgElement("g", { class: "hm-hover", "pointer-events": "none" });
      for (const [grow, width, color] of [
        [2, 3, "card"],
        [4, 2, "c1"],
      ] as const) {
        overlay.append(
          svgElement("circle", {
            cx,
            cy,
            r: radius + grow,
            fill: "none",
            "stroke-width": width,
            "vector-effect": "non-scaling-stroke",
            class: `hm-ring hm-s-${color}`,
          }),
        );
      }
      svg.append(overlay);
      tooltip(index);
      place(svg, cx + radius, cy - radius);
      return;
    }
    if (chart.kind === "line") {
      const [x0, step] = span(svg, "x", n - 1);
      const [d0 = 0, d1 = 1, r0 = 0, r1 = 0] = numbers(svg, "y");
      const x = x0 + index * step;
      const y = (v: number) => r0 + ((v / 2 - d0 / 2) / (d1 / 2 - d0 / 2)) * (r1 - r0);
      overlay = svgElement("g", { class: "hm-hover", "pointer-events": "none" });
      overlay.append(
        svgElement("line", {
          x1: x,
          x2: x,
          y1: top,
          y2: bottom,
          class: "hm-s-borderStrong",
          "vector-effect": "non-scaling-stroke",
        }),
      );
      let highest = bottom;
      chart.series.forEach((s) => {
        const v = (s.y ?? s.v)[index];
        if (v === null || v === undefined) return;
        highest = Math.min(highest, y(v));
        for (const [width, color] of [
          [9, "card"],
          [5, `c${s.color}`],
        ]) {
          overlay?.append(
            svgElement("line", {
              x1: x,
              x2: x,
              y1: y(v),
              y2: y(v),
              "stroke-width": width as number,
              "stroke-linecap": "round",
              "vector-effect": "non-scaling-stroke",
              class: `hm-dot hm-s-${color}`,
            }),
          );
        }
      });
      svg.append(overlay);
      if (svg.hasAttribute("data-hm-readout")) {
        fillReadout(svg, index);
        return;
      }
      tooltip(index);
      if (kpi) placeKpi(svg, x);
      else place(svg, x, highest + 12);
      return;
    }
    if (chart.kind === "pie") {
      const [cx = 0, cy = 0, inner = 0, outer = 0] = numbers(svg, "pie");
      const cuts = chart.cuts ?? [];
      const middle = ((index === 0 ? 0 : (cuts[index - 1] ?? 0)) + (cuts[index] ?? 0)) / 2;
      const radius = (inner + outer) / 2;
      const angle = middle * 2 * Math.PI;
      svg.classList.add("hm-dim");
      svg.querySelectorAll(".hm-slice").forEach((slice, k) => {
        slice.classList.toggle("hm-on", k === index);
      });
      tooltip(index);
      place(svg, cx + radius * Math.sin(angle), cy - radius * Math.cos(angle));
      return;
    }
    const [start, step] = span(svg, "band", n);
    const vertical = svg.getAttribute("data-hm-o") === "v";
    const from = start + index * step;
    overlay = svgElement("rect", {
      x: vertical ? from : left,
      y: vertical ? top : from,
      width: vertical ? step : right - left,
      height: vertical ? bottom - top : step,
      class: "hm-f-text",
      "fill-opacity": 0.05,
      "pointer-events": "none",
    });
    svg.insertBefore(overlay, svg.firstChild);
    tooltip(index);
    if (vertical) place(svg, from + step, top);
    else place(svg, Math.min(right, (left + right) / 2), from + step);
  };

  const pick = (svg: SVGSVGElement, event: PointerEvent): number => {
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) * svg.viewBox.baseVal.width) / box.width;
    const y = ((event.clientY - box.top) * svg.viewBox.baseVal.height) / box.height;
    if (chart.kind === "scatter") {
      const reach = (SCATTER_PICK * svg.viewBox.baseVal.width) / box.width;
      const points = scatterPoints(svg);
      let best = -1;
      let smallest = Number.POSITIVE_INFINITY;
      let top = Number.NEGATIVE_INFINITY;
      points.forEach(([cx = 0, cy = 0, radius = 0, z], i) => {
        if (Math.hypot(x - cx, y - cy) > radius) return;
        const drawn = z ?? i;
        if (radius < smallest || (radius === smallest && drawn > top)) {
          smallest = radius;
          top = drawn;
          best = i;
        }
      });
      if (best >= 0) return best;
      let nearest = Number.POSITIVE_INFINITY;
      points.forEach(([cx = 0, cy = 0, radius = 0], i) => {
        const distance = Math.hypot(x - cx, y - cy) - radius;
        if (distance <= reach && distance < nearest) {
          nearest = distance;
          best = i;
        }
      });
      return best;
    }
    if (chart.kind === "line") {
      const [x0, step] = span(svg, "x", n - 1);
      return n > 1 ? Math.max(0, Math.min(n - 1, Math.round((x - x0) / step))) : 0;
    }
    if (chart.kind === "pie") {
      const [cx = 0, cy = 0, inner = 0, outer = 0] = numbers(svg, "pie");
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < inner - 2 || distance > outer + 4) return -1;
      const turn = (Math.atan2(x - cx, cy - y) / (2 * Math.PI) + 1) % 1;
      const index = (chart.cuts ?? []).findIndex((cut) => turn < cut);
      return index < 0 ? n - 1 : index;
    }
    const [start, step] = span(svg, "band", n);
    const pos = svg.getAttribute("data-hm-o") === "v" ? x : y;
    const index = Math.floor((pos - start) / step);
    return index >= 0 && index < n ? index : -1;
  };

  const onPointer = (event: PointerEvent) => {
    if (event.type === "pointerleave" || event.type === "pointercancel") {
      if (event.pointerType !== "touch") hide();
      return;
    }
    const svg = (event.target as Element).closest?.("svg[data-hm-kind]") as SVGSVGElement | null;
    if (!svg) return hide();
    const index = pick(svg, event);
    if (index < 0) hide();
    else show(svg, index);
  };
  for (const type of ["pointermove", "pointerdown", "pointerleave", "pointercancel"]) {
    figure.addEventListener(type, onPointer as EventListener);
  }

  figure.addEventListener("keydown", (event) => {
    const svg = (event.target as Element).closest?.("svg[data-hm-kind]") as SVGSVGElement | null;
    if (!svg || n === 0) return;
    const at = current?.svg === svg ? current.index : -1;
    const moves: Record<string, number> = {
      ArrowRight: at < 0 ? 0 : at + 1,
      ArrowDown: at < 0 ? 0 : at + 1,
      ArrowLeft: at < 0 ? n - 1 : at - 1,
      ArrowUp: at < 0 ? n - 1 : at - 1,
      Home: 0,
      End: n - 1,
    };
    if (event.key === "Escape") return hide();
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(n - 1, next));
    show(svg, index);
    live.textContent = [
      chart.headers[index],
      ...(chart.status?.[index] ? [chart.status[index]] : []),
      ...chart.series.map(
        (s) => `${s.name ?? s.label} ${s.text[index]}${s.pct ? `, ${s.pct[index]}` : ""}`,
      ),
      ...(chart.total
        ? [
            `Total ${chart.total[index]}${chart.totalStatus?.[index] ? `, ${chart.totalStatus[index]}` : ""}`,
          ]
        : []),
    ].join(", ");
  });
  figure.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", (event) => {
    if (current && !figure.contains(event.target as Node)) hide();
  });
}

function selectGrain(card: Element, key: string): boolean {
  const buttons = [...card.querySelectorAll<HTMLButtonElement>(".hm-seg button")];
  if (!buttons.some((b) => b.dataset.hmGrain === key)) return false;
  for (const node of card.querySelectorAll<HTMLElement>("[data-hm-grain]:not(button)")) {
    node.hidden = node.dataset.hmGrain !== key;
  }
  checkButton(buttons, key);
  return true;
}

function checkButton(buttons: HTMLButtonElement[], key: string): void {
  for (const b of buttons) {
    const on = b.dataset.hmGrain === key;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function segmented(group: HTMLElement, choose: (key: string) => void): void {
  const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
  group.addEventListener("click", (event) => {
    const key = (event.target as Element).closest("button")?.dataset.hmGrain;
    if (key !== undefined) choose(key);
  });
  group.addEventListener("keydown", (event) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
    const next = buttons[(at + step + buttons.length) % buttons.length];
    if (next?.dataset.hmGrain === undefined) return;
    choose(next.dataset.hmGrain);
    next.focus();
  });
}

const grains: { page?: string; cards: Map<string, string> } = { cards: new Map() };
const cardKey = (card: Element) => card.getAttribute("aria-labelledby") ?? "";

function mount(root: ParentNode): void {
  const all = (selector: string): HTMLElement[] => [
    ...(root instanceof HTMLElement && root.matches(selector) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(selector),
  ];
  for (const card of all("[data-hm-grains]")) {
    if (grains.page !== undefined) selectGrain(card, grains.page);
    const own = grains.cards.get(cardKey(card));
    if (own !== undefined) selectGrain(card, own);
    const group = card.querySelector<HTMLElement>(".hm-seg");
    if (group) {
      segmented(group, (key) => {
        if (selectGrain(card, key)) grains.cards.set(cardKey(card), key);
      });
    }
  }
  for (const figure of all("[data-hm-chart]")) {
    const source = figure.querySelector(":scope > script[type='application/json']");
    if (source?.textContent) attach(figure, JSON.parse(source.textContent) as RuntimeChart);
  }
  for (const card of all("section.hm-table")) wireTable(card);
  for (const wrap of all(".hm-table-wrap")) {
    wrap.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 40 : event.key === "ArrowLeft" ? -40 : 0;
      if (step === 0) return;
      event.preventDefault();
      wrap.scrollLeft += step;
    });
  }
}

function redraw(view: PeriodView): void {
  const grid = document.querySelector<HTMLElement>("main.hm-grid");
  if (!grid) return;
  grid.innerHTML = view.blocks;
  mount(grid);
  const caption = document.querySelector("[data-hm-caption]");
  if (caption) caption.textContent = view.caption;
  const note = document.querySelector<HTMLElement>("[data-hm-period-note]");
  if (note) {
    const names = view.presetOnly;
    note.textContent =
      names.length === 0
        ? ""
        : `${names.join(", ")} ${names.length === 1 ? "needs" : "need"} a preset: a custom range adds up daily totals, which distinct counts and medians cannot be built from.`;
    note.hidden = names.length === 0;
  }
}

function start(): void {
  const cards = () => [...document.querySelectorAll<HTMLElement>("[data-hm-grains]")];
  const params = new URLSearchParams(location.search);
  for (const group of document.querySelectorAll<HTMLElement>("[data-hm-grain-filter]")) {
    const id = group.dataset.hmGrainFilter ?? "grain";
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
    const initial = buttons.find((b) => b.getAttribute("aria-checked") === "true")?.dataset.hmGrain;
    const choose = (key: string) => {
      if (!buttons.some((b) => b.dataset.hmGrain === key)) return;
      checkButton(buttons, key);
      grains.page = key;
      grains.cards.clear();
      for (const card of cards()) selectGrain(card, key);
      writeParam(id, key === initial ? undefined : key);
    };
    segmented(group, choose);
    const requested = params.get(id);
    if (requested !== null) {
      if (buttons.some((b) => b.dataset.hmGrain === requested)) choose(requested);
      else writeParam(id, undefined);
    }
  }
  mount(document);
  for (const root of document.querySelectorAll<HTMLElement>("[data-hm-period]")) {
    refreshers.push(mountPeriod(root, redraw));
  }
  for (const group of document.querySelectorAll<HTMLElement>("[data-hm-segment-filter]")) {
    mountSegments(group, params);
  }
}

function mountSegments(group: HTMLElement, params: URLSearchParams): void {
  const id = group.dataset.hmSegmentFilter ?? "segments";
  const buttons = [...group.querySelectorAll<HTMLButtonElement>("[data-hm-segment]")];
  const script = document.querySelector<HTMLElement>("script[data-hm-segments]");
  const payload = script?.textContent;
  if (!script || !payload || buttons.length === 0) return;
  const states: Record<string, { data: unknown; periods?: unknown }> = JSON.parse(payload).states;
  const key = () =>
    buttons
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.dataset.hmSegment)
      .join(",");
  const initial = key();
  const periods = document.querySelector("script[data-hm-periods]");
  const ranges: Record<string, string> = JSON.parse(
    document.querySelector("script[data-hm-ranges]")?.textContent ?? "{}",
  );
  const live = document.createElement("p");
  live.className = "hm-sr";
  live.setAttribute("aria-live", "polite");
  group.append(live);
  const show = async (announce: boolean) => {
    const chosen = key();
    const state = states[chosen];
    if (state === undefined) return;
    writeParam(id, chosen === initial ? undefined : chosen === "" ? "none" : chosen);
    if (periods && state.periods !== undefined) {
      periods.textContent = JSON.stringify(state.periods);
      for (const again of refreshers) again(true);
    } else {
      const src = script.dataset.hmEngine;
      if (!src) return;
      const grid = document.querySelector<HTMLElement>("main.hm-grid");
      grid?.setAttribute("aria-busy", "true");
      try {
        const view = (await loadEngine(src)).render(state.data, ranges);
        redraw({ key: chosen, name: "", nameIsDates: false, presetOnly: [], ...view });
      } finally {
        grid?.removeAttribute("aria-busy");
      }
    }
    if (announce) {
      const on = buttons.filter((b) => b.getAttribute("aria-pressed") === "true");
      live.textContent =
        on.length === 0
          ? "Showing all rows"
          : `Showing ${on.map((b) => b.textContent).join(" and ")}`;
    }
  };
  for (const button of buttons) {
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
      void show(true);
    });
  }
  const requested = params.get(id);
  if (requested === null) return;
  const names = requested === "none" ? [] : requested.split(",");
  if (!names.every((n) => buttons.some((b) => b.dataset.hmSegment === n))) {
    writeParam(id, undefined);
    return;
  }
  for (const b of buttons)
    b.setAttribute("aria-pressed", String(names.includes(b.dataset.hmSegment ?? "")));
  if (key() !== initial) void show(false);
}

const refreshers: ((force?: boolean) => void)[] = [];

function refresh(): void {
  for (const again of refreshers) again();
}

declare global {
  interface Window {
    hatchmark?: { mount(root: ParentNode): void; refresh(): void };
  }
}

window.hatchmark = { mount, refresh };
start();
