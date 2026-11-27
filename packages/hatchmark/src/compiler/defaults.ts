import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  type Anchors,
  type Block,
  type Dashboard,
  DEFAULT_PERIOD,
  type Grain,
  type Project,
  projectAnchors,
  type RangeSpec,
  type ResolvedGrain,
  resolveGrain,
  type SpecFile,
  type TimeGrain,
} from "../spec/index.js";
import { shownGrain } from "./planner.js";
import { bucketStart, NAMED, resolveRange } from "./windows.js";

/**
 * HM4040 notes for the business-definition defaults a project relies on (RFC 0001 section 3.11):
 * one per definition, naming the default and the option that changes it.
 */
export function explainDefaults(project: Project): Diagnostic[] {
  const out: Diagnostic[] = [];
  const anchored = new Set<AnchorUnit>();
  const blockAnchored = new Set<AnchorUnit>();
  const rangeAnchored = new Set<AnchorUnit>();
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
    const anchors = projectAnchors(project.config.spec);
    const shownRange = firstRange(dashboard);
    const bounded = ranges(dashboard).some((r) => r !== "all_time");
    for (const range of [...ranges(dashboard), (dashboard.period ?? DEFAULT_PERIOD).range]) {
      const unit = rangeUnit(range);
      if (unit === "week" || unit === "quarter" || unit === "year") {
        anchored.add(unit);
        rangeAnchored.add(unit);
      }
    }
    dashboard.blocks.forEach((block, index) => {
      const grains = timeGrains(block);
      if (grains.length === 0) return;
      for (const g of grains) {
        const unit = unitOf(g);
        const own = typeof g === "object" && g.anchor !== undefined;
        if ((unit === "week" || unit === "quarter" || unit === "year") && !own) {
          anchored.add(unit);
          blockAnchored.add(unit);
        }
      }
      const shown = shownGrain(
        { spec: dashboard, anchors },
        grains[0] as Grain,
        "grains" in block ? block.grains : undefined,
      );
      const pointer = `/blocks/${index}/grain`;
      const edged =
        shown.unit === "day"
          ? grains.map((g) => resolveGrain(g, anchors)).find((g) => g.unit !== "day")
          : shown;
      if (!("edges" in block && block.edges !== undefined) && edged !== undefined && bounded) {
        const unit = edged.unit;
        const dated = shown.unit === "day" ? undefined : snapped(anchors, asOf, shownRange, edged);
        out.push(
          note(
            file,
            pointer,
            `uses edges: snap: ${dated ?? `the first ${unit} starts at the start of the ${unit} that holds the range start`}`,
            "set edges: clip to start exactly at the range; edges: snap keeps the default and silences this note",
          ),
        );
      }
      if (!("incomplete" in block && block.incomplete !== undefined)) {
        out.push(
          note(
            file,
            pointer,
            `uses incomplete: mark: a ${shown.unit} the data doesn't fully cover is marked in progress`,
            "set incomplete: hide to leave such buckets out, or show to draw them as complete; incomplete: mark keeps the default and silences this note",
          ),
        );
      }
    });
  }
  const config = project.config.spec;
  const quarter = config?.anchors?.quarter;
  const year = config?.anchors?.year;
  const onlyBlocks = (unit: AnchorUnit) => blockAnchored.has(unit) && !rangeAnchored.has(unit);
  const blockOption = (unit: AnchorUnit, anchor: string) =>
    onlyBlocks(unit) ? `, or a block's grain: {unit: ${unit}, anchor: ${anchor}}` : "";
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
        `set anchors: {week: sunday} to start weeks on Sunday${blockOption("week", "sunday")}; anchors: {week: monday} keeps the default and silences this note`,
      ),
    );
  }
  if (anchored.has("quarter") && quarter === undefined && year === undefined) {
    out.push(
      note(
        project.config,
        "/name",
        "uses the default quarter anchor: quarters start on Jan 1, Apr 1, Jul 1 and Oct 1",
        `set anchors: {quarter: 02-01} for quarters from Feb 1${blockOption("quarter", "02-01")}; anchors: {quarter: 01-01} keeps the default and silences this note`,
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
        quarter === undefined
          ? `set anchors: {year: ${example}} for a year from ${monthDay(example)}${blockOption("year", example)}; anchors: {year: 01-01} keeps the default and silences this note`
          : `set anchors: {year: ${example}} for a year from ${monthDay(example)}, or another quarter start${onlyBlocks("year") ? "; a block's grain: {unit: year, anchor: 01-01} keeps years from Jan 1 and silences this note" : ""}`,
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

type AnchorUnit = "week" | "quarter" | "year";

function rangeUnit(range: RangeSpec): TimeGrain | undefined {
  if (range === "all_time") return undefined;
  const spec = typeof range === "string" ? NAMED[range] : range;
  if ("start" in spec) return undefined;
  if ("last_complete" in spec) return spec.last_complete;
  if ("to_date" in spec) return spec.to_date;
  return spec.unit;
}

function unitOf(grain: Grain) {
  return typeof grain === "string" ? grain : grain.unit;
}

function same(a: Grain, b: Grain): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function firstRange(dashboard: Dashboard): RangeSpec {
  const filter = dashboard.filters?.find((f) => f.type === "period");
  return filter?.default ?? (dashboard.period ?? DEFAULT_PERIOD).range;
}

function ranges(dashboard: Dashboard): RangeSpec[] {
  const filter = dashboard.filters?.find((f) => f.type === "period");
  return filter?.options ?? [(dashboard.period ?? DEFAULT_PERIOD).range];
}

function timeGrains(block: Block): Grain[] {
  if (block.type !== "line" && block.type !== "area" && block.type !== "bar") return [];
  if (block.grain === undefined) return [];
  return [block.grain, ...(block.grains ?? []).filter((g) => !same(g, block.grain as Grain))];
}

function snapped(
  anchors: Anchors,
  asOf: string,
  range: RangeSpec,
  grain: ResolvedGrain,
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || range === "all_time") return undefined;
  let bounds: ReturnType<typeof resolveRange>;
  try {
    bounds = resolveRange(range, "none", asOf, anchors);
  } catch {
    return undefined;
  }
  if (bounds?.kind !== "bounded") return undefined;
  const start = bucketStart(bounds.start, grain);
  if (start === bounds.start) return undefined;
  const year = asOf.slice(0, 4);
  return `the first ${grain.unit} starts on ${day(start, grain.unit === "week", year)}, before the range starts on ${day(bounds.start, false, year)}`;
}

function monthDay(md: string): string {
  return day(`2001-${md}`, false);
}

function day(date: string, weekday: boolean, year?: string): string {
  return new Date(`${date}T00:00:00Z`)
    .toLocaleDateString("en-US", {
      ...(weekday ? { weekday: "short" } : {}),
      ...(year === undefined || date.startsWith(year) ? {} : { year: "numeric" }),
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    .replace(/^(\w{3}),/, "$1");
}
