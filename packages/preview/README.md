# @hatchmark/preview

Builds the component preview gallery that every pull request deploys. Private workspace package, never published; the `hatchmark` package does not depend on it.

## What it builds

`pnpm --filter @hatchmark/preview run site` (after `pnpm build`, which also builds the hatchmark CLI and runtime it uses) writes static files to `dist/site/`:

- `dist/site/index.html`: the gallery shell. A toolbar switches between light and dark and between desktop and a 390 px frame. The gallery renders inside an iframe, so at 390 px its own viewport is 390 px wide and mobile media queries really apply. The state lives in the URL hash (`#theme=dark&width=mobile`), so a link reproduces what the reviewer saw. `section` names a gallery section or figure id: `#section=pie&theme=dark&width=mobile` loads `components/#pie` in the frame and scrolls there. The section stays in the hash when the toolbar changes, follows the gallery's own navigation links, and is left out when there is none. A query string on the shell (preview-only switches such as `?scroll=thin`) is passed on to the framed page in either view.
- `dist/site/components/index.html`: every registered entry, grouped by component, or "No components yet" with the build info. Opened as the top-level page rather than inside the shell's frame, it redirects to the shell and carries its query string and its fragment as the section (`/components/?scroll=thin#pie` becomes `/?scroll=thin#section=pie`), so every link to a section gets the toolbar. Inside the frame it is not the top window, so it never redirects there and the shell cannot loop.
- `dist/site/404.html`.

The output is deterministic: the same entries give the same bytes. Only the build info changes, read from `PREVIEW_PR` (pull request number) and `PREVIEW_SHA` (full commit sha).

## Plug-in point for the renderer

`src/entries.ts` exports two things the renderer fills:

- `entries`: an array of `{ component, variant, title, html }`, in display order. `component` and `variant` are lowercase ids with dashes (`kpi`, `with-delta`); a component/variant pair may appear once. `html` must come from hatchmark's own render functions on realistic US/global sample data, never hand-written markup, so the gallery shows exactly what users get. Register every variant, including empty, negative and long-label cases.
- `head`: markup added once to the gallery's `<head>`, such as the theme stylesheet and the runtime script interactions need.

The shell sets `data-theme="light"` or `data-theme="dark"` on the `<html>` element of the framed page, so rendered output should key its dark theme on `[data-theme="dark"]`.

`entries.ts` imports `packages/hatchmark/gallery/entries.ts` by relative path, and tsc compiles that gallery with the render sources it uses into `dist/lib/` (hence `rootDir: ".."` and the d3 and zod dependencies here). The fixtures therefore never enter the published `hatchmark` package. The builder copies the fonts and the runtime into `site/_hatchmark/`.

The example dashboard is built with `hatchmark build --cwd packages/hatchmark/examples/global-sales --out dist/site/dashboard`, run from `src/build.ts`. The builder also builds copies of the example with `locale` set to de-DE (week from Monday) and ja-JP into `dist/site/dashboard-de-DE/` and `dist/site/dashboard-ja-JP/`. The shell's View toggle switches the frame between the components and the dashboard (`#view=dashboard`), and its Dashboard locale toggle picks the en-US, de-DE or ja-JP build for the dashboard and picker views (`#locale=de-DE`; en-US is left out of the hash). `#view=period` opens the example's date range picker (`dashboard/explorer/`), and `#view=periods` lists the picker's other variants, built from `src/periods.ts` into `dist/site/periods/` (presets only, a distinct count that needs a preset, fixed-date presets).

## Deploy

Two workflows with stable job names:

- `.github/workflows/preview.yml`, job `preview-build` (`contents: read`, no secrets). It runs on every pull request, every push to main and in the merge queue, and is the required check. It checks out the code, installs, runs this builder and uploads the `preview-site` artifact: `site/` and `preview.json` (`{ event, pr, sha }`).
- `.github/workflows/preview-deploy.yml`, job `preview-deploy`. It is triggered by `workflow_run` when `preview-build`'s workflow succeeds for a same-repository pull request or a push to main. GitHub runs it from the default branch's copy of the file, so a pull request cannot change it. It runs in the `preview` Environment, which holds the Cloudflare secrets, with `actions: read`, `pull-requests: write` and `statuses: write`.
  1. It downloads the artifact into its own directory and treats it as data. The sha must be 40 hex characters and equal the run's `head_sha`; the event must match the run's; the PR number must be an integer listed in the run's `pull_requests` (when GitHub fills it); and the pull request's current head, read from the API, must be this sha in this repository. A pull request that has moved on is skipped, because its newer run deploys.
  2. It installs `wrangler@<pinned version>` with `--ignore-scripts` into a separate tool directory and writes the Worker config (a static-assets-only Worker named `hatchmark-preview`) in a separate temporary directory, pointing `assets.directory` at the artifact. Nothing from the artifact is executed.
  3. Pull request: `wrangler versions upload --preview-alias pr-<number>`, leaving production untouched. The stable URL is `https://pr-<number>-hatchmark-preview.hatchmark.workers.dev`, and wrangler also returns a URL for the exact version. Push to main: `wrangler deploy`, so `https://hatchmark-preview.hatchmark.workers.dev` shows main's gallery.
  4. It reports a `preview-deploy` commit status on the built sha, linking to the URL. It is advisory, because a `workflow_run` job does not appear among a pull request's checks. For pull requests it also creates or updates one sticky comment with the URL and the sha.

Missing credentials fail the job and the status, except for Dependabot runs, which get no secrets and skip with a notice. Pull requests from forks never reach the deploy job.

Only a push to main runs `wrangler deploy`, and the first one creates the Worker with `workers_dev` and `preview_urls` on. The pull request path never deploys to production: if the Worker does not exist yet, wrangler stops with "You cannot upload a new version of a Worker that does not yet exist" (its mapping of Cloudflare errors 10007 and 10090), and the job fails with "Worker hatchmark-preview does not exist yet; it is created by the first push to main", which also becomes the `preview-deploy` status. URLs are read from the file wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`, not scraped from its logs.
