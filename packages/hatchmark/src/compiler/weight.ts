import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import type { Project } from "../spec/index.js";
import type { PeriodData } from "./period-data.js";

/**
 * The most a dashboard page should weigh, in bytes of HTML: everything the page carries, the
 * drawn charts at every layout and grain included, and the data embedded for the period filter.
 * Above it the page is slow to load on a phone, so build warns (HM5002).
 */
export const PAGE_BUDGET = 3_000_000;

const bytes = (text: string) => new TextEncoder().encode(text).length;
const megabytes = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/**
 * HM5002 when a built page weighs more than PAGE_BUDGET, with what makes it heavy: the presets'
 * data, the day-grain data for custom ranges, and the rest (markup and every chart drawn ahead).
 * Undefined when the page is within budget.
 */
export function pageWeight(
  project: Project,
  dashboard: string,
  html: string,
  periods: PeriodData | undefined,
): Diagnostic | undefined {
  const total = bytes(html);
  if (total <= PAGE_BUDGET) return undefined;
  const presets = periods ? bytes(JSON.stringify(periods.presets)) : 0;
  const custom = periods?.custom ? bytes(JSON.stringify(periods.custom)) : 0;
  const file = project.dashboards.get(dashboard);
  const at = file?.spec?.filters?.findIndex((f) => f.type === "period") ?? -1;
  const pointer = custom > 0 && at >= 0 ? `/filters/${at}` : "";
  const parts = [
    ...(custom > 0 ? [`day-grain data for custom ranges ${megabytes(custom)}`] : []),
    ...(presets > 0 ? [`presets ${megabytes(presets)}`] : []),
    `charts and markup ${megabytes(total - custom - presets)}`,
  ];
  return {
    code: "HM5002",
    severity: "warning",
    message: `dashboard "${dashboard}" builds a ${megabytes(total)} page, more than the ${megabytes(PAGE_BUDGET)} budget (${parts.join(", ")})`,
    ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
    help:
      custom > 0
        ? "set custom: false on the period filter to offer presets only, or shorten the data"
        : "list fewer grains or presets, split by fewer values, or move blocks to another dashboard",
    docs: docsCommand("HM5002"),
  };
}
