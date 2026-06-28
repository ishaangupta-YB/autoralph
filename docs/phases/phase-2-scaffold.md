# Phase 2 - Project scaffold

## Goal

Stand up the repository skeleton, tooling, and metadata so later phases can land
code that is immediately lint-clean, type-checked, bundled, and CI-verified.

## Constraints

- Bundled ESM output (`dist/cli.mjs`) via tsdown; `type: "module"`.
- Node 20+ (`engines.node >= 20`).
- MIT license; author "Ishaan Gupta"; GitHub owner `ishaangupta-yb`.
- Minimal runtime dependencies (only `commander`).
- No references to any reference project in metadata or docs.

## Logic / deliverables

- `package.json`: name `autoralph`, scripts for build/dev/lint/format/typecheck/
  test, `bin.autoralph -> dist/cli.mjs`, repository pointing at
  `github.com/ishaangupta-yb/autoralph`.
- `tsconfig.json` / `tsconfig.typecheck.json`: strict TypeScript, NodeNext
  module resolution.
- `tsdown.config.ts`: bundle `src/cli.ts` to `dist/cli.mjs` with a shebang and
  executable bit.
- `eslint.config.js` (flat config) + `.prettierrc`, with
  `eslint-config-prettier` to avoid rule conflicts.
- `vitest.config.ts`: 30s timeouts for process/git-heavy tests.
- `LICENSE` (MIT), `README.md`, `.gitignore`.
- `.github/workflows/ci.yml`: lint, format:check, typecheck, test on
  Ubuntu/macOS/Windows.

## Key variables / constants

- Package name: `autoralph`; version `0.1.0`.
- Build entry: `src/cli.ts`; build output: `dist/cli.mjs`.
- Test runner: vitest; bundler: tsdown.
