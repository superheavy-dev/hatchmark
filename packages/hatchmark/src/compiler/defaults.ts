import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  type Block,
  type Dashboard,
  DEFAULT_PERIOD,
  type Grain,
  type Project,
  projectAnchors,
  type RangeSpec,
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
          "uses the default period, asOf: latest_data: charts end at the newest source's horizon, and sources that end earlier are marked partial",
          "add period: {asOf: latest_common_data, range: last_12_months, compare: previous_period} to end every chart at the oldest source's horizon, or a date as asOf to make builds reproducible; asOf: latest_data keeps the default and silences this note",
        ),
      );
    }
    const asOf = (dashboard.period ?? DEFAULT_PERIOD).asOf;
    const range = shownRange(dashboard);
    const chosen = dashboard.filters?.find((f) => f.type === "grain")?.default;
    dashboard.blocks.forEach((block, index) => {
      const grains = timeGrains(block);
      if (grains.length === 0) return;
      for (const g of grains) {
        const unit = unitOf(g);
        const own = typeof g === "object" && g.anchor !== undefined;
        if ((unit === "week" || unit === "quarter" || unit === "year") && !own) anchored.add(unit);
      }
      const shown =
        chosen !== undefined && grains.some((g) => same(g, chosen)) ? chosen : (grains[0] as Grain);
      const pointer = `/blocks/${index}/grain`;
      const edged = unitOf(shown) === "day" ? grains.find((g) => unitOf(g) !== "day") : shown;
      if (
        !("edges" in block && block.edges !== undefined) &&
        edged !== undefined &&
        range !== "all_time"
      ) {
        const unit = unitOf(edged);
        out.push(
          note(
            file,
            pointer,
            `uses edges: snap: ${snapped(project, asOf, range, edged) ?? `the first ${unit} starts at the start of the ${unit} that holds the range start`}`,
            "set edges: clip to start exactly at the range; edges: snap keeps the default and silences this note",
          ),
        );
      }
      if (!("incomplete" in block && block.incomplete !== undefined)) {
        out.push(
          note(
            file,
            pointer,
            `uses incomplete: mark: a ${unitOf(shown)} the data doesn't fully cover is marked in progress`,
            "set incomplete: hide to leave such buckets out, or show to draw them as complete; incomplete: mark keeps the default and silences this note",
          ),
        );
      }
    });
  }
  const config = project.config.spec;
  const quarter = config?.anchors?.quarter;
  const year = config?.anchors?.year;
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
        "set anchors: {week: sunday} to start weeks on Sunday, or a block's grain: {unit: week, anchor: sunday}; anchors: {week: monday} keeps the default and silences this note",
      ),
    );
  }
  if (anchored.has("quarter") && quarter === undefined && year === undefined) {
    out.push(
      note(
        project.config,
        "/name",
        "uses the default quarter anchor: quarters start on Jan 1, Apr 1, Jul 1 and Oct 1",
        "set anchors: {quarter: 02-01} for quarters from Feb 1, or a block's grain: {unit: quarter, anchor: 02-01}; anchors: {quarter: 01-01} keeps the default and silences this note",
      ),
    );
  }
  if (anchored.has("year") && year === undefined) {
    const example = quarter ?? "07-01";
    out.push(
      note(
        project.config,
        "/name",
        "uses the default year anchor: years start on Jan 1",
        `set anchors: {year: ${example}} for a year from ${monthDay(example)}${quarter === undefined ? "" : ", or another quarter start"}, or a block's grain: {unit: year, anchor: ${example}}; anchors: {year: 01-01} keeps the default and silences this note`,
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

function same(a: Grain, b: Grain): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function shownRange(dashboard: Dashboard): RangeSpec {
  const filter = dashboard.filters?.find((f) => f.type === "period");
  if (filter !== undefined) return filter.default;
  return (dashboard.period ?? DEFAULT_PERIOD).range;
}

function timeGrains(block: Block): Grain[] {
  if (block.type !== "line" && block.type !== "area" && block.type !== "bar") return [];
  if (block.grain === undefined) return [];
  return [block.grain, ...(block.grains ?? []).filter((g) => !same(g, block.grain as Grain))];
}

function snapped(
  project: Project,
  asOf: string,
  range: RangeSpec,
  grain: Grain,
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return undefined;
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
    bounds = resolveRange(range, "none", asOf, anchors);
  } catch {
    return undefined;
  }
  if (bounds?.kind !== "bounded") return undefined;
  const start = bucketStart(bounds.start, resolved);
  if (start === bounds.start) return undefined;
  return `the first ${unit} starts on ${day(start, unit === "week")}, before the range starts on ${day(bounds.start, false)}`;
}

function monthDay(md: string): string {
  return day(`2001-${md}`, false);
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
