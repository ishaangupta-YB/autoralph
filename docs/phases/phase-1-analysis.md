# Phase 1 - Analysis & proposal

## Goal

Establish the architecture and feature set for autoralph: an autonomous
coding-agent orchestrator that runs an agent in a loop, commits each successful
iteration, and visualizes runs on a real-time Kanban board. Distill the proven
ideas from prior loop-based agent runners (commit-per-iteration, rollback on
failure, exponential backoff, structured agent output) into a clean, faster,
independently written implementation.

## Constraints

- Independent implementation only: no copied source, no leftover references to
  any reference project.
- Support exactly two agents at launch: Claude Code and OpenCode (the latter on
  Cloudflare Workers AI Kimi models).
- The board must be real-time and run on a non-standard port.
- Everything bundles into a single ESM CLI with a minimal dependency surface.

## Decisions

- **Loop as an `EventEmitter`.** The orchestrator emits typed events; all
  observers (board, tests) consume events instead of reaching into state. This
  decouples visualization from execution and makes multi-agent aggregation
  trivial.
- **Structured agent output.** Agents must return a JSON object
  (`success`, `summary`, `key_changes_made`, `key_learnings`,
  `should_fully_stop`) validated against a generated schema, so the loop can act
  on outcomes deterministically.
- **Commit-per-iteration on a dedicated branch.** Successful work is committed;
  failures reset; commit failures preserve the tree for a repair iteration.
- **Web board over TUI.** A dependency-free HTTP + Server-Sent Events server
  delivers real-time updates to any browser and is easy to test over HTTP.
- **Provider fallback for OpenCode.** A primary model plus an ordered fallback
  chain, walked on retryable provider errors.

## Key variables / constants

- Default agents: `claude`, `opencode`.
- Default board port: `7654` (non-standard), host `127.0.0.1`.
- Default Kimi models: `@cf/moonshotai/kimi-k2.7-code` (primary),
  `kimi-k2.6`, `kimi-k2.5` (fallbacks).

## Output

The full design is captured in [ARCHITECTURE.md](../../ARCHITECTURE.md),
[agents.md](../../agents.md), and [claude.md](../../claude.md).
