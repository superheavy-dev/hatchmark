# Hatchmark

Hatchmark is an open-core, agent-first dashboard renderer. An agent writes a short JSON spec; Hatchmark owns the look, the metric definitions, and the checks.

Status: early design. Nothing to install yet.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs and request features.

## Repository layout

```
packages/
├─ hatchmark/   # the published package: spec, compiler, diagnostics, CLI
└─ preview/     # private: per-pull-request component preview gallery
```

Hatchmark ships as one npm package, `hatchmark`, so a user installs one thing and the CLI, the schemas and the bundled docs always share one version. Modules inside it (`spec`, `diagnostics`, `compiler`, `cli`) keep their own directories. The repository is a pnpm workspace so that code which must stay separate later, such as the browser runtime or the agent benchmark, can live beside it as its own package.

## Development

Requires Node.js 22.12 or later and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm lint        # Biome: lint and format check
pnpm format      # apply formatting and safe lint fixes
pnpm typecheck
pnpm build
pnpm test        # Vitest
```

CI runs lint, typecheck with build, and tests on Node 22 and the current LTS for every pull request.

### JSON Schemas

`packages/hatchmark/schema/*.schema.json` are generated from the Zod schemas in `packages/hatchmark/src/spec/` by `pnpm gen:schema` and committed; a test fails when they drift. Only schemas named with `.meta({ id: "Format" })` become `$defs` entries, under that name, and everything else is inlined. Name a schema when it is a real concept that several fields share or that editors and agents should recognise (a block, a filter, a period range), using a PascalCase name unique across the spec, and leave small one-off fields inline. The shipped names are listed in `test/spec/json-schema.test.ts`, so adding, renaming or removing one is an explicit change there. A recursive schema must be named: an unnamed one would get a generated `__schemaN` name, which a test rejects.

### Component previews

Every pull request gets a deployed gallery of every component variant, light and dark, desktop and 390 px, on Cloudflare Workers. `preview-build` (`.github/workflows/preview.yml`) builds the static site without secrets and uploads it as an artifact. `preview-deploy` (`.github/workflows/preview-deploy.yml`, triggered by `workflow_run` and always run from main's copy) validates the artifact as data and deploys it. Each pull request gets a stable URL, `https://pr-<number>-hatchmark-preview.hatchmark.workers.dev`, posted as a comment that updates on every push and reported as a `preview-deploy` commit status; main deploys to `https://hatchmark-preview.hatchmark.workers.dev`. Components appear once the renderer registers them in [`packages/preview/src/entries.ts`](packages/preview/src/entries.ts); see [packages/preview/README.md](packages/preview/README.md) for the plug-in point and how deploys work.

## License

Hatchmark is licensed under the [Apache License 2.0](LICENSE).
