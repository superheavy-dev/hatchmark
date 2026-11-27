import { describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { DashboardData, LineData } from "../../src/compiler/dashboard-data.js";
import { chartRuntimeData } from "../../src/render/describe.js";
import {
  formatPreviousSpan,
  formatSpan,
  recordRanges,
  useRanges,
} from "../../src/render/format.js";
import { DEFAULT_THEME } from "../../src/render/theme.js";

const LOCALES = ["en-US", "en-GB", "de-DE", "fr-FR", "ja-JP", "ko-KR"] as const;
type Locale = (typeof LOCALES)[number];

function each(expected: Record<Locale, string>, actual: (locale: Locale) => string | undefined) {
  for (const locale of LOCALES) expect(actual(locale), locale).toBe(expected[locale]);
}

const span = (start: string, end: string) => (locale: string) => formatSpan({ start, end }, locale);

describe("date ranges in the project locale", () => {
  it("collapses a day range inside one month", () => {
    each(
      {
        "en-US": "Oct 25 \u2013 31, 2026",
        "en-GB": "25 \u2013 31 Oct 2026",
        "de-DE": "25.\u201331. Okt. 2026",
        "fr-FR": "25\u201331 oct. 2026",
        "ja-JP": "2026/10/25\uff5e2026/10/31",
        "ko-KR": "2026\ub144 10\uc6d4 25\uc77c~31\uc77c",
      },
      span("2026-10-25", "2026-11-01"),
    );
  });

  it("shows the year once for a day range across months", () => {
    each(
      {
        "en-US": "Oct 25 \u2013 Nov 7, 2026",
        "en-GB": "25 Oct \u2013 7 Nov 2026",
        "de-DE": "25. Okt. \u2013 7. Nov. 2026",
        "fr-FR": "25 oct. \u2013 7 nov. 2026",
        "ja-JP": "2026/10/25\uff5e2026/11/07",
        "ko-KR": "2026\ub144 10\uc6d4 25\uc77c~11\uc6d4 7\uc77c",
      },
      span("2026-10-25", "2026-11-08"),
    );
  });

  it("shows both years for a day range across years", () => {
    each(
      {
        "en-US": "Dec 28, 2025 \u2013 Jan 3, 2026",
        "en-GB": "28 Dec 2025 \u2013 3 Jan 2026",
        "de-DE": "28. Dez. 2025 \u2013 3. Jan. 2026",
        "fr-FR": "28 d\u00e9c. 2025 \u2013 3 janv. 2026",
        "ja-JP": "2025/12/28\uff5e2026/01/03",
        "ko-KR": "2025\ub144 12\uc6d4 28\uc77c~2026\ub144 1\uc6d4 3\uc77c",
      },
      span("2025-12-28", "2026-01-04"),
    );
  });

  it("names a single day as that day", () => {
    each(
      {
        "en-US": "Oct 25, 2026",
        "en-GB": "25 Oct 2026",
        "de-DE": "25. Okt. 2026",
        "fr-FR": "25 oct. 2026",
        "ja-JP": "2026\u5e7410\u670825\u65e5",
        "ko-KR": "2026\ub144 10\uc6d4 25\uc77c",
      },
      span("2026-10-25", "2026-10-26"),
    );
  });

  it("names whole months as a month range, with the dotted abbreviation on both ends", () => {
    each(
      {
        "en-US": "Feb \u2013 May 2026",
        "en-GB": "Feb \u2013 May 2026",
        "de-DE": "Feb.\u2013Mai 2026",
        "fr-FR": "f\u00e9vr.\u2013mai 2026",
        "ja-JP": "2026/02\uff5e2026/05",
        "ko-KR": "2026\ub144 2\uc6d4~5\uc6d4",
      },
      span("2026-02-01", "2026-06-01"),
    );
    each(
      {
        "en-US": "Nov 2025 \u2013 Oct 2026",
        "en-GB": "Nov 2025 \u2013 Oct 2026",
        "de-DE": "Nov. 2025 \u2013 Okt. 2026",
        "fr-FR": "nov. 2025 \u2013 oct. 2026",
        "ja-JP": "2025/11\uff5e2026/10",
        "ko-KR": "2025\ub144 11\uc6d4~2026\ub144 10\uc6d4",
      },
      span("2025-11-01", "2026-11-01"),
    );
  });

  it("names year to date by months when it ends on a month, by days otherwise", () => {
    each(
      {
        "en-US": "Jan \u2013 Oct 2026",
        "en-GB": "Jan \u2013 Oct 2026",
        "de-DE": "Jan.\u2013Okt. 2026",
        "fr-FR": "janv.\u2013oct. 2026",
        "ja-JP": "2026/01\uff5e2026/10",
        "ko-KR": "2026\ub144 1\uc6d4~10\uc6d4",
      },
      span("2026-01-01", "2026-11-01"),
    );
    each(
      {
        "en-US": "Jan 1 \u2013 Nov 27, 2026",
        "en-GB": "1 Jan \u2013 27 Nov 2026",
        "de-DE": "1. Jan. \u2013 27. Nov. 2026",
        "fr-FR": "1 janv. \u2013 27 nov. 2026",
        "ja-JP": "2026/01/01\uff5e2026/11/27",
        "ko-KR": "2026\ub144 1\uc6d4 1\uc77c~11\uc6d4 27\uc77c",
      },
      span("2026-01-01", "2026-11-28"),
    );
  });

  it("keeps one month, quarters and whole years short", () => {
    each(
      {
        "en-US": "Oct 2026",
        "en-GB": "Oct 2026",
        "de-DE": "Okt. 2026",
        "fr-FR": "oct. 2026",
        "ja-JP": "2026\u5e7410\u6708",
        "ko-KR": "2026\ub144 10\uc6d4",
      },
      span("2026-10-01", "2026-11-01"),
    );
    for (const locale of LOCALES) {
      expect(formatSpan({ start: "2026-01-01", end: "2026-04-01" }, locale)).toBe("Q1 2026");
      expect(formatSpan({ start: "2026-01-01", end: "2027-01-01" }, locale)).toBe("2026");
    }
  });

  it("names the previous period: a month of the same year without its year, else a full range", () => {
    const current = { start: "2026-10-01", end: "2026-11-01" };
    each(
      {
        "en-US": "Sep",
        "en-GB": "Sept",
        "de-DE": "Sep",
        "fr-FR": "sept.",
        "ja-JP": "9\u6708",
        "ko-KR": "9\uc6d4",
      },
      (locale) => formatPreviousSpan({ start: "2026-09-01", end: "2026-10-01" }, current, locale),
    );
    each(
      {
        "en-US": "Dec 28, 2025 \u2013 Jan 3, 2026",
        "en-GB": "28 Dec 2025 \u2013 3 Jan 2026",
        "de-DE": "28. Dez. 2025 \u2013 3. Jan. 2026",
        "fr-FR": "28 d\u00e9c. 2025 \u2013 3 janv. 2026",
        "ja-JP": "2025/12/28\uff5e2026/01/03",
        "ko-KR": "2025\ub144 12\uc6d4 28\uc77c~2026\ub144 1\uc6d4 3\uc77c",
      },
      (locale) =>
        formatPreviousSpan(
          { start: "2025-12-28", end: "2026-01-04" },
          { start: "2026-01-04", end: "2026-01-11" },
          locale,
        ),
    );
    each(
      {
        "en-US": "Oct 25 \u2013 31, 2026",
        "en-GB": "25 \u2013 31 Oct 2026",
        "de-DE": "25.\u201331. Okt. 2026",
        "fr-FR": "25\u201331 oct. 2026",
        "ja-JP": "2026/10/25\uff5e2026/10/31",
        "ko-KR": "2026\ub144 10\uc6d4 25\uc77c~31\uc77c",
      },
      (locale) =>
        formatPreviousSpan(
          { start: "2026-10-25", end: "2026-11-01" },
          { start: "2026-11-01", end: "2026-11-08" },
          locale,
        ),
    );
  });
});

describe("partial-period labels in the project locale", () => {
  const found = GALLERY.find((v) => v.variant === "line-incomplete-mark")?.data;
  if (!found) throw new Error("no gallery variant line-incomplete-mark");
  const data: DashboardData = found;
  const block = data.blocks[0] as LineData;
  const covered = (last: string, asOf: string) => (locale: string) => {
    if (block.axis.kind !== "time") throw new Error("unexpected variant");
    const buckets = [...block.axis.buckets.slice(0, -1), last];
    const moved = { ...block, axis: { ...block.axis, buckets } };
    const ctx = {
      data: { ...data, locale, asOf },
      theme: DEFAULT_THEME,
      paint: { attrs: () => "" },
    };
    return chartRuntimeData(moved, ctx).headers.at(-1);
  };

  it("leaves out the year inside the as-of year", () => {
    each(
      {
        "en-US": "Sep 21 \u2013 23",
        "en-GB": "21 \u2013 23 Sept",
        "de-DE": "21.\u201323. Sept.",
        "fr-FR": "21\u201323 sept.",
        "ja-JP": "09/21\uff5e09/23",
        "ko-KR": "9\uc6d4 21\uc77c~23\uc77c",
      },
      covered("2026-09-21", "2026-09-24"),
    );
    each(
      {
        "en-US": "Sep 29 \u2013 Oct 1",
        "en-GB": "29 Sept \u2013 1 Oct",
        "de-DE": "29. Sept. \u2013 1. Okt.",
        "fr-FR": "29 sept. \u2013 1 oct.",
        "ja-JP": "09/29\uff5e10/01",
        "ko-KR": "9\uc6d4 29\uc77c~10\uc6d4 1\uc77c",
      },
      covered("2026-09-29", "2026-10-02"),
    );
  });

  it("shows the year when it differs from the as-of year", () => {
    each(
      {
        "en-US": "Sep 21 \u2013 23, 2026",
        "en-GB": "21 \u2013 23 Sept 2026",
        "de-DE": "21.\u201323. Sept. 2026",
        "fr-FR": "21\u201323 sept. 2026",
        "ja-JP": "2026/09/21\uff5e2026/09/23",
        "ko-KR": "2026\ub144 9\uc6d4 21\uc77c~23\uc77c",
      },
      covered("2026-09-21", "2027-01-04"),
    );
    each(
      {
        "en-US": "Dec 30, 2026 \u2013 Jan 1, 2027",
        "en-GB": "30 Dec 2026 \u2013 1 Jan 2027",
        "de-DE": "30. Dez. 2026 \u2013 1. Jan. 2027",
        "fr-FR": "30 d\u00e9c. 2026 \u2013 1 janv. 2027",
        "ja-JP": "2026/12/30\uff5e2027/01/01",
        "ko-KR": "2026\ub144 12\uc6d4 30\uc77c~2027\ub144 1\uc6d4 1\uc77c",
      },
      covered("2026-12-30", "2027-01-02"),
    );
  });
});

describe("date range texts the page embeds", () => {
  it("records what a render formats, and formats a recorded range with that text", () => {
    const week = { start: "2026-10-25", end: "2026-11-01" };
    const { result, ranges } = recordRanges(() => formatSpan(week, "ko-KR"));
    expect(Object.values(ranges)).toEqual([result]);
    useRanges(Object.fromEntries(Object.keys(ranges).map((key) => [key, "built"])));
    try {
      expect(formatSpan(week, "ko-KR")).toBe("built");
      expect(formatSpan({ start: "2026-10-24", end: "2026-11-01" }, "ko-KR")).not.toBe("built");
      expect(formatSpan(week, "en-US")).toBe("Oct 25 – 31, 2026");
    } finally {
      useRanges({});
    }
  });

  it("records nothing outside a render", () => {
    recordRanges(() => formatSpan({ start: "2026-10-25", end: "2026-11-01" }, "de-DE"));
    expect(recordRanges(() => "").ranges).toEqual({});
  });
});
