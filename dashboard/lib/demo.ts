/**
 * Self-contained board simulation used when `AUTORALPH_DASHBOARD_DEMO=1`, so
 * the dashboard can be previewed without a running CLI. It replays a scripted
 * two-agent session (claude + opencode) that exercises commits, a discarded
 * iteration, a retryable provider error with backoff, and a clean finish —
 * the same shape the CLI `demo` command emits.
 */
import type {
  BoardLogEntry,
  BoardSnapshot,
  IterationView,
  PersistedRun,
  RunHistorySummary,
  RunView,
  TokenUsage,
} from "./board";

const PER_ITERATION: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 800,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

interface Step {
  agent: "claude" | "opencode";
  summary: string;
  status: "committed" | "discarded";
  message: string;
  log?: { level: BoardLogEntry["level"]; message: string };
}

const CLAUDE_STEPS: Step[] = [
  {
    agent: "claude",
    summary: "Scaffold module skeleton",
    status: "committed",
    message: "Created package entrypoint and tsconfig",
  },
  {
    agent: "claude",
    summary: "Implement core function",
    status: "committed",
    message: "Added parser with unit coverage",
  },
  {
    agent: "claude",
    summary: "server_is_overloaded: provider busy",
    status: "discarded",
    message: "Provider returned 503",
    log: { level: "warn", message: "Retryable error; backing off 2s" },
  },
  {
    agent: "claude",
    summary: "Add tests",
    status: "committed",
    message: "Green suite, 12 assertions",
  },
];

const OPENCODE_STEPS: Step[] = [
  {
    agent: "opencode",
    summary: "Set up Cloudflare provider",
    status: "committed",
    message: "Wired Kimi model client",
  },
  {
    agent: "opencode",
    summary: "Attempted refactor did not improve anything",
    status: "discarded",
    message: "Reverted — no net change",
  },
  {
    agent: "opencode",
    summary: "Optimize hot path",
    status: "committed",
    message: "Cut allocations in inner loop",
    log: { level: "info", message: "Fell back to @cf/moonshotai/kimi-k2" },
  },
  {
    agent: "opencode",
    summary: "Document usage",
    status: "committed",
    message: "README quickstart + examples",
  },
];

function emptyRun(agent: "claude" | "opencode", startedAt: number): RunView {
  return {
    runId: `demo-${agent}-${startedAt}`,
    objective:
      agent === "claude"
        ? "Build a typed log parser with tests"
        : "Add Cloudflare Kimi provider and optimize",
    agent,
    status: "running",
    branch: "master",
    baseCommit: "d16bd0c8ca4023af9141081c798da75d908b8e41",
    currentIteration: 0,
    maxIterations: 4,
    maxTokens: 200_000,
    usage: { ...zeroUsage() },
    commitCount: 0,
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    startedAt,
    iterations: [],
  };
}

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/**
 * Produces the ordered list of snapshots that make up the demo timeline. Each
 * entry is a complete board snapshot, exactly as the SSE stream would push.
 */
export function demoTimeline(now = Date.now()): BoardSnapshot[] {
  const startedAt = now;
  const claude = emptyRun("claude", startedAt);
  const opencode = emptyRun("opencode", startedAt + 1);
  const logs: BoardLogEntry[] = [];
  const frames: BoardSnapshot[] = [];

  const snap = (): BoardSnapshot => ({
    runs: [structuredClone(claude), structuredClone(opencode)],
    logs: structuredClone(logs),
    startedAt,
  });

  frames.push(snap());

  const maxLen = Math.max(CLAUDE_STEPS.length, OPENCODE_STEPS.length);
  let clock = startedAt + 10;

  for (let i = 0; i < maxLen; i++) {
    for (const run of [claude, opencode]) {
      const steps = run.agent === "claude" ? CLAUDE_STEPS : OPENCODE_STEPS;
      const step = steps[i];
      if (!step) continue;

      // Running frame for this iteration.
      const iteration: IterationView = {
        id: i + 1,
        iteration: i + 1,
        agent: run.agent,
        status: "running",
        message: step.message,
        changes: [],
        learnings: [],
        usage: { ...zeroUsage() },
        startedAt: clock,
      };
      run.iterations.push(iteration);
      run.currentIteration = i + 1;
      logs.push({
        ts: clock,
        level: "info",
        message: `iteration ${i + 1} started`,
        runId: run.runId,
      });
      frames.push(snap());

      // Resolved frame.
      clock += 5;
      iteration.status = step.status;
      iteration.summary = step.summary;
      iteration.usage = { ...PER_ITERATION };
      iteration.endedAt = clock;
      iteration.message = undefined;
      if (step.status === "discarded") {
        iteration.error = step.summary;
        run.failCount += 1;
        run.consecutiveFailures += 1;
      } else {
        iteration.changes = [step.summary];
        run.commitCount += 1;
        run.successCount += 1;
        run.consecutiveFailures = 0;
      }
      run.usage = addUsage(run.usage, PER_ITERATION);
      if (step.log) {
        logs.push({ ts: clock, ...step.log, runId: run.runId });
      }
      frames.push(snap());
      clock += 5;
    }
  }

  // Finish both runs.
  for (const run of [claude, opencode]) {
    run.status = "completed";
    run.stopReason = "max-iterations";
    run.endedAt = clock;
    logs.push({
      ts: clock,
      level: "info",
      message: `run finished: max-iterations`,
      runId: run.runId,
    });
  }
  frames.push(snap());

  return frames;
}

/** The terminal snapshot of the demo timeline (used by the one-shot state API). */
export function demoSnapshot(now = Date.now()): BoardSnapshot {
  const frames = demoTimeline(now);
  return frames[frames.length - 1]!;
}

const HOUR = 60 * 60 * 1000;

/**
 * A couple of older, finished runs that only exist in "history" — they are not
 * part of the live timeline. This makes the demo history view show that runs
 * persist beyond the current session.
 */
function archivedRuns(now: number): PersistedRun[] {
  const mk = (
    runId: string,
    agent: "claude" | "opencode",
    objective: string,
    status: RunView["status"],
    stopReason: RunView["stopReason"],
    iterations: number,
    commits: number,
    fails: number,
    startedAt: number,
  ): PersistedRun => {
    const its: IterationView[] = Array.from({ length: iterations }, (_, i) => {
      const committed = i < commits;
      return {
        id: i + 1,
        iteration: i + 1,
        agent,
        status: committed ? "committed" : "discarded",
        summary: committed ? `Step ${i + 1} landed` : `Step ${i + 1} reverted`,
        changes: committed ? [`change ${i + 1}`] : [],
        learnings: [],
        usage: { ...PER_ITERATION },
        error: committed ? undefined : "no net change",
        startedAt: startedAt + i * 1000,
        endedAt: startedAt + i * 1000 + 500,
      };
    });
    return {
      run: {
        runId,
        objective,
        agent,
        status,
        stopReason,
        branch: `autoralph/${runId}`,
        baseCommit: "9f1c0d2",
        currentIteration: iterations,
        maxIterations: iterations,
        usage: {
          inputTokens: PER_ITERATION.inputTokens * iterations,
          outputTokens: PER_ITERATION.outputTokens * iterations,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        commitCount: commits,
        successCount: commits,
        failCount: fails,
        consecutiveFailures: 0,
        startedAt,
        endedAt: startedAt + iterations * 1000 + 800,
        iterations: its,
      },
      logs: [
        { ts: startedAt, level: "info", message: "run started", runId },
        {
          ts: startedAt + iterations * 1000 + 800,
          level: "info",
          message: `run finished: ${stopReason}`,
          runId,
        },
      ],
      savedAt: startedAt + iterations * 1000 + 900,
    };
  };

  return [
    mk(
      "demo-archive-auth",
      "claude",
      "Add OAuth login flow with tests",
      "completed",
      "objective-complete",
      5,
      5,
      0,
      now - 26 * HOUR,
    ),
    mk(
      "demo-archive-perf",
      "opencode",
      "Profile and speed up the render path",
      "aborted",
      "consecutive-failures",
      3,
      1,
      2,
      now - 3 * HOUR,
    ),
  ];
}

function summarize(
  run: RunView,
  live: boolean,
  savedAt?: number,
): RunHistorySummary {
  return {
    runId: run.runId,
    objective: run.objective,
    agent: run.agent,
    status: run.status,
    stopReason: run.stopReason,
    branch: run.branch,
    currentIteration: run.currentIteration,
    maxIterations: run.maxIterations,
    usage: run.usage,
    commitCount: run.commitCount,
    successCount: run.successCount,
    failCount: run.failCount,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    live,
    savedAt,
  };
}

/** All runs the demo history exposes: the two timeline runs plus archived ones. */
function demoPersistedRuns(now = Date.now()): PersistedRun[] {
  const snapshot = demoSnapshot(now);
  const fromTimeline: PersistedRun[] = snapshot.runs.map((run) => ({
    run,
    logs: snapshot.logs.filter((l) => l.runId === run.runId),
    savedAt: run.endedAt ?? now,
  }));
  return [...fromTimeline, ...archivedRuns(now)];
}

/** Demo history list, newest-first, mirroring the CLI's `/api/history`. */
export function demoHistory(now = Date.now()): RunHistorySummary[] {
  return demoPersistedRuns(now)
    .map((p) => summarize(p.run, p.run.status === "running", p.savedAt))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Demo detail for one run, mirroring `/api/history?runId=<id>`. */
export function demoHistoryRun(
  runId: string,
  now = Date.now(),
): PersistedRun | undefined {
  return demoPersistedRuns(now).find((p) => p.run.runId === runId);
}
