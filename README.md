# autoralph

Autonomous coding-agent orchestrator with a real-time Kanban board.

autoralph runs a coding agent (Claude Code or OpenCode) in a loop inside a git
repository. Each successful iteration becomes its own commit. While the loop
runs, a built-in web dashboard streams every agent's status, iteration cards,
token usage, and logs in real time, served on a non-standard port (7654 by
default).

- **Two agents out of the box.** Claude Code (`claude`) and OpenCode
  (`opencode`). OpenCode is wired to Cloudflare Workers AI Kimi models
  (`@cf/moonshotai/kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`) through the
  OpenAI-compatible endpoint, with automatic model fallback.
- **Commit-per-iteration.** Every successful step is committed on a dedicated
  `autoralph/<slug>` branch (or the current branch with `--current-branch`),
  with optional `--push` after each commit.
- **Truly parallel runs.** Pass several objectives in one invocation and each
  runs concurrently in its own isolated git worktree (`--worktree` forces it
  for a single run), so parallel agents never clobber each other's tree.
- **Persistence & resume.** Every run's recipe is saved to
  `.autoralph/runs/<runId>/run.json` and its board state to
  `.autoralph/history/`, so `autoralph runs` lists past runs and
  `autoralph resume <runId>` continues one from where it left off after a
  restart.
- **Resilient loop.** Reported failures roll back and continue, retryable
  provider errors trigger exponential backoff, permanent errors (bad
  credentials, exhausted credit) abort immediately, and consecutive failures
  stop the run. Backoff (`--backoff-base`, `--backoff-factor`, `--max-backoff`)
  and the failure threshold (`--max-failures`) are all configurable.
- **Real-time Kanban board.** A dependency-free HTTP + Server-Sent Events
  server renders a live board of all active runs, and a control endpoint lets
  the dashboard start and stop runs.
- **Hard limits.** `--max-iterations`, `--max-tokens` (enforced mid-iteration),
  `--max-duration` (a wall-clock budget), and a natural-language `--stop-when`
  condition.

## Requirements

- Node.js >= 20
- git
- For the `claude` agent: the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`) on your `PATH`.
- For the `opencode` agent: the [OpenCode](https://opencode.ai) CLI (`opencode`) on your `PATH`, plus a Cloudflare account with Workers AI access.

## Install

```sh
pnpm install
pnpm run build   # produces dist/cli.mjs
```

Run it directly with Node:

```sh
node dist/cli.mjs "your objective here"
```

## Quick start

See the board and the loop without any external agent or credentials by running
the scripted demo:

```sh
node dist/cli.mjs demo
```

Then open the printed URL (default <http://127.0.0.1:7654>). The demo drives two
simulated agents through success, failure/rollback, and retry/backoff so you can
watch the board update live.

## Usage

```sh
autoralph [objectives...] [options]
autoralph resume <runId> [options]
autoralph runs
autoralph demo [options]
```

Pass more than one objective to run them in parallel, each in its own git
worktree:

```sh
autoralph "add dark mode" "write API docs" "speed up the build"
```

List and resume persisted runs (state survives restarts):

```sh
autoralph runs                 # list persisted runs, newest first
autoralph resume <runId>       # continue a run from its last iteration
```

Run an objective with Claude Code on a fresh branch:

```sh
autoralph "add input validation to the signup form" --agent claude
```

Run with OpenCode on Cloudflare Workers AI (Kimi), capped at 10 iterations:

```sh
export CLOUDFLARE_ACCOUNT_ID=...   # your account id
export CLOUDFLARE_API_TOKEN=...    # a Workers AI token
autoralph "refactor the parser for speed" \
  --agent opencode \
  --model @cf/moonshotai/kimi-k2.7-code \
  --max-iterations 10
```

### Options

| Flag | Description |
| --- | --- |
| `-a, --agent <name>` | `claude` or `opencode`. |
| `-m, --model <id>` | Primary model id (OpenCode via Cloudflare Workers AI). |
| `--fallback-models <list>` | Comma-separated fallback model ids. |
| `-i, --max-iterations <n>` | Stop after N iterations. |
| `-t, --max-tokens <n>` | Stop after N total tokens (enforced mid-iteration). |
| `-s, --stop-when <text>` | Natural-language stop condition; the agent ends the run when met. |
| `-b, --branch <name>` | Branch to create for the run. |
| `--current-branch` | Run on the current branch instead of creating a new one. |
| `--push` | Push after each successful iteration. |
| `--no-board` | Disable the Kanban board. |
| `--board-port <n>` | Board port (default 7654). |
| `--board-host <host>` | Board host (default 127.0.0.1). |
| `--commit-prefix <text>` | Commit message prefix (default `autoralph`). |
| `--max-duration <seconds>` | Stop after N seconds of wall-clock time. |
| `-w, --worktree` | Isolate the run in its own git worktree (implied for parallel runs). |
| `--keep-worktrees` | Do not remove worktrees when runs finish. |
| `--no-control` | Disable the board's start/stop control endpoints. |
| `--max-failures <n>` | Consecutive failures tolerated before aborting (default 3). |
| `--backoff-base <seconds>` | Base backoff delay for retryable errors (default 60). |
| `--backoff-factor <n>` | Exponential backoff growth factor (default 2). |
| `--max-backoff <seconds>` | Cap on any single backoff delay (default 900). |

## Configuration

On first run autoralph writes a starter config to `~/.autoralph/config.json`.
Effective configuration is resolved in increasing order of precedence:

1. Built-in defaults
2. `~/.autoralph/config.json`
3. Environment variables (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_API_KEY`)
4. CLI flags

Cloudflare credentials are read from the environment by preference so secrets
never have to live in the config file.

```json
{
  "agent": "claude",
  "model": "@cf/moonshotai/kimi-k2.7-code",
  "fallbackModels": ["@cf/moonshotai/kimi-k2.6", "@cf/moonshotai/kimi-k2.5"],
  "board": { "enabled": true, "port": 7654, "host": "127.0.0.1" },
  "retry": {
    "maxConsecutiveFailures": 3,
    "backoffBaseMs": 60000,
    "backoffFactor": 2,
    "maxBackoffMs": 900000
  }
}
```

## The Kanban board

The board is served at `http://<host>:<port>` (default
<http://127.0.0.1:7654>). Endpoints:

- `GET /` - the live dashboard UI.
- `GET /api/state` - a one-shot JSON snapshot of all runs and logs.
- `GET /api/events` - a Server-Sent Events stream that pushes a full snapshot on
  every state change.
- `GET /api/history` - the list of all runs the board has seen (live plus runs
  persisted from earlier sessions); add `?runId=<id>` for one run's full state
  and logs.
- `GET /api/control` - reports whether run control is enabled (`canLaunch`),
  the launchable `agents`, and the ids of currently live runs.
- `POST /api/control` - `{ "action": "start", "objective": "…" }` launches a new
  worktree-isolated run; `{ "action": "stop" | "force-stop", "runId": "…" }`
  interrupts or hard-stops a live run. Control is on by default; disable it
  with `--no-control`.
- `GET /healthz` - liveness check.

Completed runs are persisted to `.autoralph/history/<runId>.json` (kept out of
version control), so run history survives restarts and stays queryable even
after a run leaves memory.

Each run is a column; each iteration is a card that moves through
`running -> committed / discarded / repair / aborted`, alongside live token
totals and a rolling log.

### Optional Next.js dashboard

The built-in board is dependency-free and needs no build step. For a richer,
polished view there is also a standalone Next.js dashboard in [`dashboard/`](./dashboard)
that proxies the same `/api/state`, `/api/events`, and `/api/history` endpoints
and renders a four-column Kanban with run summaries and a streaming event log,
plus a **History** tab that lists past runs and opens any one to replay its
iterations and event log. When the board is started with run control it can
also **start runs** from a launch form and **stop / force-stop** live runs
inline. It runs on port `4317` and can also replay a self-contained demo
without a live CLI:

```sh
cd dashboard
npm install
AUTORALPH_DASHBOARD_DEMO=1 npm run dev   # preview with demo data
# or, against a live run: npm run dev (proxies AUTORALPH_BOARD_URL)
```

See [`dashboard/README.md`](./dashboard/README.md) for details.

#### Hosted deployment (Vercel)

The dashboard ships a [`vercel.json`](./dashboard/vercel.json) that builds the
Next.js app with `AUTORALPH_DASHBOARD_DEMO=1`, so a hosted deployment serves
the self-contained demo without needing a reachable CLI board. Point a Vercel
project at the `dashboard/` directory (set it as the project root) to deploy.
To instead proxy a real, network-reachable board, drop the demo env var and set
`AUTORALPH_BOARD_URL` to the board's URL.

## Run metadata

Each run stores its state under `.autoralph/runs/<runId>/`
(`run.json`, `prompt.md`, `notes.md`, `output-schema.json`, `autoralph.log`).
This directory is added to `.git/info/exclude` so it never enters version
control. `run.json` is the persisted run recipe that `autoralph resume` reads
to reconstruct a run; `notes.md` is the run's long-term memory and is injected
into each subsequent prompt.

## Development

```sh
pnpm run build          # bundle src -> dist/cli.mjs (tsdown)
pnpm run dev            # tsdown --watch
pnpm run lint           # ESLint on src
pnpm run format         # Prettier (format:check in CI)
pnpm run typecheck      # tsc --noEmit
pnpm test               # build, then run all vitest suites
pnpm run test:e2e       # build, then run e2e/ only
```

Unit tests are co-located as `*.test.ts`; end-to-end tests live under `e2e/` and
exercise the built `dist/cli.mjs`. See [agents.md](./agents.md),
[claude.md](./claude.md), and [ARCHITECTURE.md](./ARCHITECTURE.md) for design
details, and [docs/phases](./docs/phases) for the phased build history.

## License

[MIT](./LICENSE) (c) Ishaan Gupta
