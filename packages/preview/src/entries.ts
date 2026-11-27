import { galleryEntries, galleryHead } from "../../hatchmark/gallery/entries.js";

export interface GalleryEntry {
  component: string;
  variant: string;
  title: string;
  html: string;
}

export const entries: readonly GalleryEntry[] = galleryEntries();

export const head = galleryHead("../_hatchmark/");
