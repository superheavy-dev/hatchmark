# Diagnostics

Full reference: `hatchmark docs diagnostics`. One code: `hatchmark explain <code>`.

- Codes are stable. Ranges: HM0xxx command line, HM1xxx files and YAML syntax, HM2xxx references
  between files and to data, HM3xxx spec shape, HM4xxx data rules, HM5xxx design rules, HM9xxx
  internal errors.
- Errors fail `hatchmark check` with exit 1. Warnings do not, unless `--strict`. Notes such as the
  HM4040 default notes say which default applies; `hatchmark check --explain-defaults` lists them.
- A diagnostic's `help` and `expected` say what would be valid. A `fix` replaces a range with
  text; apply fixes from the end of a file backwards, or run check again after each edit,
  because ranges refer to the text that was checked.
- Exit code 3 is the environment (such as a data file that does not exist), not your YAML. Exit 4 is
  a Hatchmark bug: report it with the output.

YAML rules that trip agents up are in `hatchmark docs diagnostics#yaml-syntax`: spaces not tabs,
quote values that contain `: ` or start with characters such as `{`, `[` or `*`, and no anchors,
aliases or tags.
