import { FONT_FILES, pageHead, renderFragment } from "../src/render/index.js";
import { GALLERY } from "./variants.js";

/** One tile of the preview gallery, in the shape packages/preview/src/entries.ts takes. */
export interface GalleryEntry {
  component: string;
  variant: string;
  title: string;
  html: string;
}

/**
 * Every gallery variant rendered with the renderer's own functions, in display order. Each tile is
 * its own .hm-root, so container queries pick the layout that fits the tile, and dark mode follows
 * data-theme="dark" on the html element.
 */
export function galleryEntries(): GalleryEntry[] {
  return GALLERY.map((v) => ({
    component: v.component,
    variant: v.variant.startsWith(`${v.component}-`)
      ? v.variant.slice(v.component.length + 1)
      : v.variant,
    title: v.title,
    html: renderFragment(v.data),
  }));
}

/**
 * The markup the gallery's head needs once: font faces, styles, the theme switch and the runtime,
 * loaded from `base`, a directory holding the font files and hatchmark.js.
 */
export function galleryHead(base: string): string {
  return pageHead({
    runtime: `${base}hatchmark.js`,
    fonts: Object.fromEntries(FONT_FILES.map((f) => [f.file, `${base}${f.file}`])),
  });
}
