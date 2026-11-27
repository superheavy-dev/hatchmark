# Hatchmark brand assets

The final Hatchmark logo, 05-B "Contained strike". These files are byte-for-byte copies of the design handoff; never edit, recolour or re-export them here. A new version replaces them from the handoff.

| File | Use |
| --- | --- |
| `hatchmark-lockup-horizontal-light.svg` | Horizontal lockup (mark plus wordmark) on light backgrounds, ink #171717 |
| `hatchmark-lockup-horizontal-dark.svg` | Horizontal lockup on dark backgrounds, #EDEDED, drawn thinner |
| `hatchmark-mark-light.svg` | Mark alone on light backgrounds, ink #171717 |
| `hatchmark-mark-dark.svg` | Mark alone on dark backgrounds, #EDEDED, drawn thinner |
| `favicon.svg` | Favicon; switches to #EDEDED under `prefers-color-scheme: dark` |
| `favicon-16.png`, `favicon-32.png`, `favicon.ico` | Pixel-snapped favicon fallbacks (the ICO holds 16 and 32 px) |
| `apple-touch-icon-180.png` | Apple touch icon, 180 × 180 on white |

Usage rules:

- Use the horizontal lockup, the mark alone or the wordmark alone. There is no stacked lockup.
- The wordmark is always "Hatchmark" with an uppercase H.
- Use the dark file on dark backgrounds; never recolour a light file to white.
- Clear space: lockup and wordmark keep the wordmark's cap height clear on every side; the mark alone keeps a quarter of its height.
- Minimum sizes: mark 16 px (below 24 px use the favicon files), lockup 96 px wide, wordmark 72 px wide.
- The logo never appears in dashboards Hatchmark renders or in `hatchmark build` output.

The repository README uses the lockup. The pull request preview site (`packages/preview`) copies the favicons and the mark into its build and shows the mark alone in its header.
