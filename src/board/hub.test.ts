import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { BoardHub } from "./hub.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { RunView } from "../core/events.js";

function baseView(runId: string): RunView {
  return {
    runId,
    objective: "o",
    agent: "claude",
    status: "running",
    branch: "main",
    baseCommit: "",
    currentIteration: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    commitCount: 0,
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    startedAt: Date.now(),
    iterations: [],
  };
}

/** Minimal Orchestrator stand-in exposing only what BoardHub consumes. */
function fakeOrchestrator(view: RunView): Orchestrator {
  const emitter = new EventEmitter() as unknown as Orchestrator & EventEmitter;
  (emitter as unknown as { getView: () => RunView }).getView = () => view;
  return emitter as unknown as Orchestrator;
}

describe("BoardHub", () => {
  it("tracks multiple runs sorted by start time", () => {
    const hub = new BoardHub();
    const a = baseView("a");
    a.startedAt = 1;
    const b = baseView("b");
    b.startedAt = 2;
    hub.register(fakeOrchestrator(a));
    hub.register(fakeOrchestrator(b));
    const snap = hub.snapshot();
    expect(snap.runs.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("updates a run's state and emits on changes", () => {
    const hub = new BoardHub();
    const view = baseView("a");
    const orch = fakeOrchestrator(view);
    hub.register(orch);

    const updates: number[] = [];
    hub.on("update", (snap) => updates.push(snap.runs[0]!.currentIteration));

    const next = { ...view, currentIteration: 5 };
    (orch as unknown as EventEmitter).emit("state", next);
    expect(hub.snapshot().runs[0]!.currentIteration).toBe(5);
    expect(updates).toContain(5);
  });

  it("records and caps log entries", () => {
    const hub = new BoardHub();
    const orch = fakeOrchestrator(baseView("a"));
    hub.register(orch);
    (orch as unknown as EventEmitter).emit("log", {
      level: "warn",
      message: "heads up",
    });
    const snap = hub.snapshot();
    expect(snap.logs.at(-1)).toMatchObject({
      level: "warn",
      message: "heads up",
    });
  });
});
