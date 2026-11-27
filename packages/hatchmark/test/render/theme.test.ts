import { expect, test } from "vitest";
import { colorValue, DEFAULT_THEME, type Theme } from "../../src/render/theme.js";

test("fill slots resolve to the fill set", () => {
  expect(colorValue(DEFAULT_THEME, "light", "f2")).toBe(DEFAULT_THEME.categoricalFill?.light[1]);
  expect(colorValue(DEFAULT_THEME, "dark", "c2")).toBe(DEFAULT_THEME.categorical.dark[1]);
});

test("a theme without a fill set fills with its strokes", () => {
  const { categoricalFill: _, ...rest } = DEFAULT_THEME;
  const theme: Theme = { ...rest, categorical: { light: ["#225544"], dark: ["#88ccaa"] } };
  expect(colorValue(theme, "light", "f1")).toBe("#225544");
  expect(colorValue(theme, "dark", "f3")).toBe("#88ccaa");
});
