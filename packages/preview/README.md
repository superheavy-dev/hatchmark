# @hatchmark/preview

Builds and deploys the component preview gallery for every pull request. Private workspace package, never published; the `hatchmark` package does not depend on it.

## What it builds

`pnpm --filter @hatchmark/preview run site` (after `pnpm build`) writes a static site to `dist/site/`:

- `index.html`: the gallery shell. A toolbar switches between the component gallery and the example dashboard, light and dark, and desktop and a 390 px frame. The page renders inside an iframe, so at 390 px the content's own viewport is 390 px wide and mobile media queries really apply. The state lives in the URL hash (`#view=components&theme=dark&width=mobile`), so a link reproduces what the reviewer saw.
- `gallery.html`: every registered entry, grouped by component, or "No components yet" with the build info.
- `dashboard/`: the example dashboard, once it can be built (see below).
- `404.html`.

The output is deterministic: the same entries give the same bytes. Only the build info changes, read from `PREVIEW_PR` (pull request number) and `PREVIEW_SHA` (full commit sha).

## Plug-in point for the renderer

`src/entries.ts` exports two things the renderer fills:

- `entries`: an array of `{ component, variant, title, html }`, in display order. `component` and `variant` are lowercase ids with dashes (`kpi`, `with-delta`); a component/variant pair may appear once. `html` must come from hatchmark's own render functions on realistic US/global sample data, never hand-written markup, so the gallery shows exactly what users get. Register every variant, including empty, negative and long-label cases.
- `head`: markup added once to the gallery's `<head>`, such as the theme stylesheet and the runtime script interactions need.

The shell sets `data-theme="light"` or `data-theme="dark"` on the `<html>` element of the framed page, so rendered output should key its dark theme on `[data-theme="dark"]`.

To import render functions, add `"hatchmark": "workspace:*"` to this package's `dependencies` and import from `hatchmark`. Type-checking then needs `packages/hatchmark` built first.

## Example dashboard

When `packages/hatchmark/examples/global-sales` exists and `hatchmark --help --json` lists a `build` command, the site builder runs

```sh
hatchmark build --cwd packages/hatchmark/examples/global-sales --out dist/site/dashboard
```

and links the result. If the final flags differ, change the one call in `buildDashboard` in `src/build.ts`. A failing build fails the preview job rather than hiding the dashboard.

## Deploy

`src/deploy.ts` deploys `dist/site/` as a static-assets-only Cloudflare Worker named `hatchmark-preview` (`wrangler.jsonc`). `.github/workflows/preview.yml` runs it:

- Pull request: `wrangler versions upload --preview-alias pr-<number>`. Production traffic is untouched. The stable URL is `https://pr-<number>-hatchmark-preview.hatchmark.workers.dev`; wrangler also prints a URL for the exact version. The job posts both as one sticky comment on the pull request, updated in place on every push.
- Push to main: `wrangler deploy`, so `https://hatchmark-preview.hatchmark.workers.dev` shows main's gallery.
- Merge queue: builds the site, does not deploy, so the required `preview` check reports.

`versions upload` cannot create a Worker and does not turn on preview URLs. When the Worker does not exist yet, wrangler stops with "You cannot upload a new version of a Worker that does not yet exist" (it maps Cloudflare errors 10007 and 10090 to that message); the deploy script then first deploys a placeholder page with `wrangler deploy`, which creates the Worker with `workers_dev` and `preview_urls` on, then retries the upload.

Runs without Cloudflare credentials (pull requests from forks and Dependabot) build the site and skip the deploy with a notice. URLs are read from the file wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`, not scraped from its logs.
