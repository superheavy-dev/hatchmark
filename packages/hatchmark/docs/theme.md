# Theme

Every dashboard renders with the Default theme. Its tokens live in [src/render/themes/default.json](../src/render/themes/default.json), and the renderer reads them through `src/render/theme.ts`. Light and dark follow the viewer's system setting; `?theme=light` or `?theme=dark` on a page forces one.

## Series colours

Series take eight categorical slots, c1 to c8, in a fixed order, and wrap after the eighth. Each slot has two colours:

- **Stroke** (`data.<mode>.categorical`) paints lines, points, line legend keys and series-coloured text.
- **Fill** (`data.<mode>.categoricalFill`) paints bars, stacked and 100% segments, areas, pie and donut slices, and square legend keys.

Slot n is the same hue family in both sets, so a series keeps its colour when one card draws it as a line and another as bars. Every stroke and fill is at least 3:1 against the card in both modes, and the slots stay apart under deuteranopia, protanopia and tritanopia simulation; `checks.<mode>` in the tokens file records the measured numbers, and `test/render/tokens.test.ts` recomputes them.

## Series groups

A group of related series (see [components/groups.md](components/groups.md)) takes one of three hue
families, in this order: blue (slots 1 and 5), pink and red (slots 2, 6 and 8), and green (slot 4).
Each family has three lightness steps as strokes and fills, in light and dark (`data.groups`), and
step 1 stays close to the family's base slot colour, moving only so that steps 2 and 3 always recede
(`checks.<mode>.groupCVD.leadVsBase` records how far). Slot 3 (cyan) and slot 7 (warm grey) host no group: cyan
cannot step in lightness without running into the blues, and grey steps would read as context.
While a group holds a family, ungrouped series skip its slots.

Every step is at least 3:1 against the card; every pair of steps in a family is at least ΔE2000 10
apart, and every step is at least 8 from the other families, from the ungrouped slots outside its
family and from the context grey, under normal vision and deuteranopia, protanopia and tritanopia
simulation. `checks.<mode>.groupContrastVsCard` and `checks.<mode>.groupCVD` record the measured
numbers, and `test/render/tokens.test.ts` recomputes them.

Categorical colours are adapted from the FT's g-chartcolour.

## Block heights

`blockHeight` in the tokens file sets what each `height` preset means, separately for desktop
(layouts 600 px and wider) and phone. `default` is the height every block had before presets.

| Token           | What it sets                                      | compact (desktop / phone) | default     | tall        |
| --------------- | ------------------------------------------------- | ------------------------- | ----------- | ----------- |
| `chart`         | Chart height in px; a key or more bars adds to it | 200 / 180                 | 280 / 230   | 400 / 320   |
| `pie`           | Largest pie or donut diameter in px               | 160 / 150                 | 240 / 240   | 360 / 280   |
| `kpiSize`       | KPI figure font size in px                        | 22 / 18                   | 28 / 20     | 36 / 24     |
| `kpiLineHeight` | KPI figure line height in px                      | 28 / 24                   | 32 / 28     | 44 / 32     |
| `sparkline`     | KPI sparkline height in px                        | 21 / 20                   | 24 / 24     | 33 / 28     |
| `tableRows`     | Body rows a table shows before it scrolls         | 7.5 / 7.5                 | 15.5 / 15.5 | 25.5 / 18.5 |

The values keep every chart legible at each preset: a compact plot still has three value ticks and
room for its key and tooltip, a pie's largest diameter follows the preset (on phones the card's width caps it first), and
a KPI sparkline keeps about three quarters of its figure's line height. A tall table on a phone
stops at 18.5 rows so its scroll area never fills the screen.
