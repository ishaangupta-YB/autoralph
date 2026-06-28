# claude.md

Integration logic and behavior for the Claude Code agent in autoralph. This
complements [agents.md](./agents.md), which defines the shared agent contract
and repository conventions. Read both before changing agent code.

## What the Claude agent does

`src/agents/claude.ts` runs the Claude Code CLI (`claude`) once per orchestrator
iteration in headless mode and turns its final answer into a validated
`AgentOutput`.

Invocation:

```sh
claude -p --output-format stream-json --verbose [extraArgs...]
```

- `-p` runs non-interactively (prompt mode).
- `--output-format stream-json --verbose` makes Claude emit a JSONL event
  stream on stdout.
- The prompt (objective + notes + the JSON output schema) is written to the
  child's stdin; the binary defaults to `claude` and is overridable via
  `agentPathOverride` / `agentArgsOverride` in config.

## Stream handling

`claude.ts` parses each JSONL line via `parseJsonLines` and reads only the
fields it needs:

- `assistant` events with `message.content[].text` are forwarded to
  `options.onMessage` for the live board.
- `message.usage` / top-level `usage` events update `TokenUsage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`) and call `options.onUsage`.
- The `result` event carries the terminal text. The last successful `result`
  is parsed with `parseAgentJson` and validated with `validateAgentOutput`
  against the run's schema.

When the process closes, a lingering process tree is reaped with
`terminateProcess` so a stuck Claude session cannot wedge the loop.

## Output schema

Claude must return a single JSON object matching the schema appended to the
prompt:

```jsonc
{
  "success": true,
  "summary": "one-line description of what this iteration did",
  "key_changes_made": ["..."],
  "key_learnings": ["..."],
  // only present when --stop-when is active:
  "should_fully_stop": false
}
```

`success: false` tells the orchestrator to roll back the iteration and continue.
`should_fully_stop: true` (only when `--stop-when` is set) ends the run with
`objective-complete`.

## Error handling

`claude.ts` raises `PermanentAgentError` when a `result` error contains a
non-retryable marker:

- `credit balance is too low`
- `insufficient credit`
- `invalid api key`
- `authentication_error`

A permanent error aborts the run immediately after rollback. If the process
exits without a `result`, or the result cannot be parsed/validated, the
iteration is treated as a normal failure (rollback and continue, subject to the
three-consecutive-failures cap). All error paths log structured events
(`agent:claude:permanent`, `agent:claude:no-result`, `agent:claude:parse-failed`)
via `appendDebugLog`.

## Testing the Claude agent

- Inject a fake `spawnFn` (see `claude.test.ts`) to feed scripted JSONL without
  a real `claude` binary.
- Use `finishChild(child, code)` from `src/test-utils.ts` to drain the fake
  child's stdout/stderr before emitting `close`, mirroring real process ordering
  so streamed events are observed before completion.
- Cover: successful JSON result parsing, usage accumulation, the permanent-error
  markers, and the no-result failure path.

## Requirements & conventions specific to Claude

- The `claude` CLI must be installed and authenticated on the host
  (`PATH`-resolvable, or set `agentPathOverride`).
- Do not add Claude co-author trailers to commits.
- Keep all the shared conventions in [agents.md](./agents.md): ESM with `.js`
  import extensions, `execFileSync` for git, `appendDebugLog` on error paths,
  no logged secrets, no em dashes.
