# Phase 3 - Core orchestration

## Goal

Implement the engine: the iteration loop, git operations, per-run state, config
resolution, prompt assembly, typed events, and structured logging.

## Constraints

- The orchestrator must not know about any UI; it only emits typed events.
- All git access through `execFileSync` with explicit argv (no shell strings).
- Run metadata stays out of version control.
- Limits and shutdown must be enforced precisely and observably.

## Logic

- **`orchestrator.ts`** - `Orchestrator extends EventEmitter`. Each iteration
  builds a prompt, runs the agent, then commits + appends notes (success),
  resets (reported failure), or classifies a thrown error
  (permanent / retryable / failure). Enforces `maxIterations` (between
  iterations), `maxTokens` (mid-iteration via `AbortController`), `stopWhen`
  (`should_fully_stop`), and `push`. A `CommitFailedError` preserves the tree
  and injects repair guidance into the next prompt. Three consecutive failures
  abort; permanent errors abort immediately.
- **`git.ts`** - `ensureGitRepository`, `createBranch`, `branchExists`,
  `getCurrentBranch`, `getHeadCommit`, `hasCommits`, `isWorkingTreeClean`,
  `commitAll` (returns `false` when nothing to commit, throws
  `CommitFailedError` on failure), `resetHard`, `pushCurrentBranch`.
- **`run.ts`** - `setupRun` creates `.autoralph/runs/<runId>/` with
  `prompt.md`, `notes.md`, `output-schema.json`, `autoralph.log`, and excludes
  the directory via `.git/info/exclude`. `appendNotes` records each iteration;
  `notes.md` is the run's long-term memory.
- **`config.ts`** - `loadConfig` merges defaults < file < env < CLI overrides;
  `bootstrapConfig` writes a starter `~/.autoralph/config.json`.
- **`prompt.ts`** - `buildIterationPrompt` composes objective + notes + optional
  commit-repair guidance + `stop-when` condition.
- **`events.ts`** - typed `OrchestratorEvents`, `RunView`, `IterationView`,
  `IterationStatus`, `StopReason`.
- **`slug.ts`** - `slugify` (branch slugs) and `makeRunId` (unique run ids).
- **`logger.ts`** - `appendDebugLog`, `serializeError`, `setDebugLogPath`
  (JSONL lifecycle log).

## Key variables / constants

- `maxConsecutiveFailures` default `3`; `backoffBaseMs` default `60_000`
  (delay `base * 2^(streak-1)`).
- Commit message prefix default `autoralph`.
- Stop reasons: `max-iterations`, `max-tokens`, `objective-complete`,
  `permanent-error`, `push-failed`, `consecutive-failures`, `interrupt`,
  `force-stop`.
- Run dir: `.autoralph/runs/<runId>/`; log file `autoralph.log`.
