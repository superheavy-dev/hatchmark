/**
 * The period control: a button naming the range shown and a dialog with the presets and, when the
 * page embeds day-grain data, a calendar for any first and last day. Picking a range loads the
 * period engine (runtime/periods.ts) once, which returns the page's blocks drawn for that range;
 * the runtime swaps them in. The range lives in the page URL (?<filter id>=last_7_days or
 * ?<filter id>=2026-01-01..2026-03-31), so a reload or a shared link shows the same range.
 *
 * Keyboard: the presets are a radio group (arrows move and pick). The calendar is a grid: arrows
 * move a day or a week, Home and End go to the week's ends, Page Up and Page Down move a month
 * (with Shift a year), Enter or Space picks the first and then the last day. Escape closes the
 * dialog and returns focus to the button; Tab stays inside the dialog while it is open.
 */

export interface PeriodView {
  key: string;
  blocks: string;
  caption: string;
  name: string;
  dates?: string;
  presetOnly: string[];
}

interface Engine {
  view(payload: unknown, key: string): PeriodView | undefined;
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

/** Writes one query parameter into the address without a new history entry; the default removes it. */
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

function loadEngine(src: string): Promise<Engine> {
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

/**
 * Wires one period control. Returns a refresh that draws the shown range again from the page's
 * current payload, which hatchmark dev replaces after a change; the default range needs nothing.
 */
export function mountPeriod(root: HTMLElement, redraw: (view: PeriodView) => void): () => void {
  const filter = root.dataset.hmPeriod ?? "period";
  const locale = root.dataset.hmLocale ?? "en-US";
  const button = root.querySelector<HTMLButtonElement>(".hm-period-button");
  const panel = root.querySelector<HTMLElement>(".hm-period-panel");
  const presets = [...root.querySelectorAll<HTMLButtonElement>("[data-hm-preset]")];
  const cal = root.querySelector<HTMLElement>(".hm-cal");
  if (!button || !panel) return () => {};
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
  for (const input of [inputs.start, inputs.end]) {
    if (!input) continue;
    input.min = min;
    input.max = max;
  }
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
  const fmt = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
  const monthName = fmt({ month: "long", year: "numeric" });
  const weekdayName = fmt({ weekday: "short" });
  const weekdayLong = fmt({ weekday: "long" });
  const dayLabel = fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const short = fmt({ month: "short", day: "numeric", year: "numeric" });
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

  const drawCalendar = (focus = false) => {
    if (!months) return;
    months.innerHTML = `<div class="hm-cal-nav"><button type="button" data-hm-cal="prev" aria-label="Previous month">\u2039</button><button type="button" data-hm-cal="next" aria-label="Next month">\u203A</button></div>${drawMonth(state.view)}${drawMonth(addMonths(state.view, 1))}`;
    const [prev, next] = months.querySelectorAll<HTMLButtonElement>(".hm-cal-nav button");
    if (prev) prev.disabled = monthStart(state.view) <= monthStart(min);
    if (next)
      next.disabled = monthStart(addMonths(state.view, visibleMonths() - 1)) >= monthStart(max);
    if (inputs.start) inputs.start.value = state.start ?? "";
    if (inputs.end) inputs.end.value = state.end ?? "";
    if (apply) apply.disabled = !(state.start && state.end);
    if (status) {
      status.textContent =
        state.start && state.end
          ? `${short.format(toDate(state.start))} \u2013 ${short.format(toDate(state.end))}, ${Math.round((toDate(state.end) - toDate(state.start)) / DAY) + 1} days`
          : state.start
            ? "Pick the last day"
            : "Pick the first day";
    }
    if (focus) months.querySelector<HTMLButtonElement>(`[data-day="${state.focus}"]`)?.focus();
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
      const view = (await loadEngine(src)).view(JSON.parse(payload), key);
      if (view === undefined) throw new RangeError(`no range "${key}"`);
      shown = view.key;
      check(view.key);
      const name = root.querySelector(".hm-period-name");
      if (name) name.textContent = view.name;
      let dates = root.querySelector<HTMLElement>(".hm-period-button .hm-period-dates");
      if (view.dates && !dates) {
        dates = document.createElement("span");
        dates.className = "hm-period-dates";
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
  for (const [edge, input] of Object.entries(inputs)) {
    input?.addEventListener("change", () => {
      const value = input.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !inside(value)) return;
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
      drawCalendar();
    });
  }
  cal?.querySelector("[data-hm-cal=cancel]")?.addEventListener("click", () => close(true));
  apply?.addEventListener("click", () => {
    if (state.start && state.end) void choose(`${state.start}..${state.end}`, true);
  });

  const requested = new URLSearchParams(location.search).get(filter);
  if (requested && requested !== shown) void choose(requested, false);
  return () => {
    if (shown !== fallback) void choose(shown, false, true);
  };
}
