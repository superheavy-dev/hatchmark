import { usedGeographies } from "../src/geo/index.js";
import { DEFAULT_THEME, FONT_FILES, pageHead, renderFragment } from "../src/render/index.js";
import { GALLERY } from "./variants.js";

export interface GalleryEntry {
  component: string;
  variant: string;
  title: string;
  html: string;
}

export function galleryEntries(): GalleryEntry[] {
  return GALLERY.map((v) => ({
    component: v.component,
    variant: v.variant.startsWith(`${v.component}-`)
      ? v.variant.slice(v.component.length + 1)
      : v.variant,
    title: v.title,
    html: renderFragment(v.data, undefined, usedGeographies(v.data.blocks)),
  }));
}

export function galleryHead(base: string): string {
  return pageHead(
    {
      runtime: `${base}hatchmark.js`,
      fonts: Object.fromEntries(FONT_FILES.map((f) => [f.file, `${base}${f.file}`])),
    },
    DEFAULT_THEME,
    { groups: true, maps: true, tiles: true, targets: true },
  );
}
