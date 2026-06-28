# Implementation phases

autoralph was built and committed in distinct phases. Each phase below documents
its scope, constraints, core logic, and the key variables/constants it
introduced. Phases map onto the commits in this repository's history.

| Phase | Title | Output |
| --- | --- | --- |
| [1](./phase-1-analysis.md) | Analysis & proposal | This docs set, design decisions |
| [2](./phase-2-scaffold.md) | Project scaffold | Tooling, license, CI, README |
| [3](./phase-3-core.md) | Core orchestration | Loop, git, run state, config, events |
| [4](./phase-4-agents.md) | Agent integrations | Claude, OpenCode, Cloudflare, fallback |
| [5](./phase-5-board.md) | Kanban board | HTTP + SSE server, dashboard UI |
| [6](./phase-6-cli-demo.md) | CLI & demo | Flag parsing, run modes, scripted demo |
| [7](./phase-7-testing.md) | Testing & verification | Unit + e2e suites, CI green |
| [8](./phase-8-dashboard.md) | Next.js dashboard | Standalone Kanban UI, proxy + demo, CI |

## Global constraints (all phases)

- ESM-only TypeScript with `.js` import extensions; bundled to `dist/cli.mjs`
  via tsdown.
- Node 20+. No runtime dependency beyond `commander`.
- All git operations through `execFileSync` with explicit argv.
- Secrets (Cloudflare credentials) live in the environment, never in tracked
  files or logs.
- No references to or copied source from any prior/reference codebase.
- Lint, format, typecheck, and tests must pass on Ubuntu/macOS/Windows.
