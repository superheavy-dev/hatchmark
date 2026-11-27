import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  type Block,
  DEFAULT_PERIOD,
  type Grain,
  type Period,
  type Project,
  projectAnchors,
  type ResolvedGrain,
  type SpecFile,
} from "../spec/index.js";
import { bucketStart, resolveRange } from "./windows.js";

/**
 * HM4040 notes for the business-definition defaults a project relies on (RFC 0001 section 3.11):
 * one per definition, naming the default and the option that changes it.
 */
export function explainDefaults(project: Project): Diagnostic[] {
  const out: Diagnostic[] = [];
  const anchored = new Set<"week" | "quarter" | "year">();
  for (const file of project.dashboards.values()) {
    const dashboard = file.spec;
    if (dashboard === undefined) continue;
    if (dashboard.period === undefined) {
      out.push(
        note(
          file,
          "/title",
          'uses the default period, "asOf": "latest_data": charts end at the newest source\'s horizon, and sources that end earlier are marked partial',
          'add "period" with "asOf": "latest_common_data" to end every chart at the oldest source\'s horizon, or a date to make builds reproducible; "asOf": "latest_data" keeps the default and silences this note',
        ),
      );
    }
    const period = dashboard.period ?? DEFAULT_PERIOD;
    dashboard.blocks.forEach((block, index) => {
      const grains = timeGrains(block);
      const first = grains[0];
      if (first === undefined) return;
      for (const g of grains) {
        const unit = unitOf(g);
        const own = typeof g === "object" && g.anchor !== undefined;
        if ((unit === "week" || unit === "quarter" || unit === "year") && !own) anchored.add(unit);
      }
      const pointer = `/blocks/${index}/grain`;
      const unit = unitOf(first);
      if (!("edges" in block && block.edges !== undefined) && unit !== "day") {
        out.push(
          note(
            file,
            pointer,
            `uses edges "snap": ${snapped(project, period, first) ?? `the first ${unit} starts at the start of the ${unit} that holds the range start`}`,
            'set "edges": "clip" to start exactly at the range; "edges": "snap" keeps the default and silences this note',
          ),
        );
      }
      if (!("incomplete" in block && block.incomplete !== undefined)) {
        out.push(
          note(
            file,
            pointer,
            `uses incomplete "mark": a ${unit} the data doesn't fully cover is marked in progress`,
            'set "incomplete": "hide" to leave such buckets out, or "show" to draw them as complete; "incomplete": "mark" keeps the default and silences this note',
          ),
        );
      }
    });
  }
  const config = project.config.spec;
  const yearSet = config?.anchors?.year !== undefined;
  if (
    anchored.has("week") &&
    config?.anchors?.week === undefined &&
    config?.weekStart === undefined
  ) {
    out.push(
      note(
        project.config,
        "/name",
        "uses the default week anchor: weeks start on Monday",
        'set "anchors": {"week": "sunday"} to start weeks on Sunday, or a block\'s "grain": {"unit": "week", "anchor": "sunday"}; "anchors": {"week": "monday"} keeps the default and silences this note',
      ),
    );
  }
  if (
    (anchored.has("quarter") && config?.anchors?.quarter === undefined && !yearSet) ||
    (anchored.has("year") && !yearSet)
  ) {
    out.push(
      note(
        project.config,
        "/name",
        "uses the default year anchor: quarters and years start on Jan 1",
        'set "anchors": {"year": "07-01"} for a fiscal year from July 1, or a block\'s "grain": {"unit": "year", "anchor": "07-01"}; "anchors": {"year": "01-01"} keeps the default and silences this note',
      ),
    );
  }
  return out;
}

function note(file: SpecFile, pointer: string, message: string, help: string): Diagnostic {
  return {
    code: "HM4040",
    severity: "note",
    message,
    file: file.file,
    pointer,
    ...file.document.locationOf(pointer),
    help,
    docs: docsCommand("HM4040"),
  };
}

function unitOf(grain: Grain) {
  return typeof grain === "string" ? grain : grain.unit;
}

function timeGrains(block: Block): Grain[] {
  if (block.type !== "line" && block.type !== "area" && block.type !== "bar") return [];
  if (block.grain === undefined) return [];
  return [block.grain, ...(block.grains ?? []).filter((g) => g !== block.grain)];
}

function snapped(project: Project, period: Period, grain: Grain): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.asOf)) return undefined;
  const anchors = projectAnchors(project.config.spec);
  const unit = unitOf(grain);
  const anchor = typeof grain === "object" ? grain.anchor : undefined;
  const resolved = (
    unit === "day" || unit === "month"
      ? { unit }
      : { unit, anchor: anchor ?? (unit === "week" ? anchors.week : anchors[unit]) }
  ) as ResolvedGrain;
  let bounds: ReturnType<typeof resolveRange>;
  try {
    bounds = resolveRange(period.range, "none", period.asOf, anchors);
  } catch {
    return undefined;
  }
  if (bounds?.kind !== "bounded") return undefined;
  const start = bucketStart(bounds.start, resolved);
  if (start === bounds.start) return undefined;
  return `the first ${unit} starts on ${day(start, unit === "week")}, before the range starts on ${day(bounds.start, false)}`;
}

function day(date: string, weekday: boolean): string {
  return new Date(`${date}T00:00:00Z`)
    .toLocaleDateString("en-US", {
      ...(weekday ? { weekday: "short" } : {}),
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    .replace(",", "");
}
