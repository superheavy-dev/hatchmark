/**
 * The Hatchmark browser runtime: tooltips, the line crosshair (KPI sparklines included) and the bar
 * highlight, plus keyboard stepping through points, announced through a polite live region. Charts
 * are already drawn on the server, so this only reads the chart geometry from data-hm-* attributes
 * and the formatted values from the JSON each chart's figure carries. One pointer listener per
 * chart, no dependencies. Arrow keys scroll a focused, clipped table sideways, which WebKit does
 * not do on its own. Grain switches show one grain's prebuilt heading and chart and hide the others;
 * the dashboard's grain filter switches every card that lists the chosen grain.
 *
 * A KPI tooltip is position:fixed, so the strip's overflow does not clip it. It floats below the
 * sparkline; near the viewport bottom it goes beside the point, or above the card, so it never
 * covers the figure. .hm-root's container-type makes it the containing block, so the runtime
 * measures the tooltip's origin instead of assuming the viewport.
 */

interface RuntimeSeries {
  label: string;
  color: number;
  v: (number | null)[];
  text: string[];
  short: string[];
  y?: (number | null)[];
  pct?: string[];
}

interface RuntimeChart {
  kind: "line" | "bar";
  headers: string[];
  series: RuntimeSeries[];
  total?: string[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

const numbers = (svg: Element, name: string): number[] =>
  (svg.getAttribute(`data-hm-${name}`) ?? "").split(",").map(Number);

/** A start and end attribute pair as start and step, so rounding never accumulates over buckets. */
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
    if (head) head.textContent = chart.headers[index] ?? "";
    chart.series.forEach((s, k) => {
      const value = svg.querySelector(`.hm-rv-${k}`);
      if (value) value.textContent = s.short[index] ?? "";
    });
  };

  const tooltip = (index: number): HTMLDivElement => {
    if (!tip) {
      tip = element("div", "hm-tip");
      tip.setAttribute("aria-hidden", "true");
      figure.append(tip);
    }
    tip.replaceChildren(element("div", "hm-tip-h", chart.headers[index] ?? ""));
    const rows = chart.series.map((s, k) => ({ s, k, v: s.v[index] ?? null }));
    if (rows.length > 1) {
      rows.sort(
        (a, b) =>
          (b.v ?? Number.NEGATIVE_INFINITY) - (a.v ?? Number.NEGATIVE_INFINITY) || a.k - b.k,
      );
    }
    for (const { s } of rows) {
      const row = element("div", "hm-tip-r");
      const name = element("span", "hm-tip-n");
      name.append(element("i", `hm-b-c${s.color}`), s.label);
      const value = element("span", "hm-tip-v", s.text[index] ?? "");
      if (s.pct) value.append(element("span", "hm-tip-p", s.pct[index] ?? ""));
      row.append(name, value);
      tip.append(row);
    }
    if (chart.total) {
      const row = element("div", "hm-tip-r hm-tip-t");
      const value = element("span", "hm-tip-v", chart.total[index] ?? "");
      if (chart.series.some((s) => s.pct)) value.append(element("span", "hm-tip-p"));
      row.append(element("span", "", "Total"), value);
      tip.append(row);
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
    if (chart.kind === "line") {
      const [x0, step] = span(svg, "x", n - 1);
      return n > 1 ? Math.max(0, Math.min(n - 1, Math.round((x - x0) / step))) : 0;
    }
    const [start, step] = span(svg, "band", n);
    const pos = svg.getAttribute("data-hm-o") === "v" ? x : y;
    const index = Math.floor((pos - start) / step);
    return index >= 0 && index < n ? index : -1;
  };

  const onPointer = (event: PointerEvent) => {
    if (event.type === "pointerleave" || event.type === "pointercancel") return hide();
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
      ...chart.series.map((s) => `${s.label} ${s.text[index]}${s.pct ? `, ${s.pct[index]}` : ""}`),
      ...(chart.total ? [`Total ${chart.total[index]}`] : []),
    ].join(", ");
  });
  figure.addEventListener("focusout", hide);
}

/** Shows one grain in a card that switches grains; false when the card does not list it. */
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

/** Radio-group behaviour for a segmented control: click, or arrow keys that move and select. */
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

/**
 * Attaches the runtime to everything in root, root included: the whole document on load, or one
 * card that hatchmark dev has just swapped in. The grain filter finds the cards when it is used, so
 * it also switches cards swapped in later.
 */
function mount(root: ParentNode): void {
  const all = (selector: string): HTMLElement[] => [
    ...(root instanceof HTMLElement && root.matches(selector) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(selector),
  ];
  for (const card of all("[data-hm-grains]")) {
    const group = card.querySelector<HTMLElement>(".hm-seg");
    if (group) segmented(group, (key) => selectGrain(card, key));
  }
  for (const group of all("[data-hm-grain-filter]")) {
    segmented(group, (key) => {
      checkButton([...group.querySelectorAll<HTMLButtonElement>("button")], key);
      for (const card of document.querySelectorAll("[data-hm-grains]")) selectGrain(card, key);
    });
  }
  for (const figure of all("[data-hm-chart]")) {
    const source = figure.querySelector(":scope > script[type='application/json']");
    if (source?.textContent) attach(figure, JSON.parse(source.textContent) as RuntimeChart);
  }
  for (const wrap of all(".hm-table-wrap")) {
    wrap.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 40 : event.key === "ArrowLeft" ? -40 : 0;
      if (step === 0) return;
      event.preventDefault();
      wrap.scrollLeft += step;
    });
  }
}

declare global {
  interface Window {
    /** The one hook hatchmark dev uses, to attach the runtime to a card it swapped in. */
    hatchmark?: { mount(root: ParentNode): void };
  }
}

window.hatchmark = { mount };
mount(document);
