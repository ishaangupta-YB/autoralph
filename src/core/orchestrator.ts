import { EventEmitter } from "node:events";

import {
  addUsage,
  EMPTY_USAGE,
  PermanentAgentError,
  totalTokens,
  type Agent,
  type AgentOutput,
  type TokenUsage,
} from "../agents/types.js";
import {
  CommitFailedError,
  commitAll,
  getCurrentBranch,
  pushCurrentBranch,
  resetHard,
} from "./git.js";
import { appendDebugLog, serializeError, setDebugLogPath } from "./logger.js";
import { buildIterationPrompt } from "./prompt.js";
import { appendNotes, type RunInfo } from "./run.js";
import type {
  IterationStatus,
  IterationView,
  OrchestratorEvents,
  RunView,
  StopReason,
} from "./events.js";

export interface RunLimits {
  maxIterations?: number;
  maxTokens?: number;
  /** Wall-clock budget in ms; the run stops once it is exceeded. */
  maxDurationMs?: number;
  stopWhen?: string;
  push?: boolean;
}

export interface OrchestratorParams {
  agent: Agent;
  runInfo: RunInfo;
  objective: string;
  cwd: string;
  limits?: RunLimits;
  commitMessagePrefix?: string;
  /** Consecutive failures tolerated before aborting. */
  maxConsecutiveFailures?: number;
  /** Backoff base in ms (exponential: base * factor^streak). Injectable for tests. */
  backoffBaseMs?: number;
  /** Exponential growth factor for backoff (default 2). */
  backoffFactor?: number;
  /** Upper bound on a single backoff delay in ms. */
  maxBackoffMs?: number;
  /** Seed counters when resuming a prior run so iteration numbering continues. */
  resumeState?: ResumeState;
  /** Injectable sleep so tests do not actually wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Snapshot of prior progress used to continue (resume) an interrupted run. */
export interface ResumeState {
  currentIteration: number;
  usage: TokenUsage;
  commitCount: number;
  successCount: number;
  failCount: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { retryable?: boolean }).retryable === true
  );
}

function clip(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Event-driven loop that drives a single agent toward an objective. Each
 * iteration: build a prompt (with prior notes + any commit-repair guidance),
 * run the agent, then either commit the work and append notes (success) or
 * reset the working tree (failure). Token and iteration caps, graceful and
 * forced shutdown, exponential backoff for retryable errors, and immediate
 * abort on permanent errors are all enforced here. Observers (the Kanban board,
 * tests) consume the typed events rather than reaching into internal state.
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private agent: Agent;
  private runInfo: RunInfo;
  private objective: string;
  private cwd: string;
  private limits: RunLimits;
  private commitMessagePrefix: string;
  private maxConsecutiveFailures: number;
  private backoffBaseMs: number;
  private backoffFactor: number;
  private maxBackoffMs: number;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  private view: RunView;
  private usage: TokenUsage = { ...EMPTY_USAGE };
  private stopRequested = false;
  private forceStop = false;
  private interruptCount = 0;
  private controller: AbortController | null = null;
  private tokenCapHit = false;
  private durationCapHit = false;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCommitRepair: string | null = null;

  constructor(params: OrchestratorParams) {
    super();
    this.agent = params.agent;
    this.runInfo = params.runInfo;
    this.objective = params.objective;
    this.cwd = params.cwd;
    this.limits = params.limits ?? {};
    this.commitMessagePrefix = params.commitMessagePrefix ?? "autoralph";
    this.maxConsecutiveFailures = params.maxConsecutiveFailures ?? 3;
    this.backoffBaseMs = params.backoffBaseMs ?? 60_000;
    this.backoffFactor = params.backoffFactor ?? 2;
    this.maxBackoffMs = params.maxBackoffMs ?? Number.POSITIVE_INFINITY;
    this.sleep = params.sleep ?? defaultSleep;

    const resume = params.resumeState;
    if (resume) this.usage = { ...resume.usage };

    this.view = {
      runId: this.runInfo.runId,
      objective: this.objective,
      agent: this.agent.name,
      status: "idle",
      branch: safeBranch(this.cwd),
      baseCommit: this.runInfo.baseCommit,
      currentIteration: resume?.currentIteration ?? 0,
      maxIterations: this.limits.maxIterations,
      maxTokens: this.limits.maxTokens,
      usage: resume ? { ...resume.usage } : { ...EMPTY_USAGE },
      commitCount: resume?.commitCount ?? 0,
      successCount: resume?.successCount ?? 0,
      failCount: resume?.failCount ?? 0,
      consecutiveFailures: 0,
      startedAt: 0,
      iterations: [],
    };
  }

  getView(): RunView {
    return structuredClone(this.view);
  }

  private emitState(): void {
    this.emit("state", this.getView());
  }

  private currentCard(): IterationView | undefined {
    return this.view.iterations[this.view.iterations.length - 1];
  }

  private setCardStatus(status: IterationStatus, error?: string): void {
    const card = this.currentCard();
    if (!card) return;
    card.status = status;
    if (error) card.error = error;
    if (
      status !== "running" &&
      status !== "queued" &&
      card.endedAt === undefined
    ) {
      card.endedAt = Date.now();
    }
  }

  /** First interrupt requests a graceful stop; a second forces immediate stop. */
  handleInterrupt(): void {
    this.interruptCount++;
    if (this.interruptCount >= 2) {
      this.stop();
      return;
    }
    this.stopRequested = true;
    this.emit("log", {
      level: "warn",
      message: "Graceful stop requested; finishing current iteration.",
    });
    // End any in-progress backoff early.
    this.controller?.abort();
  }

  /** Force an immediate stop, aborting any in-flight agent run. */
  stop(): void {
    this.forceStop = true;
    this.stopRequested = true;
    this.controller?.abort();
    this.emit("log", { level: "warn", message: "Force stop requested." });
  }

  private finish(status: RunView["status"], reason?: StopReason): RunView {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    this.view.status = status;
    this.view.stopReason = reason;
    this.view.endedAt = Date.now();
    this.view.usage = { ...this.usage };
    appendDebugLog("run:finished", { status, reason, usage: this.usage });
    const snapshot = this.getView();
    this.emit("state", snapshot);
    this.emit("done", snapshot);
    return snapshot;
  }

  async run(): Promise<RunView> {
    setDebugLogPath(this.runInfo.logPath);
    this.view.status = "running";
    this.view.startedAt = Date.now();
    appendDebugLog("run:started", {
      agent: this.agent.name,
      objective: clip(this.objective, 200),
      limits: this.limits,
    });
    this.emitState();
    this.armDurationCap();

    let backoffStreak = 0;

    try {
      while (true) {
        if (this.forceStop) return this.finish("stopped", "force-stop");
        if (this.stopRequested) return this.finish("stopped", "interrupt");
        if (this.durationCapHit)
          return this.finish("completed", "max-duration");

        if (
          this.limits.maxIterations !== undefined &&
          this.view.currentIteration >= this.limits.maxIterations
        ) {
          return this.finish("completed", "max-iterations");
        }

        if (
          this.limits.maxTokens !== undefined &&
          totalTokens(this.usage) >= this.limits.maxTokens
        ) {
          return this.finish("completed", "max-tokens");
        }

        const iteration = this.view.currentIteration + 1;
        this.view.currentIteration = iteration;
        this.startCard(iteration);
        this.emit("iteration:start", { iteration, agent: this.agent.name });
        this.emitState();

        const outcome = await this.runIteration(iteration);

        if (outcome.kind === "permanent") {
          return this.finish("aborted", "permanent-error");
        }
        if (outcome.kind === "push-failed") {
          return this.finish("aborted", "push-failed");
        }
        if (outcome.kind === "aborted") {
          if (this.tokenCapHit) return this.finish("completed", "max-tokens");
          if (this.durationCapHit) {
            return this.finish("completed", "max-duration");
          }
          return this.finish(
            "stopped",
            this.forceStop ? "force-stop" : "interrupt",
          );
        }

        if (outcome.kind === "success") {
          backoffStreak = 0;
          if (outcome.shouldFullyStop) {
            return this.finish("completed", "objective-complete");
          }
        } else {
          // failure or retryable error
          if (this.view.consecutiveFailures >= this.maxConsecutiveFailures) {
            return this.finish("aborted", "consecutive-failures");
          }
          if (outcome.shouldFullyStop) {
            return this.finish("completed", "objective-complete");
          }
          if (outcome.kind === "retryable") {
            backoffStreak++;
            const delay = Math.min(
              this.maxBackoffMs,
              this.backoffBaseMs * this.backoffFactor ** (backoffStreak - 1),
            );
            this.emit("log", {
              level: "warn",
              message: `Retryable error; backing off ${Math.round(
                delay / 1000,
              )}s.`,
            });
            this.controller = new AbortController();
            await this.sleep(delay, this.controller.signal);
            this.controller = null;
          } else {
            backoffStreak = 0;
          }
        }
      }
    } catch (error) {
      appendDebugLog("run:crashed", { error: serializeError(error) });
      this.setCardStatus("aborted", String(error));
      return this.finish("aborted", "permanent-error");
    } finally {
      try {
        await this.agent.close?.();
      } catch (error) {
        appendDebugLog("agent:close-failed", { error: serializeError(error) });
      }
    }
  }

  /**
   * Arm the wall-clock budget. When it elapses mid-iteration the current agent
   * run is aborted (like the token cap); the loop then reports `max-duration`.
   */
  private armDurationCap(): void {
    const budget = this.limits.maxDurationMs;
    if (budget === undefined || budget <= 0) return;
    this.durationTimer = setTimeout(() => {
      this.durationCapHit = true;
      this.emit("log", {
        level: "warn",
        message: `Max duration reached (${Math.round(budget / 1000)}s); stopping.`,
      });
      this.controller?.abort();
    }, budget);
    // Do not keep the event loop alive solely for this timer.
    this.durationTimer.unref?.();
  }

  private startCard(iteration: number): void {
    this.view.iterations.push({
      id: iteration,
      iteration,
      agent: this.agent.name,
      status: "running",
      changes: [],
      learnings: [],
      usage: { ...EMPTY_USAGE },
      startedAt: Date.now(),
    });
  }

  private async runIteration(iteration: number): Promise<IterationOutcome> {
    const prompt = buildIterationPrompt({
      iteration,
      runId: this.runInfo.runId,
      objective: this.objective,
      stopWhen: this.limits.stopWhen,
      commitRepair: this.pendingCommitRepair ?? undefined,
    });

    this.controller = new AbortController();
    this.tokenCapHit = false;
    let iterationUsage: TokenUsage = { ...EMPTY_USAGE };

    try {
      const result = await this.agent.run(prompt, this.cwd, {
        signal: this.controller.signal,
        logPath: this.runInfo.logPath,
        onMessage: (text) => {
          const card = this.currentCard();
          if (card) card.message = clip(text, 160);
          this.emit("iteration:message", { iteration, text });
          this.emitState();
        },
        onUsage: (usage) => {
          iterationUsage = usage;
          const card = this.currentCard();
          if (card) card.usage = usage;
          const projected = addUsage(this.usage, usage);
          this.view.usage = projected;
          this.emit("iteration:usage", { iteration, usage });
          if (
            this.limits.maxTokens !== undefined &&
            totalTokens(projected) >= this.limits.maxTokens
          ) {
            this.tokenCapHit = true;
            this.controller?.abort();
          }
          this.emitState();
        },
      });

      this.usage = addUsage(this.usage, result.usage);
      this.view.usage = { ...this.usage };

      return result.output.success
        ? this.handleSuccess(iteration, result.output)
        : this.handleReportedFailure(iteration, result.output);
    } catch (error) {
      this.usage = addUsage(this.usage, iterationUsage);
      this.view.usage = { ...this.usage };
      return this.handleThrown(iteration, error);
    } finally {
      this.controller = null;
    }
  }

  private handleSuccess(
    iteration: number,
    output: AgentOutput,
  ): IterationOutcome {
    const card = this.currentCard();
    if (card) {
      card.summary = output.summary;
      card.changes = output.key_changes_made;
      card.learnings = output.key_learnings;
    }

    const message = `${this.commitMessagePrefix}: iteration ${iteration} - ${clip(
      output.summary,
    )}`;

    try {
      const committed = commitAll(message, this.cwd);
      this.pendingCommitRepair = null;
      if (committed) this.view.commitCount++;
      appendNotes(this.runInfo.notesPath, iteration, output);

      if (this.limits.push && committed) {
        try {
          pushCurrentBranch(this.cwd);
        } catch (error) {
          appendDebugLog("git:push:failed", { error: serializeError(error) });
          this.setCardStatus("committed");
          this.emit("log", { level: "error", message: "Push failed." });
          this.emit("iteration:end", {
            iteration,
            status: "committed",
            output,
          });
          return { kind: "push-failed" };
        }
      }

      this.view.successCount++;
      this.view.consecutiveFailures = 0;
      this.setCardStatus("committed");
      this.emit("iteration:end", { iteration, status: "committed", output });
      this.emitState();
      return { kind: "success", shouldFullyStop: output.should_fully_stop };
    } catch (error) {
      if (error instanceof CommitFailedError) {
        // Preserve the working tree so the next iteration can repair it.
        this.pendingCommitRepair = `The previous iteration's git commit failed. Fix the cause, then ensure the working tree can be committed. Commit output:\n${error.detail}`;
        appendNotes(this.runInfo.notesPath, iteration, {
          summary: `${output.summary} (commit failed; preserving work for repair)`,
          key_changes_made: output.key_changes_made,
          key_learnings: [
            ...output.key_learnings,
            `Commit failed: ${error.detail}`,
          ],
        });
        this.view.failCount++;
        this.view.consecutiveFailures++;
        this.setCardStatus("repair", error.detail);
        this.emit("iteration:end", {
          iteration,
          status: "repair",
          output,
          error: error.detail,
        });
        this.emitState();
        return { kind: "failure", shouldFullyStop: false };
      }
      throw error;
    }
  }

  private handleReportedFailure(
    iteration: number,
    output: AgentOutput,
  ): IterationOutcome {
    const card = this.currentCard();
    if (card) {
      card.summary = output.summary;
      card.changes = output.key_changes_made;
      card.learnings = output.key_learnings;
    }
    if (!this.pendingCommitRepair) {
      resetHard(this.cwd);
    }
    this.view.failCount++;
    this.view.consecutiveFailures++;
    this.setCardStatus("discarded");
    this.emit("iteration:end", { iteration, status: "discarded", output });
    this.emitState();
    return { kind: "failure", shouldFullyStop: output.should_fully_stop };
  }

  private handleThrown(iteration: number, error: unknown): IterationOutcome {
    if (
      this.controller?.signal.aborted ||
      this.forceStop ||
      this.tokenCapHit ||
      this.durationCapHit
    ) {
      // Mid-iteration abort: discard the partial work.
      if (!this.pendingCommitRepair) {
        try {
          resetHard(this.cwd);
        } catch {
          // best effort
        }
      }
      this.setCardStatus("aborted");
      this.emit("iteration:end", {
        iteration,
        status: "aborted",
        error: String(error),
      });
      this.emitState();
      return { kind: "aborted" };
    }

    if (error instanceof PermanentAgentError) {
      if (!this.pendingCommitRepair) resetHard(this.cwd);
      this.setCardStatus("aborted", error.detail);
      this.emit("log", {
        level: "error",
        message: `Permanent agent error: ${error.message}`,
      });
      this.emit("iteration:end", {
        iteration,
        status: "aborted",
        error: error.detail,
      });
      this.emitState();
      return { kind: "permanent" };
    }

    if (!this.pendingCommitRepair) {
      try {
        resetHard(this.cwd);
      } catch {
        // best effort
      }
    }
    this.view.failCount++;
    this.view.consecutiveFailures++;
    const message = error instanceof Error ? error.message : String(error);
    appendDebugLog("iteration:error", {
      iteration,
      retryable: isRetryable(error),
      error: serializeError(error),
    });
    this.setCardStatus("discarded", message);
    this.emit("iteration:end", {
      iteration,
      status: "discarded",
      error: message,
    });
    this.emitState();
    return {
      kind: isRetryable(error) ? "retryable" : "failure",
      shouldFullyStop: false,
    };
  }
}

type IterationOutcome =
  | { kind: "success"; shouldFullyStop?: boolean }
  | { kind: "failure"; shouldFullyStop?: boolean }
  | { kind: "retryable"; shouldFullyStop?: boolean }
  | { kind: "permanent" }
  | { kind: "push-failed" }
  | { kind: "aborted" };

function safeBranch(cwd: string): string {
  try {
    return getCurrentBranch(cwd);
  } catch {
    return "(unknown)";
  }
}
