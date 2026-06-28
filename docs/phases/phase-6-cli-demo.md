# Phase 6 - CLI & demo

## Goal

Wire everything together behind a `commander` CLI: parse flags, resolve config,
select the run mode, start the board, drive the orchestrator, and provide a
zero-credential `demo` command.

## Constraints

- Flags override config; runtime-only limits are not persisted.
- `--max-iterations`, `--max-tokens`, `--board-port` must be validated as
  positive integers.
- The demo must showcase success, failure/rollback, and retry/backoff without
  any external agent or credentials.

## Logic

- **`runObjective`** - validates the git repo, resolves config from CLI
  overrides, selects a fresh `autoralph/<slug>` branch (probing suffixes) or the
  current branch, calls `setupRun`, builds the schema and agent, constructs the
  `Orchestrator`, starts the board, registers the run on the hub, installs
  signal handlers, runs the loop, prints a summary, and keeps the board live
  until interrupted.
- **`runDemo`** - starts a board and runs two `SimulationAgent`-backed
  orchestrators (a "claude" and an "opencode" script) concurrently against
  throwaway temp git repos, then keeps the board live until interrupted.
- **Signals** - `SIGINT` -> `handleInterrupt` (graceful, then force on second
  press); `SIGTERM` -> `stop` (force).
- **`printSummary`** - status, agent, branch, iterations, commits, ok/fail,
  tokens (prefixed `~` when estimated), and the board URL.

## CLI surface

```
autoralph [objective] [options]
autoralph demo [--board-port <n>] [--board-host <host>]
```

Options: `--agent`, `--model`, `--fallback-models`, `--max-iterations`,
`--max-tokens`, `--stop-when`, `--branch`, `--current-branch`, `--push`,
`--no-board`, `--board-port`, `--board-host`, `--commit-prefix`.

## Key variables / constants

- Demo: 2 orchestrators, `maxIterations: 4`, `backoffBaseMs: 1500`.
- Default board port `7654`, host `127.0.0.1`.
