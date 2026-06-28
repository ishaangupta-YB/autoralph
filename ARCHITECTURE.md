# autoralph architecture

autoralph is a bundled ESM CLI (Node 20+) that drives a coding agent in a loop
inside a git repository and streams progress to a real-time web Kanban board.
This document describes the system end to end.

## High-level flow

```
cli.ts (commander)
  -> resolve config (defaults < file < env < flags)
  -> select run mode (new branch | current branch)
  -> setupRun() writes .autoralph/runs/<id>/ metadata
  -> createAgent() builds Claude or OpenCode agent
  -> Orchestrator (EventEmitter loop)
        |  emits: state / iteration:* / log / done
        v
     BoardHub  --update-->  BoardServer (HTTP + SSE)  -->  browser dashboard
```

The orchestrator never knows about the board. It emits typed events; the
`BoardHub` aggregates them, and the `BoardServer` pushes snapshots to browsers
over Server-Sent Events. Observers are fully decoupled from the loop.

## Modules

```
src/
  cli.ts                 Entry point: flag parsing, run-mode selection, demo command
  agents/
    types.ts             Agent interface, AgentOutput, schema builder, token usage,
                         PermanentAgentError
    factory.ts           Build the configured agent (claude | opencode)
    claude.ts            Claude Code integration (stream-json, per iteration)
    opencode.ts          OpenCode integration + Cloudflare Workers AI config + fallback
    cloudflare.ts        Cloudflare Workers AI model helpers
    simulation.ts        Scripted agent for demos and tests
    json-extract.ts      Recover JSON from fenced / prose-wrapped agent output
    process.ts           Child-process lifecycle: JSONL parsing, abort wiring, reaping
  core/
    config.ts            Config resolution + bootstrap, model + port defaults
    orchestrator.ts      The iteration loop (EventEmitter)
    events.ts            Typed event + view shapes (RunView, IterationView, StopReason)
    run.ts               Per-run metadata (.autoralph/runs/<id>/), notes memory
    git.ts               All git operations via execFileSync with explicit argv
    prompt.ts            Iteration prompt builder (objective + notes + repair guidance)
    slug.ts              Branch slug + run id generation
    logger.ts            JSONL debug log (appendDebugLog), error serialization
  board/
    hub.ts               Aggregate multiple orchestrators into one snapshot
    server.ts            Zero-dependency HTTP + SSE server
    assets.ts            Embedded dashboard HTML/CSS/JS
  test-utils.ts          Shared test helpers (temp git repo, fake child draining)
```

## Run lifecycle (the critical flow)

1. **Mode selection (`cli.ts`).** Without `--current-branch`, a fresh
   `autoralph/<slug>` branch is created, probing numeric suffixes
   (`autoralph/<slug>-1`, ...) on collision. With `--current-branch`, the run
   stays on the current branch and warns if the working tree is dirty (failed
   iterations reset it).
2. **Run setup (`run.ts`).** `setupRun()` creates `.autoralph/runs/<runId>/`
   with `prompt.md`, `notes.md`, `output-schema.json`, and `autoralph.log`, and
   appends `.autoralph/runs/` to `.git/info/exclude` so run metadata stays out
   of version control.
3. **Loop (`orchestrator.ts`).** The `Orchestrator` is an `EventEmitter`. Each
   iteration:
   - Build the prompt via `buildIterationPrompt` (objective + current `notes.md`
     + commit-repair guidance if a prior commit failed + the `--stop-when`
     condition when set).
   - Call `agent.run(prompt, cwd, { signal, onMessage, onUsage })`.
   - On **success**: `commitAll` the working tree, append the iteration to
     `notes.md`, optionally `pushCurrentBranch`. A failed `git commit` raises
     `CommitFailedError`, which preserves the working tree and injects repair
     instructions into the next prompt.
   - On **reported failure** (`output.success === false`): `resetHard` and
     continue immediately.
   - On **thrown error**: a `PermanentAgentError` aborts after rollback; a
     retryable error increments the backoff streak; any other error counts as a
     failure. Three consecutive failures abort.
4. **Limits (`RunLimits`).** `--max-iterations` is checked between iterations;
   `--max-tokens` is enforced mid-iteration via an `AbortController` fed by the
   agent's `onUsage` callback; `--stop-when` ends the run when the agent sets
   `should_fully_stop`; `--push` publishes each successful commit.
5. **Shutdown.** `SIGINT` routes to `handleInterrupt()`: the first press
   requests a graceful stop (the current iteration finishes, any backoff ends
   early); a second press force-stops via `stop()`, aborting the in-flight agent
   run. `SIGTERM` force-stops immediately.

## Agents (`src/agents/`)

Every agent implements the `Agent` interface in `types.ts`:

```ts
interface Agent {
  readonly name: string;
  run(prompt: string, cwd: string, options?: AgentRunOptions): Promise<AgentResult>;
  close?(): Promise<void>;
}
```

`run` streams stdout, extracts a structured `AgentOutput`
(`success`, `summary`, `key_changes_made`, `key_learnings`, and
`should_fully_stop` only when `--stop-when` is active) validated against the
schema from `buildAgentOutputSchema(...)`, and accumulates `TokenUsage`.

- **`claude.ts`** spawns `claude -p --output-format stream-json --verbose` once
  per iteration, appends the output schema to the prompt, parses the final
  `result` text into an `AgentOutput`, accumulates usage from Claude's `usage`
  events, raises `PermanentAgentError` on credit/auth markers, and reaps any
  lingering process tree after the result arrives.
- **`opencode.ts`** writes a per-run `opencode.json` that routes a Kimi model
  through Cloudflare Workers AI's OpenAI-compatible endpoint
  (`@ai-sdk/openai-compatible`), then spawns `opencode run --model
  cloudflare-workers-ai/<model>` per iteration. On a retryable provider error it
  advances to the next fallback model; a permanent error (bad credentials)
  aborts. Token usage is estimated from prompt/response length and flagged with
  `estimated: true` so the board prefixes totals with `~`.
- **`simulation.ts`** replays a scripted list of steps (outputs, file writes,
  messages, thrown errors) with no external process. It powers the `demo`
  command and the orchestrator tests.
- **`json-extract.ts`** recovers a JSON object from fenced or prose-wrapped
  output before validation. **`process.ts`** centralizes JSONL stream parsing,
  `AbortSignal` wiring, and cross-platform process termination.

### Provider fallback

`factory.ts` hands OpenCode the primary model followed by the configured
fallbacks (deduplicated). `opencode.ts` walks them in order, classifying each
failure via `classifyProviderError`:

- `permanent` (auth, 401/403): abort with `PermanentAgentError`.
- `retryable` (overloaded, 429/502/503/504, timeout) or `unknown`: try the next
  model. When all models are exhausted, the error is flagged `retryable` so the
  orchestrator backs off and tries the whole chain again next iteration.

## Kanban board (`src/board/`)

- **`hub.ts`** subscribes to one or more orchestrators and keeps a
  `Map<runId, RunView>` plus a bounded log buffer. `snapshot()` returns all runs
  sorted by start time. Because each orchestrator is a separate run, the board
  supports multi-agent orchestration natively, one column per run. On every
  state/log/done event it also writes the run (with its logs) through an
  optional `BoardStore`, and `history()` / `historyRun()` merge those persisted
  runs with the live map (the live copy always wins).
- **`store.ts`** defines the `BoardStore` interface and `FileBoardStore`, which
  serializes each run to `.autoralph/history/<runId>.json` via a temp-file +
  atomic `rename`, and reads them back newest-first (malformed files are
  skipped). Persistence means run history survives a board restart; tests use an
  in-memory store so they never touch disk.
- **`server.ts`** is a zero-dependency `node:http` server. `GET /` serves the
  embedded UI; `GET /api/state` returns a JSON snapshot; `GET /api/events` is an
  SSE stream that emits a full snapshot on connect and on every hub update;
  `GET /api/history` lists every run the hub knows about, and
  `GET /api/history?runId=<id>` returns one run's full state and logs (404 if
  unknown); `GET /healthz` returns `ok`. SSE is chosen over websockets because
  data flows strictly server -> browser, keeping the server dependency-free and
  proxy-friendly. Binding to port `0` selects an ephemeral port (used by tests).
- **`assets.ts`** embeds the dashboard (HTML/CSS/JS) as a string so the bundled
  CLI is fully self-contained: an `EventSource` consumes `/api/events` and
  re-renders columns and cards on each snapshot.

The default port is **7654** (`DEFAULT_BOARD_PORT`), a deliberately
non-standard port, overridable with `--board-port` or config.

## Optional Next.js dashboard (`dashboard/`)

The embedded board is dependency-free and always available. `dashboard/` is a
separate, optional [Next.js](https://nextjs.org) app (its own `package.json` and
lockfile) that renders a richer Kanban view on port **4317**. It is a pure
*consumer* of the CLI board, never a second source of truth:

- `lib/board.ts` mirrors the view shapes from `src/core/events.ts`, so the two
  cannot silently diverge (a type mismatch fails `tsc`).
- `app/api/state`, `app/api/events`, and `app/api/history` proxy the CLI's
  matching endpoints so the browser only talks to the dashboard origin; on
  failure they degrade gracefully (`connected: false`, or an SSE `board-error`
  event).
- A **History** tab (`components/History.tsx`) lists past runs from
  `/api/history` and opens any one (`?runId=<id>`) to replay its iterations on
  the Kanban columns alongside that run's event log.
- `AUTORALPH_DASHBOARD_DEMO=1` swaps the proxy for a self-contained scripted
  timeline (`lib/demo.ts`), so the UI is previewable with no CLI running.
- `AUTORALPH_BOARD_URL` (default `http://127.0.0.1:7654`) points it at a live
  board. `next.config.ts` pins the Turbopack root to `dashboard/` so the build
  never walks up to the CLI's pnpm lockfile.

It has its own CI job (`.github/workflows/dashboard.yml`: lint, typecheck, test,
build) and its own Vitest suite under `dashboard/tests/`. See
[`dashboard/README.md`](./dashboard/README.md).

## Configuration (`src/core/config.ts`)

`loadConfig` merges, in increasing precedence: built-in defaults,
`~/.autoralph/config.json`, environment variables, and CLI overrides. Cloudflare
credentials are sourced from `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_API_KEY` by preference so secrets never need
to live in the config file. `bootstrapConfig` writes a starter file on first
run.

## Git helpers (`src/core/git.ts`)

All git invocations go through `execFileSync` with an explicit argument vector,
never a shell string, so branch names and prompts cannot inject shell
metacharacters. `commitAll` returns `false` when there is nothing to commit and
throws `CommitFailedError` (carrying the git output) when a commit fails, which
the orchestrator uses to drive its repair flow.

## Observability (`src/core/logger.ts`)

`appendDebugLog("category:event", {...})` writes JSONL lifecycle events to
`.autoralph/runs/<id>/autoralph.log`, including serialized `error.cause` chains.
Agent and orchestrator error paths log structured events
(`agent:opencode:run-failed`, `git:commit:failed`, `run:crashed`, ...).

## Testing

- **Unit tests** are co-located as `*.test.ts` and cover pure helpers and
  module behavior: schema building, prompt assembly, slug generation, config
  resolution, git operations (against real temp repos), the orchestrator loop
  (with the simulation agent), agent JSON parsing and fallback (with a fake
  spawn), the board hub, and the board server.
- **End-to-end tests** under `e2e/` exercise the built `dist/cli.mjs`: the
  `demo` command over real HTTP/SSE, and a full orchestration loop driven by a
  fake `opencode` binary that commits real files in a temp git repo.
- Shared helpers live in `src/test-utils.ts` (`makeTempRepo`, `finishChild`,
  `gitLog`). `finishChild` drains a fake child's stdout/stderr before emitting
  `close`, mirroring real process ordering so streamed output is observed before
  completion.

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, and the full
test suite on Ubuntu, macOS, and Windows.
