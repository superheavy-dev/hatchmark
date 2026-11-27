# Hatchmark

Hatchmark is an open-core, agent-first dashboard renderer. An agent writes a short JSON spec; Hatchmark owns the look, the metric definitions, and the checks.

Status: early design. Nothing to install yet.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs and request features.

## Repository layout

```
packages/
└─ hatchmark/   # the published package: spec, compiler, diagnostics, CLI
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

## License

Hatchmark is licensed under the [Apache License 2.0](LICENSE).
