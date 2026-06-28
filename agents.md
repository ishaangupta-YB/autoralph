# agents.md

This file defines agent behaviors and integration logic for autoralph, and the
rules contributors must follow when working in this repository. Agents working
in this codebase must read and strictly follow it.

## Project

autoralph is a CLI that runs a coding agent (Claude Code or OpenCode) in a loop
inside a git repository. Each successful iteration is a separate commit, by
default on a dedicated `autoralph/<slug>` branch; `--current-branch` uses the
existing branch and `--push` publishes each successful iteration. A real-time
web Kanban board (default port 7654) visualizes every run. Target: Node 20+,
shipped as a bundled ESM CLI (`dist/cli.mjs`).

## Commands

```sh
pnpm run build          # tsdown bundle -> dist/cli.mjs (the published binary)
pnpm run dev            # tsdown --watch
pnpm run lint           # ESLint on src
pnpm run format         # Prettier on src (format:check for CI)
pnpm run typecheck      # tsc -p tsconfig.typecheck.json --noEmit
pnpm test               # build, then vitest run (all tests)
pnpm run test:e2e       # build, then vitest run e2e/
pnpm run test:coverage  # vitest with coverage, excludes e2e/
```

Run a single test file: `pnpm exec vitest run src/core/orchestrator.test.ts`.
Filter by name: `pnpm exec vitest run -t "name substring"`.

CI (`.github/workflows/ci.yml`) runs lint, format:check, typecheck, and test on
Ubuntu/macOS/Windows. Keep all four green.

## The Agent contract

Every agent implements `Agent` in `src/agents/types.ts`:

```ts
interface Agent {
  readonly name: string;
  run(prompt: string, cwd: string, options?: AgentRunOptions): Promise<AgentResult>;
  close?(): Promise<void>;
}
```

Responsibilities shared by all agents:

1. **Stream output.** Forward human-readable progress to `options.onMessage` so
   the board shows live activity.
2. **Produce structured output.** Extract an `AgentOutput`
   (`success`, `summary`, `key_changes_made`, `key_learnings`, and
   `should_fully_stop` only when `--stop-when` is active) and validate it with
   `validateAgentOutput(parsed, schema)`. Use `parseAgentJson` (from
   `json-extract.ts`) before any ad-hoc parsing so fenced or prose-wrapped JSON
   is recovered.
3. **Report token usage.** Call `options.onUsage` and resolve `AgentResult.usage`
   with `TokenUsage`. If usage is estimated, set `estimated: true` so the board
   prefixes totals with `~`.
4. **Honor the abort signal.** Wire `options.signal` through `wireAbortSignal`
   so `--max-tokens` and force-stop can interrupt an in-flight run, and reap the
   child process with `terminateProcess` on completion.

### Error classification

The orchestrator reacts to how an agent fails:

- **Reported failure** (`output.success === false`): the iteration is rolled
  back (`git reset --hard`) and the loop continues immediately.
- **`PermanentAgentError`** (thrown): the run aborts immediately after rollback.
  Use this for non-retryable conditions: invalid/missing credentials, exhausted
  credit, authorization failures.
- **Retryable error** (thrown `Error` with `retryable === true`): the
  orchestrator increments a backoff streak and waits `base * 2^(streak-1)` ms
  before the next iteration. Use this for transient provider conditions
  (overloaded, rate limited, 5xx, timeouts).
- **Any other thrown error**: counted as a failure. Three consecutive failures
  abort the run.

## Adding a new agent

1. Implement the `Agent` interface in `src/agents/<name>.ts`.
2. Reuse `process.ts` (stream parsing, abort wiring, process termination) and
   `json-extract.ts` (output recovery). Do not hand-roll these.
3. Add the agent to the `AgentName` union in `core/config.ts` and to the switch
   in `factory.ts`.
4. Add the choice to the `--agent` option in `cli.ts`.
5. Classify provider errors into permanent vs. retryable as above.
6. Test pure helpers as unit tests next to the source; test the spawned-process
   path with an injected `spawnFn` (see `claude.test.ts` / `opencode.test.ts`)
   and, where it crosses the process boundary, with an `e2e/` test against the
   built binary.

## OpenCode + Cloudflare Workers AI

`opencode.ts` writes a per-run `opencode.json` registering a provider
(`cloudflare-workers-ai`) backed by `@ai-sdk/openai-compatible` pointed at
`https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/v1`. Each model in
the fallback chain (primary + fallbacks) is registered so switching models never
rewrites the file. Models default to the Kimi family
(`@cf/moonshotai/kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`). Credentials come
from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or
`CLOUDFLARE_API_KEY`); a missing credential is a `PermanentAgentError`.

## Conventions

- ESM-only, `.js` import extensions in TypeScript source
  (`import { foo } from "./foo.js"`). tsdown bundles everything into
  `dist/cli.mjs`.
- Unit tests co-located as `*.test.ts`; e2e tests under `e2e/`. Prefer e2e for
  behavior that crosses a process/IO boundary (CLI flags, git, agent spawning,
  stdout); unit-test pure helpers (schema builders, prompt templates,
  formatters, classifiers).
- All git calls go through `execFileSync` with an explicit argv. Never build a
  shell string from user input.
- Prefer `appendDebugLog("category:event", {...})` over ad-hoc logging on error
  paths.
- Never log or persist secrets. Cloudflare credentials stay in the environment.
- No em dashes. No auto-added co-author lines in commits.
