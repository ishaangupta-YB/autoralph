# Phase 4 - Agent integrations

## Goal

Implement the agent layer: the shared contract, the Claude Code and OpenCode
integrations, the Cloudflare Workers AI wiring with model fallback, and the
scripted simulation agent used for demos and tests.

## Constraints

- Every agent implements the `Agent` interface and returns a schema-validated
  `AgentOutput` plus `TokenUsage`.
- Shared process/stream logic lives in one place (`process.ts`); JSON recovery
  in another (`json-extract.ts`). No duplication across agents.
- Errors must be classified into reported-failure / retryable / permanent so the
  orchestrator can react correctly.
- Cloudflare credentials are read from the environment and never logged.

## Logic

- **`types.ts`** - `Agent`, `AgentRunOptions` (`signal`, `onMessage`,
  `onUsage`, `logPath`), `AgentResult`, `AgentOutput`, `TokenUsage`
  (+ `EMPTY_USAGE`, `addUsage`, `totalTokens`), `PermanentAgentError`,
  `buildAgentOutputSchema`, `validateAgentOutput`.
- **`process.ts`** - `parseJsonLines`, `wireAbortSignal`, `terminateProcess`,
  `isAbortError`: shared child-process lifecycle.
- **`json-extract.ts`** - `parseAgentJson` recovers a JSON object from fenced or
  prose-wrapped text.
- **`claude.ts`** - spawns `claude -p --output-format stream-json --verbose`,
  parses the final `result`, accumulates usage, raises `PermanentAgentError` on
  credit/auth markers, reaps lingering processes. See
  [claude.md](../../claude.md).
- **`opencode.ts`** - writes a per-run `opencode.json` routing a Kimi model
  through Cloudflare Workers AI (`@ai-sdk/openai-compatible`), spawns
  `opencode run --model cloudflare-workers-ai/<model>`, walks the fallback chain
  on retryable/unknown errors, aborts on permanent errors, and estimates token
  usage (`estimated: true`). Helpers: `buildOpenCodeConfig`,
  `classifyProviderError`, `estimateTokens`.
- **`cloudflare.ts`** - Cloudflare Workers AI model id helpers (the Kimi family
  and endpoint shape).
- **`factory.ts`** - `createAgent` builds the configured agent; for OpenCode it
  passes the deduplicated `[model, ...fallbackModels]` chain.
- **`simulation.ts`** - `SimulationAgent` replays scripted steps (outputs, file
  writes, messages, thrown errors) with no external process.

## Key variables / constants

- OpenCode provider id: `cloudflare-workers-ai`; endpoint
  `.../accounts/<id>/ai/v1`.
- Retryable markers: `server_is_overloaded`, `service_unavailable`,
  `overloaded_error`, `rate limit`, `429`, `502`, `503`, `504`, `timeout`.
- Permanent markers (OpenCode): `authentication`, `invalid api key`,
  `unauthorized`, `401`, `403`. (Claude): `credit balance is too low`,
  `insufficient credit`, `invalid api key`, `authentication_error`.
- Token estimate: `ceil(text.length / 4)`.
