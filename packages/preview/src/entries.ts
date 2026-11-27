import { galleryEntries, galleryHead } from "../../hatchmark/gallery/entries.js";

/** One rendered variant of a component: one tile in the preview gallery. */
export interface GalleryEntry {
  /** Component id such as `kpi` or `line`; entries with the same id are grouped. Lowercase letters, digits and dashes. */
  component: string;
  /** Variant id, unique within its component, such as `with-delta`. Lowercase letters, digits and dashes. */
  variant: string;
  /** Human title of the variant, shown above the tile. */
  title: string;
  /** The rendered component, produced by hatchmark's own render functions on sample data. Inserted as is. */
  html: string;
}

/**
 * The plug-in point for the renderer: every gallery entry, in display order, rendered by the
 * hatchmark package's own render functions from its gallery fixtures (compiled from source, so the
 * fixtures never enter the published package).
 */
export const entries: readonly GalleryEntry[] = galleryEntries();

/** Markup added once to the gallery's `<head>`: the theme styles, fonts and runtime script, served from `_hatchmark/` at the site root. */
export const head = galleryHead("../_hatchmark/");
