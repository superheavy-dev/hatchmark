# Theme

Every dashboard renders with the Default theme. Its tokens live in [src/render/themes/default.json](../src/render/themes/default.json), and the renderer reads them through `src/render/theme.ts`. Light and dark follow the viewer's system setting; `?theme=light` or `?theme=dark` on a page forces one.

## Series colours

Series take eight categorical slots, c1 to c8, in a fixed order, and wrap after the eighth. Each slot has two colours:

- **Stroke** (`data.<mode>.categorical`) paints lines, points, line legend keys and series-coloured text.
- **Fill** (`data.<mode>.categoricalFill`) paints bars, stacked and 100% segments, areas, pie and donut slices, and square legend keys.

Slot n is the same hue family in both sets, so a series keeps its colour when one card draws it as a line and another as bars. Every stroke and fill is at least 3:1 against the card in both modes, and the slots stay apart under deuteranopia, protanopia and tritanopia simulation; `checks.<mode>` in the tokens file records the measured numbers, and `test/render/tokens.test.ts` recomputes them.

Categorical colours are adapted from the FT's g-chartcolour.
