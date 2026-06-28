import type { AgentOutput, TokenUsage } from "../agents/types.js";

export type RunStatus =
  "idle" | "running" | "completed" | "stopped" | "aborted";

export type IterationStatus =
  "queued" | "running" | "committed" | "discarded" | "repair" | "aborted";

/** Reason a run finished, surfaced in events and the board. */
export type StopReason =
  | "max-iterations"
  | "max-tokens"
  | "max-duration"
  | "stop-condition"
  | "consecutive-failures"
  | "permanent-error"
  | "push-failed"
  | "interrupt"
  | "force-stop"
  | "objective-complete";

export interface IterationView {
  id: number;
  iteration: number;
  agent: string;
  status: IterationStatus;
  summary?: string;
  changes: string[];
  learnings: string[];
  message?: string;
  usage: TokenUsage;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface RunView {
  runId: string;
  objective: string;
  agent: string;
  status: RunStatus;
  stopReason?: StopReason;
  branch: string;
  baseCommit: string;
  currentIteration: number;
  maxIterations?: number;
  maxTokens?: number;
  usage: TokenUsage;
  commitCount: number;
  successCount: number;
  failCount: number;
  consecutiveFailures: number;
  startedAt: number;
  endedAt?: number;
  iterations: IterationView[];
}

/**
 * Strongly-typed orchestrator events. The board and any other observer
 * subscribe to these instead of reaching into orchestrator internals.
 */
export interface OrchestratorEvents {
  state: [RunView];
  "iteration:start": [{ iteration: number; agent: string }];
  "iteration:message": [{ iteration: number; text: string }];
  "iteration:usage": [{ iteration: number; usage: TokenUsage }];
  "iteration:end": [
    {
      iteration: number;
      status: IterationStatus;
      output?: AgentOutput;
      error?: string;
    },
  ];
  log: [{ level: "info" | "warn" | "error"; message: string }];
  done: [RunView];
}
