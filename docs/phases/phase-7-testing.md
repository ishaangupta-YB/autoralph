# Phase 7 - Testing & verification

## Goal

Comprehensively test the orchestration loop, error/script handling,
model/provider fallback, multi-agent orchestration, iteration/token caps, and
the real-time board, then verify lint, format, typecheck, build, and CI.

## Constraints

- Unit tests co-located as `*.test.ts`; e2e tests under `e2e/` against the built
  `dist/cli.mjs`.
- Prefer e2e for process/IO boundaries; unit-test pure helpers.
- No skipped or weakened tests; all must pass on Ubuntu/macOS/Windows.

## Coverage

Unit suites:

- `core/orchestrator.test.ts` - success/commit, reported-failure rollback,
  retryable backoff + iteration cap, permanent-error abort, token-cap
  mid-iteration abort, consecutive-failure abort, event/state emission.
- `core/git.test.ts` - branch/commit/reset/clean-tree helpers against real temp
  repos; `commitAll` empty + failure cases.
- `core/config.test.ts` - precedence (defaults < file < env < flags), Cloudflare
  env sourcing, bootstrap.
- `core/run.test.ts` - run-dir creation, notes append, `.git/info/exclude`.
- `core/prompt.test.ts`, `core/slug.test.ts` - prompt assembly, slug/run id.
- `agents/claude.test.ts` - JSON result parsing, usage, permanent markers,
  no-result failure (fake `spawnFn`).
- `agents/opencode.test.ts` - provider config build, model fallback, error
  classification, JSON recovery (fake `spawnFn`).
- `agents/cloudflare.test.ts`, `agents/json-extract.test.ts`,
  `agents/types.test.ts`, `agents/simulation.test.ts` - helpers and the
  scripted agent.
- `board/hub.test.ts` - multi-run aggregation, log bounding, snapshot ordering.
- `board/server.test.ts` - routes, snapshot, SSE framing.

End-to-end suites (`e2e/`):

- `board.e2e.test.ts` - `demo` command serves `/`, `/healthz`, `/api/state`, and
  an SSE frame over real HTTP on an ephemeral port.
- `run.e2e.test.ts` - a full loop driven by a fake `opencode` binary that writes
  files and prints JSON; asserts two iteration commits land and the summary
  prints (skipped on Windows because the fake relies on a shebang).

## Shared test infrastructure

`src/test-utils.ts`: `makeTempRepo` (throwaway git repo), `gitLog`, and
`finishChild(child, code)` which drains a fake child's stdout/stderr before
emitting `close`, mirroring real process ordering so streamed output is observed
before completion.

## Verification gate

```sh
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm test          # all unit + e2e suites
pnpm run test:e2e
```

CI runs the same gate on Ubuntu/macOS/Windows.
