# @hatchmark/preview

Builds the component preview gallery that every pull request deploys. Private workspace package, never published; the `hatchmark` package does not depend on it.

## What it builds

`pnpm --filter @hatchmark/preview run site` (after `pnpm build`) writes static files to `dist/`:

- `dist/site/index.html`: the gallery shell. A toolbar switches between light and dark and between desktop and a 390 px frame. The gallery renders inside an iframe, so at 390 px its own viewport is 390 px wide and mobile media queries really apply. The state lives in the URL hash (`#theme=dark&width=mobile`), so a link reproduces what the reviewer saw.
- `dist/site/components/index.html`: every registered entry, grouped by component, or "No components yet" with the build info.
- `dist/site/404.html`.
- `dist/placeholder/index.html`: the page production shows when a pull request has to create the Worker before main has deployed.

The output is deterministic: the same entries give the same bytes. Only the build info changes, read from `PREVIEW_PR` (pull request number) and `PREVIEW_SHA` (full commit sha).

## Plug-in point for the renderer

`src/entries.ts` exports two things the renderer fills:

- `entries`: an array of `{ component, variant, title, html }`, in display order. `component` and `variant` are lowercase ids with dashes (`kpi`, `with-delta`); a component/variant pair may appear once. `html` must come from hatchmark's own render functions on realistic US/global sample data, never hand-written markup, so the gallery shows exactly what users get. Register every variant, including empty, negative and long-label cases.
- `head`: markup added once to the gallery's `<head>`, such as the theme stylesheet and the runtime script interactions need.

The shell sets `data-theme="light"` or `data-theme="dark"` on the `<html>` element of the framed page, so rendered output should key its dark theme on `[data-theme="dark"]`.

To import render functions, add `"hatchmark": "workspace:*"` to this package's `dependencies` and import from `hatchmark`. Type-checking then needs `packages/hatchmark` built first.

The example dashboard is not part of the gallery yet. The renderer PR adds it: build it into `dist/site/dashboard/` from `src/build.ts` and add a view toggle to the shell.

## Deploy

`.github/workflows/preview.yml` has two jobs with stable names:

- `preview-build` (`contents: read`, no secrets) checks out the pull request, installs, runs this builder and uploads `dist/site` and `dist/placeholder` as the `preview-site` artifact. This is the required check; it also runs in the merge queue.
- `preview-deploy` (`pull-requests: write`, Cloudflare secrets) runs no code from the pull request: no checkout, no install, no repository scripts. It downloads the artifact, writes the Worker config inline (a static-assets-only Worker named `hatchmark-preview`), and runs `npx --yes wrangler@<pinned version>`.
  - Pull request: `wrangler versions upload --preview-alias pr-<number>`, leaving production untouched. The stable URL is `https://pr-<number>-hatchmark-preview.hatchmark.workers.dev`, and wrangler also returns a URL for the exact version. The job posts both as one sticky comment, updated in place on every push.
  - Push to main: `wrangler deploy`, so `https://hatchmark-preview.hatchmark.workers.dev` shows main's gallery. Missing credentials fail the job.
  - Pull requests from forks and Dependabot get no secrets; the job skips the deploy with a notice.

`versions upload` cannot create a Worker and does not turn on preview URLs. When the Worker does not exist yet, wrangler stops with "You cannot upload a new version of a Worker that does not yet exist" (its mapping of Cloudflare errors 10007 and 10090). The job then deploys the placeholder with `wrangler deploy`, which creates the Worker with `workers_dev` and `preview_urls` on, and retries the upload. URLs are read from the file wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`, not scraped from its logs.
