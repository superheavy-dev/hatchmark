/**
 * Table behaviour: header buttons sort the rows, and the card's Download CSV button saves the rows
 * as shown. The server renders every cell's raw value in data-v, so sorting compares numbers and
 * the CSV holds full-precision values, never formatted text. Subtotal rows move with their groups,
 * groups sort among themselves by their subtotal, and an Other row stays last in its group; the
 * total row stays in the footer.
 */

interface RowNode {
  row: HTMLTableRowElement | undefined;
  index: number;
  children: RowNode[];
}

const value = (cell: Element | undefined | null): string => cell?.getAttribute("data-v") ?? "";

/** Two key cells hold the same group: equal raw value and equal kind (the number 1000 is not the text "1000"). */
const sameKey = (a: Element | undefined | null, b: Element | undefined | null): boolean =>
  value(a) === value(b) && a?.getAttribute("data-t") === b?.getAttribute("data-t");

/** The tbody rows as a tree: each subtotal row owns the rows after it, down to the next group. */
function rowTree(rows: HTMLTableRowElement[]): RowNode {
  const root: RowNode = { row: undefined, index: -1, children: [] };
  const stack: RowNode[] = [root];
  rows.forEach((row, index) => {
    const node: RowNode = { row, index, children: [] };
    if (row.dataset.hmKind === "subtotal") {
      const level = Math.max(1, Number(row.dataset.hmLevel) || 1);
      stack.length = Math.min(stack.length, level);
      (stack[stack.length - 1] ?? root).children.push(node);
      stack.push(node);
      return;
    }
    (stack[stack.length - 1] ?? root).children.push(node);
  });
  return root;
}

/** Sorts the rows by one column in place: empty values last, ties in their previous order. */
export function sortRows(
  table: HTMLTableElement,
  column: number,
  order: "asc" | "desc",
  numeric: boolean,
): void {
  const body = table.tBodies[0];
  if (!body) return;
  const collator = new Intl.Collator(undefined, { numeric: true });
  const compare = (a: RowNode, b: RowNode): number => {
    const ao = a.row?.dataset.hmKind === "other";
    const bo = b.row?.dataset.hmKind === "other";
    if (ao !== bo) return ao ? 1 : -1;
    const va = value(a.row?.cells[column]);
    const vb = value(b.row?.cells[column]);
    if (va === "" || vb === "") return va === vb ? a.index - b.index : va === "" ? 1 : -1;
    const cells = [a.row?.cells[column], b.row?.cells[column]];
    const byNumber = numeric || cells.every((cell) => cell?.getAttribute("data-t") === "n");
    const c = byNumber ? Number(va) - Number(vb) : collator.compare(va, vb);
    return (order === "asc" ? c : -c) || a.index - b.index;
  };
  const ordered: HTMLTableRowElement[] = [];
  const walk = (node: RowNode) => {
    for (const child of [...node.children].sort(compare)) {
      if (child.row) ordered.push(child.row);
      walk(child);
    }
  };
  walk(rowTree([...body.rows]));
  for (const row of ordered) body.append(row);
  groupRepeats(table);
}

/**
 * Hides an outer key from sight when the row above has the same outer keys, as the server does;
 * subtotal tables name their groups in the subtotal rows, so their rows keep outer keys hidden.
 */
function groupRepeats(table: HTMLTableElement): void {
  const body = table.tBodies[0];
  if (!body || body.querySelector("[data-hm-kind=subtotal]")) return;
  const width = table.tHead?.querySelectorAll("th.hm-key").length ?? 0;
  let previous: HTMLTableRowElement | undefined;
  for (const row of body.rows) {
    if (row.dataset.hmKind !== "row") {
      previous = undefined;
      continue;
    }
    for (let i = 0; i < width - 1; i++) {
      const same =
        previous !== undefined &&
        Array.from({ length: i + 1 }, (_, j) => j).every((j) =>
          sameKey(previous?.cells[j], row.cells[j]),
        );
      const cell = row.cells[i];
      const span = cell?.querySelector("span");
      if (!cell || !span) continue;
      span.classList.toggle("hm-sr", same);
      if (same) cell.removeAttribute("title");
      else cell.setAttribute("title", span.textContent ?? "");
    }
    previous = row;
  }
}

/** One CSV field: quoted when needed, and a text cell that a spreadsheet would run as a formula is prefixed with '. */
function field(text: string, isText: boolean): string {
  const safe = isText && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The table as CSV (RFC 4180, CRLF): header, rows in their current order, then the total row. */
export function tableCsv(table: HTMLTableElement): string {
  const lines: string[] = [];
  const line = (cells: Iterable<HTMLTableCellElement>, header: boolean) => {
    const out: string[] = [];
    for (const cell of cells) {
      const text = header
        ? (cell.dataset.csv ?? cell.textContent ?? "").trim()
        : (cell.getAttribute("data-v") ?? "");
      const key = cell.classList.contains("hm-key") && cell.getAttribute("data-t") !== "n";
      out.push(field(text, header || key));
      for (let i = 1; i < cell.colSpan; i++) out.push("");
    }
    lines.push(out.join(","));
  };
  for (const row of table.tHead?.rows ?? []) line(row.cells, true);
  for (const body of table.tBodies) for (const row of body.rows) line(row.cells, false);
  for (const row of table.tFoot?.rows ?? []) line(row.cells, false);
  return `${lines.join("\r\n")}\r\n`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Scrolls a focused header button out from under the pinned key column, which the browser's own
 * focus scrolling does not know about. The pinned column is the first one, or on a narrow screen
 * the innermost key column of a grouped table: whichever header cells stick to the left edge.
 */
function revealFocus(wrap: HTMLElement, table: HTMLTableElement): void {
  wrap.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement;
    const pinned = [...(table.tHead?.rows[0]?.cells ?? [])].filter(
      (cell) => getComputedStyle(cell).left !== "auto",
    );
    if (target === wrap || pinned.length === 0 || pinned.some((cell) => cell.contains(target)))
      return;
    const edge = Math.max(...pinned.map((cell) => cell.getBoundingClientRect().right));
    const covered = edge - target.getBoundingClientRect().left;
    if (covered > 0) wrap.scrollLeft -= covered + 8;
  });
}

/**
 * A tall table in page mode (overflow "page", the default alone in its grid row) grows with the page
 * instead of scrolling inside its card, so its header row follows the viewport top and its total row
 * the viewport bottom while the table is on screen. CSS sticky cannot do this, because the card
 * scrolls sideways on a phone and so becomes the sticky container.
 */
function pinToViewport(table: HTMLTableElement): void {
  const head = [...(table.tHead?.rows[0]?.cells ?? [])];
  const foot = [...(table.tFoot?.rows[0]?.cells ?? [])];
  let queued = false;
  const update = () => {
    queued = false;
    const box = table.getBoundingClientRect();
    const room = Math.max(
      0,
      box.height -
        (table.tHead?.getBoundingClientRect().height ?? 0) -
        (table.tFoot?.getBoundingClientRect().height ?? 0),
    );
    const down = Math.min(room, Math.max(0, -box.top));
    const up = Math.min(room, Math.max(0, box.bottom - window.innerHeight));
    for (const cell of head) cell.style.transform = down > 0 ? `translateY(${down}px)` : "";
    for (const cell of foot) cell.style.transform = up > 0 ? `translateY(${-up}px)` : "";
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  addEventListener("scroll", queue, { passive: true, capture: true });
  addEventListener("resize", queue);
  update();
}

/** Wires one table card: sortable headers, a polite announcement, and the CSV button. */
export function wireTable(card: HTMLElement): void {
  const table = card.querySelector<HTMLTableElement>("table.hm-table");
  if (!table) return;
  const wrap = table.closest<HTMLElement>(".hm-table-wrap");
  if (wrap) revealFocus(wrap, table);
  if (wrap?.classList.contains("hm-grow")) pinToViewport(table);
  const live = document.createElement("div");
  live.className = "hm-sr";
  live.setAttribute("aria-live", "polite");
  card.append(live);
  const marks = [...table.querySelectorAll<HTMLButtonElement>("button.hm-win")];
  const close = () => {
    for (const mark of marks) mark.parentElement?.classList.remove("hm-open");
  };
  const place = (box: HTMLElement) => {
    const tip = box.querySelector<HTMLElement>(".hm-win-tip");
    if (!tip || !wrap) return;
    const clip = wrap.getBoundingClientRect();
    const left = Math.max(clip.left, 0) + 4;
    const right = Math.min(clip.right, window.innerWidth) - 4;
    tip.style.translate = "";
    tip.style.maxWidth = `${Math.max(120, Math.min(260, right - left))}px`;
    const rect = tip.getBoundingClientRect();
    const shift = rect.left < left ? left - rect.left : rect.right > right ? right - rect.right : 0;
    if (shift !== 0) tip.style.translate = `${shift}px 0`;
  };
  for (const mark of marks) {
    const box = mark.parentElement;
    if (!box) continue;
    const show = () => {
      place(box);
      requestAnimationFrame(() => place(box));
    };
    mark.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = !box.classList.contains("hm-open");
      close();
      box.classList.remove("hm-shut");
      box.classList.toggle("hm-open", open);
      show();
    });
    mark.addEventListener("mousemove", () => box.classList.remove("hm-shut"));
    box.addEventListener("mouseenter", show);
    box.addEventListener("mouseleave", () => box.classList.remove("hm-shut"));
    mark.addEventListener("focus", show);
    mark.addEventListener("blur", () => {
      box.classList.remove("hm-shut");
      box.classList.remove("hm-open");
    });
  }
  if (marks.length > 0) {
    wrap?.addEventListener("scroll", () => {
      for (const mark of marks) if (mark.parentElement) place(mark.parentElement);
    });
    document.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      close();
      for (const mark of marks) mark.parentElement?.classList.add("hm-shut");
    });
  }
  const headers = [...(table.tHead?.querySelectorAll<HTMLTableCellElement>("th") ?? [])];
  for (const th of headers) {
    const button = th.querySelector<HTMLButtonElement>("button.hm-sort");
    button?.addEventListener("click", () => {
      const numeric = th.dataset.hmNum === "1";
      const state = th.getAttribute("aria-sort");
      const order =
        state === "descending" ? "asc" : state === "ascending" ? "desc" : numeric ? "desc" : "asc";
      sortRows(table, th.cellIndex, order, numeric);
      for (const other of headers) other.setAttribute("aria-sort", "none");
      th.setAttribute("aria-sort", order === "asc" ? "ascending" : "descending");
      live.textContent = `Sorted by ${button.textContent?.trim() ?? ""}, ${order === "asc" ? "ascending" : "descending"}`;
    });
  }
  const csv = card.querySelector<HTMLButtonElement>("button[data-hm-csv]");
  if (csv) {
    csv.hidden = false;
    csv.addEventListener("click", () =>
      download(`${csv.dataset.hmCsv ?? "table"}.csv`, tableCsv(table)),
    );
  }
}
