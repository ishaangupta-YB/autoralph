import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BoardColumns,
  LogBand,
  Metric,
  RunCard,
  StatusBadge,
} from "@/components/Board";
import { LaunchForm, StopControls, type ControlState } from "@/components/Controls";
import type { IterationView, RunView } from "@/lib/board";

function iteration(
  id: number,
  status: IterationView["status"],
  agent = "claude",
): IterationView {
  return {
    id,
    iteration: id,
    agent,
    status,
    summary: `iter ${id}`,
    changes: status === "committed" ? [`change ${id}`] : [],
    learnings: [],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    startedAt: 1000 + id,
  };
}

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    objective: "Build a thing",
    agent: "claude",
    status: "running",
    branch: "autoralph/run-1",
    baseCommit: "abc1234",
    currentIteration: 2,
    maxIterations: 4,
    usage: {
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    commitCount: 1,
    successCount: 1,
    failCount: 1,
    consecutiveFailures: 0,
    startedAt: 1000,
    iterations: [iteration(1, "committed"), iteration(2, "running")],
    ...overrides,
  };
}

const caps = (over: Partial<ControlState> = {}): ControlState => ({
  canLaunch: false,
  agents: [],
  liveRuns: [],
  connected: true,
  demo: false,
  ...over,
});

describe("StatusBadge / Metric", () => {
  it("renders a status-specific badge class", () => {
    const html = renderToStaticMarkup(<StatusBadge status="completed" />);
    expect(html).toContain("badge--completed");
    expect(html).toContain("completed");
  });

  it("renders a labelled metric", () => {
    const html = renderToStaticMarkup(<Metric value="3/4" label="iter" />);
    expect(html).toContain("3/4");
    expect(html).toContain("iter");
  });
});

describe("RunCard", () => {
  it("shows the objective, progress and stop controls when live", () => {
    const html = renderToStaticMarkup(
      <RunCard run={run()} color="#fff" canStop onStopped={() => {}} />,
    );
    expect(html).toContain("Build a thing");
    expect(html).toContain("2/4");
    // Stop controls present for a live run.
    expect(html).toContain("Stop");
    expect(html).toContain("Force");
  });

  it("hides stop controls when not live", () => {
    const html = renderToStaticMarkup(
      <RunCard run={run({ status: "completed" })} color="#fff" />,
    );
    expect(html).not.toContain("stopctl");
  });
});

describe("BoardColumns", () => {
  it("buckets iterations into their kanban columns", () => {
    const html = renderToStaticMarkup(<BoardColumns runs={[run()]} />);
    expect(html).toContain("In Progress");
    expect(html).toContain("Committed");
    expect(html).toContain("iter 1");
  });
});

describe("LogBand", () => {
  it("renders log lines, newest visible", () => {
    const logs = [
      { ts: 1000, level: "info" as const, message: "started" },
      { ts: 2000, level: "warn" as const, message: "backing off" },
    ];
    const html = renderToStaticMarkup(
      <LogBand logs={logs} count={logs.length} />,
    );
    expect(html).toContain("started");
    expect(html).toContain("backing off");
    expect(html).toContain("2 events");
  });

  it("shows an empty state with no logs", () => {
    const html = renderToStaticMarkup(<LogBand logs={[]} count={0} />);
    expect(html).toContain("Waiting for events");
  });
});

describe("LaunchForm", () => {
  it("explains when run control is disabled", () => {
    const html = renderToStaticMarkup(<LaunchForm caps={caps()} />);
    expect(html).toContain("Run control is disabled");
    expect(html).not.toContain("<textarea");
  });

  it("renders the start form with the board's agents when enabled", () => {
    const html = renderToStaticMarkup(
      <LaunchForm caps={caps({ canLaunch: true, agents: ["claude", "opencode"] })} />,
    );
    expect(html).toContain("<textarea");
    expect(html).toContain("claude");
    expect(html).toContain("opencode");
    expect(html).toContain("Start run");
  });
});

describe("StopControls", () => {
  it("renders graceful and force stop buttons", () => {
    const html = renderToStaticMarkup(<StopControls runId="run-1" />);
    expect(html).toContain("Stop");
    expect(html).toContain("Force");
    expect(html).toContain("ghost-btn--danger");
  });
});
