import { describe, expect, it } from "vitest";
import { galleryEntries, galleryHead } from "../../gallery/entries.js";
import { GALLERY } from "../../gallery/variants.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe("gallery entries", () => {
  it("registers every variant once with valid ids", () => {
    const entries = galleryEntries();
    expect(entries).toHaveLength(GALLERY.length);
    expect(new Set(entries.map((e) => e.component))).toEqual(
      new Set([
        "kpi",
        "line",
        "bar",
        "stacked",
        "pie",
        "scatter",
        "table",
        "groups",
        "height",
        "map",
      ]),
    );
    for (const e of entries) {
      expect(e.component).toMatch(ID);
      expect(e.variant).toMatch(ID);
      expect(e.html.startsWith('<div class="hm-root">')).toBe(true);
    }
    expect(new Set(entries.map((e) => `${e.component}/${e.variant}`)).size).toBe(entries.length);
  });

  it("puts the styles, dark theme and runtime in the head", () => {
    const head = galleryHead("../_hatchmark/");
    expect(head).toContain(":root[data-theme=dark]");
    expect(head).toContain('<script defer src="../_hatchmark/hatchmark.js"></script>');
    expect(head).toContain('url("../_hatchmark/IBMPlexSans-Regular-Latin1.woff2")');
  });

  it("styles every colour class and map layout the gallery uses", () => {
    const head = galleryHead("");
    const html = galleryEntries()
      .map((e) => e.html)
      .join("");
    const used = new Set([...html.matchAll(/\bhm-(?:f|on)-[\w-]+/g)].map((m) => m[0]));
    expect([...used].filter((c) => !head.includes(`.${c}{`))).toEqual([]);
    for (const c of ["hm-map-body", "hm-map-frame", "hm-map-list"])
      expect(head).toContain(`.${c}{`);
  });
});
