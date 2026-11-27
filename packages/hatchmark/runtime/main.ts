/**
 * The Hatchmark browser runtime: tooltips, the line crosshair (KPI sparklines included) and the bar
 * highlight, plus keyboard stepping through points. A KPI tooltip is position:fixed, so the strip's
 * overflow does not clip it, and floats below the sparkline (beside the point near the viewport
 * bottom) so it never covers the figure. .hm-root's container-type makes it the containing block,
 * so the runtime measures the tooltip's origin instead of assuming the viewport. Charts are already drawn on the server, so this
 * only reads the chart geometry from data-hm-* attributes and the formatted values from the JSON each
 * chart's figure carries. One pointer listener per chart, no dependencies.
 */

interface RuntimeSeries {
  label: string;
  color: number;
  v: (number | null)[];
  text: string[];
  short: string[];
  y?: (number | null)[];
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
      row.append(name, element("span", "hm-tip-v", s.text[index] ?? ""));
      tip.append(row);
    }
    if (chart.total) {
      const row = element("div", "hm-tip-r hm-tip-t");
      row.append(
        element("span", "", "Total"),
        element("span", "hm-tip-v", chart.total[index] ?? ""),
      );
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
    let left = Math.max(4, Math.min(innerWidth - width - 4, px - width / 2));
    let top = box.bottom + 8;
    if (top + height > innerHeight) {
      const note = figure.querySelector(".hm-kpi-note")?.getBoundingClientRect().bottom ?? box.top;
      left = px + 14 + width <= innerWidth ? px + 14 : px - 14 - width;
      top = Math.min(note + 4, innerHeight - height - 4);
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
      const [x0 = 0, step = 0] = numbers(svg, "x");
      const [d0 = 0, d1 = 1, r0 = 0, r1 = 0] = numbers(svg, "y");
      const x = n > 1 ? x0 + index * step : x0;
      const y = (v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
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
    const [start = 0, step = 0] = numbers(svg, "band");
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
      const [x0 = 0, step = 0] = numbers(svg, "x");
      return n > 1 ? Math.max(0, Math.min(n - 1, Math.round((x - x0) / step))) : 0;
    }
    const [start = 0, step = 1] = numbers(svg, "band");
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
    show(svg, Math.max(0, Math.min(n - 1, next)));
  });
  figure.addEventListener("focusout", hide);
}

function start(): void {
  for (const figure of document.querySelectorAll<HTMLElement>("[data-hm-chart]")) {
    const source = figure.querySelector(":scope > script[type='application/json']");
    if (source?.textContent) attach(figure, JSON.parse(source.textContent) as RuntimeChart);
  }
}

start();
