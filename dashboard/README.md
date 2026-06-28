# autoralph · control board

A real-time [Next.js](https://nextjs.org) dashboard for [autoralph](https://github.com/ishaangupta-yb/autoralph) agent runs — a Kanban view of every iteration, commit, token budget, and provider fallback as the orchestrator works.

It consumes the CLI's board server: the CLI exposes `GET /api/state`
(snapshot), `GET /api/events` (SSE stream), `GET /api/history` (past runs), and
`GET|POST /api/control` (capabilities + start/stop), and this app proxies them
behind its own API routes so the browser only ever talks to the dashboard
origin. A **Live / History** tab switch lets you replay any finished run's
iterations and logs. When the board is started with run control enabled, the
Live tab also shows a **Start a run** form and per-run **Stop / Force** buttons.

## Quick start

```bash
npm install

# Demo mode — replays a scripted two-agent session, no CLI required.
AUTORALPH_DASHBOARD_DEMO=1 npm run dev

# Live mode — proxy a running CLI board (default http://127.0.0.1:7654).
autoralph "your objective" --board-port 7654   # in the repo root, separately
npm run dev
```

The dashboard runs on the non-standard port **4317**: http://localhost:4317

## Configuration

| Variable                   | Default                 | Purpose                                              |
| -------------------------- | ----------------------- | ---------------------------------------------------- |
| `AUTORALPH_BOARD_URL`      | `http://127.0.0.1:7654` | Base URL of the CLI board server to proxy.           |
| `AUTORALPH_DASHBOARD_DEMO` | `0`                     | Set to `1` to serve the self-contained demo instead. |

## Scripts

| Script              | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Dev server on port 4317.                     |
| `npm run build`     | Production build.                            |
| `npm run start`     | Serve the production build on port 4317.     |
| `npm run lint`      | ESLint (Next.js core-web-vitals + TS rules). |
| `npm run typecheck` | `tsc --noEmit`.                              |
| `npm test`          | Vitest suite: lib unit tests, API route tests, and component render tests. |

## Architecture

- `app/page.tsx` — server entry; reads env, renders the client dashboard.
- `components/Board.tsx` — the live client: one `EventSource`, run summary,
  four-column Kanban, a streaming event log, and the Live / History tab switch.
- `components/History.tsx` — the History tab: run list + per-run detail replay.
- `app/api/state/route.ts` — one-shot snapshot (demo or proxied).
- `app/api/events/route.ts` — SSE (demo replay or proxied passthrough).
- `app/api/history/route.ts` — run history list + detail (demo or proxied).
- `app/api/control/route.ts` — capabilities (GET) + start/stop (POST), proxied;
  read-only no-op in demo mode.
- `components/Controls.tsx` — the launch form, stop/force buttons, and the
  `useControl` capability poller.
- `lib/board.ts` — the data contract, mirrored from the CLI's `src/core/events.ts`.
- `lib/demo.ts` — the scripted demo timeline plus archived demo history.
- `lib/format.ts` — display helpers and the column map.

The visual language follows the Cobalt theme (cool engineered paper, hairline
structure, a single electric-cobalt signal, code as the hero).

## Hosted deployment (Vercel)

[`vercel.json`](./vercel.json) builds the app with `AUTORALPH_DASHBOARD_DEMO=1`
so a hosted deployment serves the self-contained demo without a reachable CLI
board. Point a Vercel project at this `dashboard/` directory (set it as the
project root). To proxy a real, network-reachable board instead, remove the
demo env var and set `AUTORALPH_BOARD_URL`.
