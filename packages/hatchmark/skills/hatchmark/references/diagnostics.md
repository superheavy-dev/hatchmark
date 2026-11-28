# Diagnostics

Full reference: `hatchmark docs diagnostics`. One code: `hatchmark explain <code>`.

- Codes are stable. Ranges: HM0xxx command line, HM1xxx files and YAML syntax, HM2xxx references
  between files and to data, HM3xxx spec shape, HM4xxx data rules, HM5xxx design rules, HM9xxx
  internal errors.
- `hatchmark check` picks its exit code by this rule, first match wins:
  1. 2 when any error is in `hatchmark.yaml` and is not an environment error.
  2. 3 when every error is an environment error: HM1001 (a file cannot be read) or HM2010 (a data
     file that does not exist).
  3. 1 when there is any other error, or any warning with `--strict`.
  4. 0 otherwise.

  So a missing data file together with an error in a metric exits 1, not 3. Without a
  `hatchmark.yaml`, check exits 2.
- Notes such as the HM4040 default notes say which default applies. The JSON report always lists
  every note; `hatchmark check --explain-defaults` prints them in full in human output.
- A diagnostic's `help` and `expected` say what would be valid. A `fix` replaces a range with
  text; apply fixes from the end of a file backwards, or run check again after each edit,
  because ranges refer to the text that was checked.
- Exit 4 is a Hatchmark bug: report it with the output.

YAML rules that trip agents up are in `hatchmark docs diagnostics#yaml-syntax`: spaces not tabs,
quote values that contain `: ` or start with characters such as `{`, `[` or `*`, and no anchors,
aliases, merge keys or tags other than the YAML core ones.
