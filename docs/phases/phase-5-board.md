# Phase 5 - Kanban board

## Goal

Build the real-time visualization: aggregate state from one or more
orchestrators and serve a live dashboard on a non-standard port.

## Constraints

- Zero runtime dependencies for the server (Node's `http` only).
- Strictly server -> browser data flow, so Server-Sent Events (not websockets).
- Must support multiple concurrent runs (multi-agent orchestration), one column
  per run.
- The UI is embedded in the bundle so the CLI stays self-contained.

## Logic

- **`hub.ts`** - `BoardHub extends EventEmitter`. `register(orchestrator)`
  subscribes to `state` / `log` / `done` events and stores each run by `runId`
  in a `Map`. `snapshot()` returns all runs sorted by start time plus a bounded
  log buffer. Emits `update` on every change. Pure in-memory and transport
  agnostic, so it is unit-testable without a server.
- **`server.ts`** - `BoardServer` wraps `node:http`:
  - `GET /` and `/index.html` -> embedded dashboard HTML.
  - `GET /api/state` -> JSON snapshot.
  - `GET /api/events` -> SSE stream; writes a snapshot on connect and on every
    hub `update`; cleans up the client on `close`.
  - `GET /healthz` -> `ok`.
  - `start()` resolves with the bound URL; binding port `0` selects an ephemeral
    port (used by e2e tests). `stop()` ends all SSE clients and closes.
- **`assets.ts`** - `renderIndexHtml()` returns the dashboard markup with inline
  CSS/JS. An `EventSource` consumes `/api/events` and re-renders columns/cards
  on each snapshot, showing iteration status, summaries, token totals, and logs.

## Key variables / constants

- Default port `7654`, host `127.0.0.1`.
- SSE frame format: `data: <json>\n\n`; reconnect hint `retry: 2000`.
- `MAX_LOGS = 200` retained log entries.
