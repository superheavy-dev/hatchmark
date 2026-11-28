import { formatRange, useRanges } from "../src/render/format.js";

export interface PeriodView {
  key: string;
  blocks: string;
  caption: string;
  name: string;
  dates?: string;
  nameIsDates: boolean;
  lang?: string;
  presetOnly: string[];
}

interface Engine {
  view(payload: unknown, key: string, ranges: Record<string, string>): PeriodView | undefined;
  render(data: unknown, ranges: Record<string, string>): { blocks: string; caption: string };
}

const DAY = 86_400_000;
const toDate = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => toDay(toDate(day) + n * DAY);
const RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

function addMonths(day: string, n: number): string {
  const d = new Date(toDate(day));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return toDay(target.getTime());
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

export function writeParam(name: string, value: string | undefined): void {
  try {
    const url = new URL(location.href);
    if (value === undefined) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
    history.replaceState(history.state, "", url);
  } catch {
    // file:// pages in some browsers refuse replaceState; the range still applies.
  }
}

let engine: Promise<Engine> | undefined;

export function loadEngine(src: string): Promise<Engine> {
  engine ??= new Promise<Engine>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      const found = (globalThis as { hatchmarkPeriods?: Engine }).hatchmarkPeriods;
      if (found) resolve(found);
      else reject(new Error("period engine did not load"));
    };
    script.onerror = () => {
      engine = undefined;
      reject(new Error("period engine did not load"));
    };
    document.head.append(script);
  });
  return engine;
}

export function mountPeriod(
  root: HTMLElement,
  redraw: (view: PeriodView) => void,
): (force?: boolean) => void {
  const filter = root.dataset.hmPeriod ?? "period";
  const locale = root.dataset.hmLocale ?? "en-US";
  const button = root.querySelector<HTMLButtonElement>(".hm-period-button");
  const panel = root.querySelector<HTMLElement>(".hm-period-panel");
  const presets = [...root.querySelectorAll<HTMLButtonElement>("[data-hm-preset]")];
  const cal = root.querySelector<HTMLElement>(".hm-cal");
  if (!button || !panel) return () => {};
  const ranges: Record<string, string> = JSON.parse(
    document.querySelector("script[data-hm-ranges]")?.textContent ?? "{}",
  );
  useRanges(ranges);
  const initial = presets.find((b) => b.getAttribute("aria-checked") === "true")?.dataset.hmPreset;
  const fallback = initial ?? presets[0]?.dataset.hmPreset ?? "";
  let shown = fallback;
  const live = document.createElement("p");
  live.className = "hm-sr";
  live.setAttribute("aria-live", "polite");
  root.append(live);

  const min = cal?.dataset.hmMin ?? "";
  const max = cal?.dataset.hmEnd ? addDays(cal.dataset.hmEnd, -1) : "";
  const weekStart = Number(cal?.dataset.hmWeek ?? 0);
  const months = cal?.querySelector<HTMLElement>(".hm-cal-months");
  const status = cal?.querySelector<HTMLElement>(".hm-cal-status");
  const apply = cal?.querySelector<HTMLButtonElement>("[data-hm-cal=apply]");
  const inputs = {
    start: cal?.querySelector<HTMLInputElement>("[data-hm-edge=start]"),
    end: cal?.querySelector<HTMLInputElement>("[data-hm-edge=end]"),
  };
  const state: {
    start: string | undefined;
    end: string | undefined;
    hover?: string;
    focus: string;
    view: string;
  } = {
    start: undefined,
    end: undefined,
    focus: max,
    view: monthStart(max),
  };
  const names = Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0 ? locale : "en-US";
  const fmt = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(names, { timeZone: "UTC", calendar: "gregory", ...options });
  const monthName = fmt({ month: "long", year: "numeric" });
  const weekdayName = fmt({ weekday: "short" });
  const weekdayLong = fmt({ weekday: "long" });
  const dayLabel = fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const short = fmt({ month: "short", day: "numeric", year: "numeric" });
  const pattern = cal?.dataset.hmPattern ?? "MM/DD/YYYY";
  const digits = [...(cal?.dataset.hmDigits ?? "0123456789")];
  const FIELD = { DD: "day", MM: "month", YYYY: "year" } as const;
  const order = (pattern.match(/DD|MM|YYYY/g) ?? []).map((t) => FIELD[t as keyof typeof FIELD]);
  const separators = new Set([..." ./-", ...pattern.replace(/DD|MM|YYYY/g, "")]);
  const shownDay = (day: string | undefined) =>
    day
      ? pattern
          .replace(/DD|MM|YYYY/g, (t) =>
            t === "YYYY" ? day.slice(0, 4) : t === "MM" ? day.slice(5, 7) : day.slice(8, 10),
          )
          .replace(/\d/g, (d) => digits[Number(d)] ?? d)
      : "";
  const typedDay = (text: string): string | undefined => {
    const plain = [...text.normalize("NFKC").trim()]
      .map((c) => (digits.includes(c) ? String(digits.indexOf(c)) : c))
      .join("");
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(plain);
    const groups = iso ? iso.slice(1) : (plain.match(/\d+/g) ?? []);
    const fields: readonly ("day" | "month" | "year")[] = iso ? ["year", "month", "day"] : order;
    if (groups.length !== 3 || fields.length !== 3) return undefined;
    if (!iso && [...plain.replace(/\d+/g, "")].some((c) => !separators.has(c))) return undefined;
    const field = (type: "day" | "month" | "year") => groups[fields.indexOf(type)] ?? "";
    const [year, month, day] = [field("year"), field("month"), field("day")];
    if (year.length !== 4 || month.length > 2 || day.length > 2) return undefined;
    const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
    return toDay(time) === value ? value : undefined;
  };
  const inside = (day: string) => day >= min && day <= max;
  const clamp = (day: string) => (day < min ? min : day > max ? max : day);

  const visibleMonths = () => {
    const second = months?.querySelectorAll(".hm-month")[1] as HTMLElement | undefined;
    return second && second.offsetParent === null ? 1 : 2;
  };

  const drawMonth = (first: string): string => {
    const date = new Date(toDate(first));
    const offset = (date.getUTCDay() + 6 - weekStart + 7) % 7;
    const head = Array.from({ length: 7 }, (_, i) => {
      const sample = toDate("2024-01-01") + ((weekStart + i) % 7) * DAY;
      return `<th scope="col" abbr="${weekdayLong.format(sample)}">${weekdayName.format(sample)}</th>`;
    }).join("");
    const cells: string[] = [];
    for (let i = 0; i < offset; i++) cells.push("<td></td>");
    const count = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const low = state.start;
    const high =
      state.end ??
      (state.start && state.hover && state.hover > state.start ? state.hover : undefined);
    for (let d = 1; d <= count; d++) {
      const day = `${first.slice(0, 8)}${String(d).padStart(2, "0")}`;
      const edge = day === state.start || day === state.end;
      const between = low !== undefined && high !== undefined && day > low && day < high;
      const notes = [day === state.start ? "first day" : "", day === state.end ? "last day" : ""]
        .filter(Boolean)
        .join(", ");
      cells.push(
        `<td${between ? ' class="hm-in"' : ""}><button type="button" tabindex="${day === state.focus ? 0 : -1}" data-day="${day}" aria-label="${dayLabel.format(toDate(day))}${notes ? `, ${notes}` : ""}"${edge ? ' aria-selected="true"' : ""}${inside(day) ? "" : ' aria-disabled="true"'}>${d}</button></td>`,
      );
    }
    while (cells.length % 7 !== 0) cells.push("<td></td>");
    const rows = [];
    for (let i = 0; i < cells.length; i += 7)
      rows.push(`<tr>${cells.slice(i, i + 7).join("")}</tr>`);
    const id = `hm-m-${filter}-${first.slice(0, 7)}`;
    return `<div class="hm-month"><p class="hm-month-name" id="${id}">${monthName.format(toDate(first))}</p><table class="hm-days" role="grid" aria-labelledby="${id}"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  };

  const drawCalendar = (focus = false, editing?: HTMLInputElement) => {
    if (!months) return;
    const had =
      document.activeElement instanceof HTMLElement && months.contains(document.activeElement)
        ? document.activeElement
        : undefined;
    months.innerHTML = `<div class="hm-cal-nav"><button type="button" data-hm-cal="prev" aria-label="Previous month">\u2039</button><button type="button" data-hm-cal="next" aria-label="Next month">\u203A</button></div>${drawMonth(state.view)}${drawMonth(addMonths(state.view, 1))}`;
    const [prev, next] = months.querySelectorAll<HTMLButtonElement>(".hm-cal-nav button");
    if (prev) prev.disabled = monthStart(state.view) <= monthStart(min);
    if (next)
      next.disabled = monthStart(addMonths(state.view, visibleMonths() - 1)) >= monthStart(max);
    for (const [edge, input] of Object.entries(inputs)) {
      if (!input || input === editing) continue;
      input.value = shownDay(state[edge as "start" | "end"]);
      input.removeAttribute("aria-invalid");
    }
    if (apply) apply.disabled = !(state.start && state.end);
    if (status) {
      status.textContent =
        state.start && state.end
          ? `${formatRange(new Date(toDate(state.start)), new Date(toDate(state.end)), locale, { day: true, year: true })}, ${Math.round((toDate(state.end) - toDate(state.start)) / DAY) + 1} days`
          : state.start
            ? "Pick the last day"
            : "Pick the first day";
    }
    const day = months.querySelector<HTMLButtonElement>(`[data-day="${state.focus}"]`);
    if (focus || had === undefined) {
      if (focus) day?.focus();
      return;
    }
    const same = had.dataset.hmCal
      ? months.querySelector<HTMLButtonElement>(`[data-hm-cal="${had.dataset.hmCal}"]`)
      : months.querySelector<HTMLButtonElement>(`[data-day="${had.dataset.day}"]`);
    (same && !same.disabled ? same : day)?.focus();
  };

  const moveFocus = (day: string) => {
    state.focus = clamp(day);
    const last = addMonths(state.view, visibleMonths() - 1);
    if (state.focus < state.view) state.view = monthStart(state.focus);
    else if (state.focus >= addMonths(monthStart(last), 1)) {
      state.view = monthStart(addMonths(state.focus, -(visibleMonths() - 1)));
    }
    drawCalendar(true);
  };

  const pick = (day: string) => {
    if (!inside(day)) return;
    if (state.start === undefined || state.end !== undefined || day < state.start) {
      state.start = day;
      state.end = undefined;
    } else state.end = day;
    state.focus = day;
    drawCalendar(true);
  };

  const close = (restore: boolean) => {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restore) button.focus();
  };

  const open = () => {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    (presets.find((b) => b.tabIndex === 0) ?? presets[0])?.focus();
    if (!months) return;
    const range = RANGE.exec(shown);
    if (range) {
      state.start = range[1];
      state.end = range[2];
    } else {
      state.start = undefined;
      state.end = undefined;
    }
    state.focus = clamp(state.end ?? max);
    drawCalendar();
    state.view = monthStart(addMonths(state.focus, -(visibleMonths() - 1)));
    if (state.view < monthStart(min)) state.view = monthStart(min);
    drawCalendar();
  };

  const check = (key: string) => {
    for (const b of presets) {
      const on = b.dataset.hmPreset === key;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (!presets.some((b) => b.tabIndex === 0) && presets[0]) presets[0].tabIndex = 0;
  };

  const choose = async (key: string, announce: boolean, again = false) => {
    if (key === shown && !again) {
      close(announce);
      return;
    }
    const grid = document.querySelector<HTMLElement>("main.hm-grid");
    const src = root.dataset.hmEngine;
    const payload = document.querySelector("script[data-hm-periods]")?.textContent;
    if (!src || !payload) return;
    grid?.setAttribute("aria-busy", "true");
    try {
      const view = (await loadEngine(src)).view(JSON.parse(payload), key, ranges);
      if (view === undefined) throw new RangeError(`no range "${key}"`);
      shown = view.key;
      check(view.key);
      const name = root.querySelector(".hm-period-name");
      if (name) {
        name.textContent = view.name;
        if (view.nameIsDates && view.lang) name.setAttribute("lang", view.lang);
        else name.removeAttribute("lang");
      }
      let dates = root.querySelector<HTMLElement>(".hm-period-button .hm-period-dates");
      if (view.dates && !dates) {
        dates = document.createElement("span");
        dates.className = "hm-period-dates";
        if (view.lang) dates.lang = view.lang;
        button.append(dates);
      }
      if (dates) {
        dates.textContent = view.dates ?? "";
        dates.hidden = view.dates === undefined;
      }
      redraw(view);
      writeParam(filter, view.key === fallback ? undefined : view.key);
      if (announce) live.textContent = `Showing ${view.name}${view.dates ? `, ${view.dates}` : ""}`;
      close(announce);
    } catch {
      if (!announce) writeParam(filter, undefined);
      else if (status) status.textContent = "This range is not available on this page";
    } finally {
      grid?.removeAttribute("aria-busy");
    }
  };

  button.addEventListener("click", () => (panel.hidden ? open() : close(true)));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden || panel.contains(event.target as Node)) return;
    event.preventDefault();
    close(true);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !root.contains(event.target as Node)) close(false);
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>("button:not([disabled]),input"),
    ].filter((el) => el.tabIndex >= 0 && el.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });

  const group = root.querySelector<HTMLElement>(".hm-period-presets");
  group?.addEventListener("click", (event) => {
    const key = (event.target as Element).closest<HTMLElement>("[data-hm-preset]")?.dataset
      .hmPreset;
    if (key !== undefined) void choose(key, true);
  });
  group?.addEventListener("keydown", (event) => {
    const at = presets.indexOf(document.activeElement as HTMLButtonElement);
    const to = {
      ArrowDown: at + 1,
      ArrowRight: at + 1,
      ArrowUp: at - 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: presets.length - 1,
    }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = presets[(to + presets.length) % presets.length];
    if (!next) return;
    for (const b of presets) b.tabIndex = b === next ? 0 : -1;
    next.focus();
  });

  months?.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!target) return;
    const nav = target.dataset.hmCal;
    if (nav === "prev" || nav === "next") {
      state.view = addMonths(state.view, nav === "prev" ? -1 : 1);
      if (!(state.focus >= state.view && state.focus < addMonths(state.view, visibleMonths()))) {
        state.focus = clamp(state.view);
      }
      drawCalendar();
      months.querySelector<HTMLButtonElement>(`[data-hm-cal="${nav}"]:not([disabled])`)?.focus();
      return;
    }
    if (target.dataset.day) pick(target.dataset.day);
  });
  months?.addEventListener("pointerover", (event) => {
    const day = (event.target as Element).closest<HTMLElement>("[data-day]")?.dataset.day;
    if (!day || !state.start || state.end || day === state.hover) return;
    state.hover = day;
    drawCalendar();
  });
  months?.addEventListener("keydown", (event) => {
    const day = (event.target as HTMLElement).dataset.day;
    if (!day) return;
    const weekday = (new Date(toDate(day)).getUTCDay() + 6 - weekStart + 7) % 7;
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(day, -1),
      ArrowRight: () => addDays(day, 1),
      ArrowUp: () => addDays(day, -7),
      ArrowDown: () => addDays(day, 7),
      Home: () => addDays(day, -weekday),
      End: () => addDays(day, 6 - weekday),
      PageUp: () => addMonths(day, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(day, event.shiftKey ? 12 : 1),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    moveFocus(move());
  });
  const read = (edge: "start" | "end", input: HTMLInputElement, typing: boolean) => {
    const text = input.value;
    const value = typedDay(text);
    const other = edge === "start" ? state.end : state.start;
    const crosses =
      value !== undefined &&
      other !== undefined &&
      (edge === "start" ? value > other : value < other);
    if (typing && (value === undefined || crosses)) return;
    input.removeAttribute("aria-invalid");
    if (value === undefined || !inside(value)) {
      if (edge === "start") state.start = undefined;
      state.end = undefined;
      drawCalendar(false, input);
      if (text.trim() === "") return;
      input.setAttribute("aria-invalid", "true");
      if (status)
        status.textContent =
          value === undefined
            ? `Type a date as ${pattern}`
            : `Pick a day from ${short.format(toDate(min))} to ${short.format(toDate(max))}`;
      return;
    }
    if (edge === "start") {
      state.start = value;
      if (state.end !== undefined && state.end < value) state.end = undefined;
    } else {
      if (state.start === undefined || value < state.start) state.start = value;
      state.end = value;
    }
    state.focus = value;
    state.view = monthStart(addMonths(value, edge === "end" ? -(visibleMonths() - 1) : 0));
    if (state.view < monthStart(min)) state.view = monthStart(min);
    drawCalendar(false, typing ? input : undefined);
  };
  for (const edge of ["start", "end"] as const) {
    const input = inputs[edge];
    input?.addEventListener("input", () => read(edge, input, true));
    input?.addEventListener("change", () => read(edge, input, false));
  }
  cal?.querySelector("[data-hm-cal=cancel]")?.addEventListener("click", () => close(true));
  apply?.addEventListener("click", () => {
    if (state.start && state.end) void choose(`${state.start}..${state.end}`, true);
  });

  const requested = new URLSearchParams(location.search).get(filter);
  if (requested && requested !== shown) void choose(requested, false);
  return (force = false) => {
    if (shown !== fallback || force) void choose(shown, false, true);
  };
}
