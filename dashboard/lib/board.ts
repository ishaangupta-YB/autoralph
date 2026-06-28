/**
 * Board data contract — a structural mirror of the shapes the autoralph CLI
 * exposes at `GET /api/state` and over the `GET /api/events` SSE stream
 * (`src/board/hub.ts` + `src/core/events.ts`). Kept in lockstep with the CLI;
 * the dashboard is a pure consumer of these snapshots.
 */

export type RunStatus =
  | "idle"
  | "running"
  | "completed"
  | "stopped"
  | "aborted";

export type IterationStatus =
  | "queued"
  | "running"
  | "committed"
  | "discarded"
  | "repair"
  | "aborted";

export type StopReason =
  | "max-iterations"
  | "max-tokens"
  | "stop-condition"
  | "consecutive-failures"
  | "permanent-error"
  | "push-failed"
  | "interrupt"
  | "force-stop"
  | "objective-complete";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimated?: boolean;
}

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

export interface BoardLogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  runId?: string;
}

export interface BoardSnapshot {
  runs: RunView[];
  logs: BoardLogEntry[];
  startedAt: number;
}

/** Base URL of the running CLI board server the dashboard proxies to. */
export function boardBaseUrl(): string {
  return (
    process.env.AUTORALPH_BOARD_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:7654"
  );
}

/** When true, routes serve a self-contained simulation instead of proxying. */
export function isDemoMode(): boolean {
  return process.env.AUTORALPH_DASHBOARD_DEMO === "1";
}

export function totalTokens(usage: TokenUsage): number {
  return (usage.inputTokens || 0) + (usage.outputTokens || 0);
}
