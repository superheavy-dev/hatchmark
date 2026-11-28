# Map

A filled (choropleth) map: one metric per US state or per country, with a ranked bar list of the
same values beside it.

```yaml
type: map
title: Revenue per customer by state
geo: us-states
region: state
value: revenue_per_customer
```

| Field     | Meaning                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geo`     | `us-states` (50 states, DC and Puerto Rico) or `world-countries`. [geo.md](../geo.md) lists the sources, projections and which regions are drawn.                                       |
| `region`  | The column naming each row's region: a code (USPS, FIPS, ISO 3166 alpha-2, alpha-3 or numeric, ISO 3166-2) or an English name, matched ignoring case, accents, punctuation and spacing. |
| `value`   | The metric that colours each region. A rate, ratio or average reads well; a sum or a count mostly shows where people are (HM5040).                                                      |
| `scale`   | Optional. How values become colour classes; see below.                                                                                                                                  |
| `pair`    | Optional. `bars` (default) adds a ranked bar list of the same values, beside the map on wide cards and under it on narrow ones. `none` draws the map alone.                             |
| `missing` | Optional. `hatch` (default): regions without a value are drawn crosshatched on the land colour.                                                                                         |

Every region is computed once, from all rows whose value names it, as a table computes a row: a
ratio such as revenue per customer divides the region's revenue by its distinct customers, so rows
spelled `CA`, `California` and `06` count each customer once. Rows that name no region, name an
ambiguous one or name a region the map does not draw are left out of the map, the bar list and the
total, and each case gets its own warning. The dashboard period and select filters apply as for any
block.

## Scale

| Field      | Meaning                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`     | `quantile` (default): each class holds about as many regions. `threshold`: classes split at `breaks`. `linear`: equal-width classes from the lowest to the highest value.                                                                |
| `classes`  | 3 to 7, default 5. With `breaks` it is the number of breaks plus one and can be left out.                                                                                                                                                |
| `breaks`   | For `threshold`: ascending class boundaries in the metric's unit. A value equal to a break falls in the class above it.                                                                                                                  |
| `midpoint` | Makes the scale diverging, for change, margin or a gap to a target: one hue below the midpoint, another above, and with an odd number of classes a neutral middle class. Needs 4 or more classes; a quantile scale needs an even number. |

Sequential classes run from a pale to a dark step of one hue, and diverging ones from one hue
through grey to another; neither uses red and green. When regions share values so that two class
boundaries coincide, the classes merge rather than leave an empty colour in the legend.

## What it draws

- The regions coloured by class, with thin card-coloured borders. The US map boxes Alaska, Hawaii
  and Puerto Rico in insets and, where the card is wide enough for the text, labels the small
  north-eastern states and DC in a column to the right, each with a leader line and its colour
  swatch.
- A legend above the map: one swatch per class with every boundary labelled, and a crosshatched "No
  data" swatch.
- The bar list, highest value first, with the same numbers as the map.
- Hovering or tapping a region or a bar list row highlights both, and the tooltip names the region
  and gives its value, rank and, for a sum or a count, its share of the total. The arrow keys step
  through the regions in rank order, and a screen reader hears each one. Screen readers also get a
  summary and every region in a hidden table.
- A note under the map counts the rows that are not on it and names the values with the most ("Not
  on the map: 15 rows with Guam, Narnia.").

`hatchmark build --json` and `hatchmark check --json` carry the full match report under `maps`:
every distinct value of the region column, its rows, and the region it joined or why it joined none.

## Checks

| Code     | When                                                                                                                                                      | Fix                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `HM5040` | Warning. `value` is a sum or a count, so the map mostly repeats population.                                                                               | Map a ratio such as revenue per customer; the bar list still shows totals.           |
| `HM5041` | Build warning. Values match no region; the warning lists them with row counts and the closest regions.                                                    | Fix the values in the data or the source's SQL, or filter those rows out on purpose. |
| `HM5042` | Build warning. A value could name more than one region, such as "Congo" or "Korea".                                                                       | Use a code or the full name.                                                         |
| `HM5043` | Build warning. Values name regions the map does not draw, such as Guam or Singapore.                                                                      | Show them in a table or bar chart beside the map, or filter them out.                |
| `HM2032` | Error. A threshold scale's midpoint leaves more classes on one side than the other.                                                                       | Make the midpoint the middle break, or put it inside the middle class.               |
| `HM3007` | Error. `breaks` without `type: threshold`, `classes` that disagree with `breaks`, or a diverging scale with too few or an odd number of quantile classes. | Follow the message.                                                                  |
