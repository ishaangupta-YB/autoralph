# Phase 8 - Next.js dashboard

## Goal

Add a polished, standalone web Kanban dashboard for agent runs without touching
the CLI. The embedded board (Phase 5) stays the dependency-free default; this is
an optional, richer view that any deployment can run separately.

## Constraints

- Live in `dashboard/` as a self-contained Next.js app with its own
  `package.json` and lockfile; do not add web-framework dependencies to the CLI.
- Be a pure consumer of the CLI board - never a second source of truth for run
  state. The view shapes must mirror `src/core/events.ts`.
- The browser talks only to the dashboard origin; the CLI board is reached
  server-side via proxy routes.
- Must be previewable with no CLI running (a self-contained demo).
- Run on a non-standard port distinct from the CLI board.

## Logic

- **`lib/board.ts`** - the data contract, mirrored from the CLI's
  `src/core/events.ts` (`RunView`, `IterationView`, `BoardSnapshot`, ...), plus
  `boardBaseUrl()` / `isDemoMode()` (env readers) and `totalTokens()`.
- **`lib/demo.ts`** - a scripted two-agent timeline (commits, a discard, a
  retryable provider error + backoff, a Kimi fallback, `max-iterations` finish)
  used when demo mode is on.
- **`lib/format.ts`** - token/time formatting and the status -> column map.
- **`app/api/state/route.ts`** - one-shot snapshot: demo snapshot when
  `AUTORALPH_DASHBOARD_DEMO=1`, otherwise `fetch(boardUrl/api/state)` with a
  short timeout; returns `connected: false` instead of throwing on failure.
- **`app/api/events/route.ts`** - SSE: replays the demo timeline frame-by-frame
  in demo mode, otherwise passes through the CLI board's SSE stream; emits an SSE
  `board-error` event rather than hard-failing when the board is unreachable.
- **`components/Board.tsx`** - one `EventSource`, a live connection badge,
  run-summary cards (iter / commits / ok-fail / tokens + progress), the
  four-column Kanban, and a streaming event log. Reduced-motion aware; no motion
  libraries.
- **Cobalt theme** (`app/globals.css`) - cool engineered paper, hairline
  structure, one electric-cobalt signal, code as the hero.

## Key variables / constants

- Dashboard port `4317` (`next dev/start -p 4317`).
- `AUTORALPH_BOARD_URL` (default `http://127.0.0.1:7654`) - board to proxy.
- `AUTORALPH_DASHBOARD_DEMO=1` - serve the demo instead of proxying.
- `next.config.ts` pins `turbopack.root` / `outputFileTracingRoot` to
  `dashboard/` so the build does not adopt the CLI's pnpm lockfile.

## Testing & verification

- Vitest suites under `dashboard/tests/` (`format`, `board` env helpers, `demo`
  timeline invariants).
- A dedicated CI job (`.github/workflows/dashboard.yml`, paths-filtered on
  `dashboard/**`) runs `npm ci`, lint, typecheck, test, and build.

```sh
cd dashboard
npm install
npm run lint && npm run typecheck && npm test && npm run build
```
