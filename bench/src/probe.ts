export type VisualKind = "text" | "svg" | "canvas" | "table";

export interface Visual {
  name: string;
  kind: VisualKind;
  selector: string;
  chart?: boolean;
  index?: number;
  marks?: string;
  minMarks?: number;
}

export interface VisualTiming {
  name: string;
  readyAt: number | null;
  changedAt: number | null;
}

export interface ProbeResult {
  fcp: number | null;
  lcp: number | null;
  longTaskMs: number;
  visuals: VisualTiming[];
  interaction: {
    startedAt: number | null;
    settledAt: number | null;
    maxEventDuration: number | null;
    longTaskMs: number;
  };
  inlineScripts: string;
}

declare global {
  interface Window {
    __bench: {
      result(): ProbeResult;
      arm(): void;
      allReady(): boolean;
      settled(quietMs: number): boolean;
    };
  }
}

export function installProbe(visuals: Visual[]): void {
  type State = {
    visual: Visual;
    readyAt: number | null;
    signature: string;
    element: Element | null;
    mutations: number;
    observer: MutationObserver | null;
    lastChange: number;
    armedSignature: string | null;
    changedAt: number | null;
  };
  const states: State[] = visuals.map((visual) => ({
    visual,
    readyAt: null,
    signature: "",
    element: null,
    mutations: 0,
    observer: null,
    lastChange: 0,
    armedSignature: null,
    changedAt: null,
  }));
  let fcp: number | null = null;
  let lcp: number | null = null;
  let longTaskMs = 0;
  let armedAt: number | null = null;
  let startedAt: number | null = null;
  let interactionLongTaskMs = 0;
  let maxEventDuration: number | null = null;
  const sample = document.createElement("canvas");
  sample.width = 16;
  sample.height = 16;
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });

  const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({
        type,
        buffered: true,
      });
    } catch {}
  };
  observe("paint", (entry) => {
    if (entry.name === "first-contentful-paint") fcp = entry.startTime;
  });
  observe("largest-contentful-paint", (entry) => {
    lcp = entry.startTime;
  });
  observe("longtask", (entry) => {
    const blocking = Math.max(0, entry.duration - 50);
    longTaskMs += blocking;
    if (armedAt !== null && entry.startTime >= armedAt) interactionLongTaskMs += blocking;
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (startedAt === null || entry.startTime < startedAt - 1) continue;
        maxEventDuration = Math.max(maxEventDuration ?? 0, entry.duration);
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  } catch {}
  for (const type of ["pointerdown", "mousedown", "click", "keydown", "change"]) {
    window.addEventListener(
      type,
      (event) => {
        if (armedAt !== null && startedAt === null && event.isTrusted) startedAt = event.timeStamp;
      },
      true,
    );
  }

  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  const pick = (selector: string, index = 0) => {
    let seen = 0;
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element)) continue;
      if (seen === index) return element;
      seen++;
    }
    return null;
  };
  const canvasInk = (canvas: HTMLCanvasElement) => {
    if (!sampleContext || canvas.width === 0 || canvas.height === 0) return "";
    sampleContext.clearRect(0, 0, 16, 16);
    try {
      sampleContext.drawImage(canvas, 0, 0, 16, 16);
    } catch {
      return "";
    }
    const pixels = sampleContext.getImageData(0, 0, 16, 16).data;
    let ink = 0;
    let hash = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] ?? 0;
      if (alpha > 0) ink++;
      hash = (Math.imul(hash, 31) + (pixels[i] ?? 0) + (pixels[i + 1] ?? 0) * 7 + alpha * 13) | 0;
    }
    return ink >= 4 ? String(hash) : "";
  };
  const read = (state: State): { element: Element; signature: string } | null => {
    const { visual } = state;
    const element = pick(visual.selector, visual.index);
    if (!element) return null;
    if (element !== state.element) {
      state.observer?.disconnect();
      state.element = element;
      state.mutations++;
      state.observer = new MutationObserver(() => {
        state.mutations++;
      });
      state.observer.observe(element, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    if (visual.kind === "text") {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      return /\d/.test(text) ? { element, signature: `${text}:${state.mutations}` } : null;
    }
    if (visual.kind === "canvas") {
      const canvases = [
        ...(element instanceof HTMLCanvasElement ? [element] : element.querySelectorAll("canvas")),
      ].filter((c): c is HTMLCanvasElement => c instanceof HTMLCanvasElement && visible(c));
      const inks = canvases.map(canvasInk);
      if (!inks.some((ink) => ink !== "")) return null;
      return { element, signature: inks.join("|") };
    }
    const marks = element.querySelectorAll(
      visual.marks ?? (visual.kind === "table" ? "tr" : "path, rect"),
    );
    if (marks.length < (visual.minMarks ?? 1)) return null;
    return { element, signature: `${marks.length}:${state.mutations}` };
  };

  const tick = (now: number) => {
    for (const state of states) {
      const current = read(state);
      if (!current) continue;
      if (state.readyAt === null) state.readyAt = now;
      if (current.signature !== state.signature) {
        state.signature = current.signature;
        state.lastChange = now;
        if (
          state.armedSignature !== null &&
          state.changedAt === null &&
          current.signature !== state.armedSignature
        ) {
          state.changedAt = now;
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__bench = {
    result: () => ({
      fcp,
      lcp,
      longTaskMs,
      visuals: states.map((s) => ({
        name: s.visual.name,
        readyAt: s.readyAt,
        changedAt: s.changedAt,
      })),
      interaction: {
        startedAt,
        settledAt:
          startedAt === null || states.some((s) => s.changedAt === null)
            ? null
            : Math.max(...states.map((s) => s.lastChange)),
        maxEventDuration,
        longTaskMs: interactionLongTaskMs,
      },
      inlineScripts: [...document.querySelectorAll("script:not([src])")]
        .filter((script) =>
          ["", "module", "text/javascript", "application/javascript"].includes(
            script.getAttribute("type") ?? "",
          ),
        )
        .map((script) => script.textContent ?? "")
        .join("\n"),
    }),
    arm: () => {
      armedAt = performance.now();
      for (const state of states) state.armedSignature = state.signature;
    },
    allReady: () => states.every((s) => s.readyAt !== null),
    settled: (quietMs: number) => {
      const now = performance.now();
      return states.every((s) => s.changedAt !== null && now - s.lastChange >= quietMs);
    },
  };
}
