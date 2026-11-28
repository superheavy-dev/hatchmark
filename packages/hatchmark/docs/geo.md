# Map boundaries

Hatchmark draws choropleth maps from two built-in geographies: `us-states` and `world-countries`. Both ship as pre-projected SVG paths, so a map needs no projection code or boundary download at run time, and each geography module stays under 40 KB gzipped.

## Sources

| Geography         | Source                                                                                                                                | Version                               | Licence                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------- |
| `us-states`       | U.S. Census Bureau cartographic boundary files, via [us-atlas](https://github.com/topojson/us-atlas) `states-10m.json`                | us-atlas 3.0.1 (`us-atlas@3.0.1+hm1`) | Census data: public domain; us-atlas: ISC |
| `world-countries` | [Natural Earth](https://www.naturalearthdata.com/) 1:110m admin 0 countries; names and codes of smaller countries from the 1:10m file | 5.1.2 (`natural-earth@5.1.2+hm1`)     | Public domain                             |

`scripts/build-boundaries.ts` (`pnpm gen:boundaries`) downloads the files at pinned versions, checks their SHA-256, projects them, simplifies them and writes `src/geo/us-states.ts`, `src/geo/world-countries.ts` and `src/geo/world-codes.ts`. The `+hm1` suffix numbers Hatchmark's own processing of a source version. Simplification is Visvalingam's area method on the projected shapes, with every point shared by two regions kept or dropped on both sides together, so neighbours never open gaps or overlap. Coordinates are rounded to 0.1 viewBox units.

## Region ids

- `us-states`: the USPS code, such as `CA` or `DC`.
- `world-countries`: the ISO 3166-1 alpha-3 code, such as `USA`. Natural Earth leaves out the ISO code of France and Norway in its main column; Hatchmark reads them from Natural Earth's fallback column, so they are `FRA` and `NOR`. Regions with no ISO code use Natural Earth's `ADM0_A3` code: Kosovo is `KOS`, Northern Cyprus `CYN` and Somaliland `SOL`.

Every region also has an English display name ("California", "United States", "Côte d'Ivoire"), a label point inside its largest polygon, and its projected area in viewBox units squared, so a renderer can tell when a region is too small to label in place.

## Projections

**us-states** uses an Albers equal-area conic projection (standard parallels 29.5° and 45.5°, as in Albers USA) for the lower 48 states and DC, in a 975 × 610 viewBox. Alaska, Hawaii and Puerto Rico sit in boxed insets along the bottom left: Alaska at 0.3 times the main scale, Hawaii at the main scale and Puerto Rico at 1.25 times, so it stays visible. The strip right of the map is kept free for labels of the states too small to label in place (VT, NH, MA, RI, CT, NJ, DE, MD and DC): each has a `leader` position in a column there, ordered top to bottom, for a leader line from its label point.

**world-countries** uses the Equal Earth projection, 975 wide. Antarctica is removed and the empty southern ocean is cropped. Shapes that cross the antimeridian (Russia, Fiji) are cut at it rather than wrapped.

## Territories and small countries

Puerto Rico is drawn as an inset. Guam, the U.S. Virgin Islands, American Samoa and the Northern Mariana Islands are not drawn: at this scale each would be a few pixels, and drawing them would take four more insets. They are listed in the geography's `notDrawn`, so rows naming them are reported as "not drawn" instead of "unmatched".

The world map draws what Natural Earth's 1:110m file contains. Countries and territories too small for it (Singapore, Malta, Andorra, Bahrain, Hong Kong and others), the ISO territories Natural Earth includes in another country (French Guiana, Réunion, Svalbard and others), and Antarctica are listed in `notDrawn` and matched the same way.

## Disputed areas

Boundaries follow Natural Earth's default, de facto lines; Hatchmark does not edit the geometry. In the 1:110m data this means:

- Crimea is drawn as part of Russia.
- Kashmir is divided along the lines of actual control: the Indian-administered part with India, the Pakistani-administered part with Pakistan, Aksai Chin with China.
- Western Sahara (`ESH`) covers the area east of the Moroccan berm; the area west of it is drawn with Morocco.
- Taiwan (`TWN`), Kosovo (`KOS`), Northern Cyprus (`CYN`) and Somaliland (`SOL`) are drawn as their own regions.
- The Golan Heights are drawn with Israel.

## Matching rows to regions

A map's region column is matched to region ids through an alias table per geography:

- `us-states`: USPS code, full name, FIPS code with or without the leading zero (`06`, `6`), ISO 3166-2 (`US-CA`), and common abbreviations (`Calif.`, `Mass.`, `N.Y.`, `Wash. D.C.`, `Washington DC`, `D.C.`).
- `world-countries`: ISO alpha-2, alpha-3 and numeric codes (with or without leading zeros), Natural Earth's name fields, and common, World Bank, IMF and UN styles such as `UK`, `Russian Federation`, `Korea, Rep.`, `Türkiye`, `Lao PDR`, `Gambia, The` and `Hong Kong SAR, China`. Kosovo also matches `XK` and `XKX`.

Before matching, values are normalized:

1. A code is ASCII digits, optionally with a zero fraction (`06`, `6.0`), with or without spaces around it. It loses its leading zeros (`006` → `6`), so a DOUBLE column of FIPS or ISO numeric codes matches like an integer one.
2. Anything else is a name. A fixed fold table spells out letters that have no accent to strip: `ß` → `ss`, `æ` → `ae`, `ø` → `o`, `ł` → `l`, ligatures such as `ﬁ`, and full-width letters.
3. Accents are removed, the text is lowercased, `&` becomes "and", every run of other characters (spaces, punctuation, apostrophes) becomes one space, and the ends are trimmed.
4. A name left without letters never matches: signed or bracketed numbers (`-6`, `−06`, `+6`, `(6)`, `6-`), full-width digits (`６`) and decimals (`6.5`) are reported as unmatched rather than read as a code.

So `Côte d’Ivoire`, `COTE-D'IVOIRE` and `cote d ivoire` are the same key. The same normalization runs in DuckDB when a query groups or joins by region, and a test checks that both give the same key for every Unicode character.

An alias that names more than one region is never matched: `Congo` (COD or COG), `Korea` (KOR or PRK) and `Virgin Islands` (VGB or VIR) on the world map, `Carolina` and `Dakota` on the US map. A value that matches nothing gets up to three suggestions, the regions whose names are a likely typo away ("Calfornia" suggests CA). Netherlands rows must say "Netherlands", not "Holland".
