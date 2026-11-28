/**
 * Map hover: a region on the map, its leader label and its row in the bar list highlight together,
 * whichever one the pointer is on, and a tooltip names the region with its value, rank and share.
 * The focused map steps through the regions by rank with the arrow keys, announced through a
 * polite live region. Everything else is drawn by the server.
 */

interface RuntimeMap {
  label: string;
  none: string;
  regions: Record<string, { n: string; v?: string; k?: string; s?: string }>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function attachMap(figure: HTMLElement): void {
  const source = figure.querySelector(":scope > script[type='application/json']");
  if (!source?.textContent) return;
  const data = JSON.parse(source.textContent) as RuntimeMap;
  const list = figure.querySelector<HTMLElement>(".hm-map-list");
  const rows = new Map(
    [...(list?.querySelectorAll<HTMLElement>("li[data-hm-r]") ?? [])].map((li) => [
      li.getAttribute("data-hm-r") ?? "",
      li,
    ]),
  );
  const order = [...rows.keys()];
  const live = div("hm-sr");
  live.setAttribute("aria-live", "polite");
  figure.append(live);
  let tip: HTMLDivElement | undefined;
  let current: string | undefined;

  const outline = (svg: SVGSVGElement, id: string | undefined) => {
    const layer = svg.querySelector(".hm-hover");
    if (!layer) return;
    layer.replaceChildren();
    if (id === undefined) return;
    const shape = svg.querySelector(`.hm-regions [data-hm-r="${CSS.escape(id)}"]`);
    const d = shape?.getAttribute("d");
    if (!d) return;
    for (const [className, width] of [
      ["hm-halo", 3.5],
      ["hm-outline", 1.5],
    ] as const) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", className);
      path.setAttribute("stroke-width", String(width));
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.setAttribute("stroke-linejoin", "round");
      layer.append(path);
    }
  };

  const tooltip = (id: string): HTMLDivElement => {
    const region = data.regions[id];
    tip ??= figure.appendChild(div("hm-tip"));
    tip.setAttribute("aria-hidden", "true");
    tip.replaceChildren(div("hm-tip-h", region?.n ?? id));
    const row = div("hm-tip-r");
    const label = document.createElement("span");
    label.className = "hm-tip-n";
    label.textContent = data.label;
    const value = document.createElement("span");
    value.className = "hm-tip-v";
    value.textContent = region?.v ?? data.none;
    row.append(label, value);
    tip.append(row);
    for (const extra of [region?.k, region?.s])
      if (extra) tip.append(div("hm-tip-s hm-tip-k", extra));
    tip.style.display = "flex";
    return tip;
  };

  const place = (x: number, y: number) => {
    if (!tip) return;
    const frame = figure.getBoundingClientRect();
    const px = x - frame.left;
    const py = y - frame.top;
    let left = px + 14;
    if (left + tip.offsetWidth > frame.width) left = px - 14 - tip.offsetWidth;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, Math.min(frame.height - tip.offsetHeight, py + 14))}px`;
  };

  const select = (id: string | undefined, scroll: boolean) => {
    if (id === current) return;
    if (current !== undefined) rows.get(current)?.classList.remove("hm-on");
    current = id;
    for (const svg of figure.querySelectorAll<SVGSVGElement>("svg[data-hm-kind=map]"))
      outline(svg, id);
    if (id === undefined) {
      if (tip) tip.style.display = "none";
      return;
    }
    const row = rows.get(id);
    row?.classList.add("hm-on");
    if (scroll && row && list) {
      const top = row.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = top + row.offsetHeight - list.clientHeight;
    }
  };

  const target = (event: Event) =>
    (event.target as Element | null)?.closest<Element>("[data-hm-r]")?.getAttribute("data-hm-r") ??
    undefined;

  const plot = figure.querySelector<HTMLElement>(".hm-map-frame");
  plot?.addEventListener("pointermove", (event) => {
    const id = target(event);
    select(id, true);
    if (id === undefined) return;
    tooltip(id);
    place(event.clientX, event.clientY);
  });
  plot?.addEventListener("pointerleave", () => select(undefined, false));
  for (const svg of figure.querySelectorAll<SVGSVGElement>("svg[data-hm-kind=map]")) {
    svg.setAttribute("tabindex", "0");
    svg.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        select(undefined, false);
        return;
      }
      const step =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (step === 0 || order.length === 0) return;
      event.preventDefault();
      const at = current === undefined ? (step > 0 ? -1 : order.length) : order.indexOf(current);
      const id = order[Math.max(0, Math.min(order.length - 1, at + step))] as string;
      select(id, true);
      const shape = svg.querySelector(`.hm-regions [data-hm-r="${CSS.escape(id)}"]`);
      const box = shape?.getBoundingClientRect();
      tooltip(id);
      if (box) place(box.left + box.width / 2, box.top + box.height / 2);
      const region = data.regions[id];
      live.textContent = [region?.n, region?.v, region?.k, region?.s].filter(Boolean).join(", ");
    });
    svg.addEventListener("blur", () => select(undefined, false));
  }
  list?.addEventListener("pointermove", (event) => {
    const id = target(event);
    select(id, false);
    if (id === undefined) return;
    tooltip(id);
    place(event.clientX, event.clientY);
  });
  list?.addEventListener("pointerleave", () => select(undefined, false));
}
