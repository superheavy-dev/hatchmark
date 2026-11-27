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
 * The plug-in point for the renderer: every gallery entry, in display order. Empty until
 * `src/render` exists in the hatchmark package; see README.md next to this package.
 */
export const entries: readonly GalleryEntry[] = [];

/** Markup added once to the gallery's `<head>`, such as the theme stylesheet and runtime script the entries need. */
export const head = "";
