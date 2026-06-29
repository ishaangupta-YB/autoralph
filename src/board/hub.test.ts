import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { BoardHub, type BoardLogEntry } from "./hub.js";
import type { BoardStore, PersistedRun } from "./store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { RunView } from "../core/events.js";

/** In-memory store so history behaviour is testable without touching disk. */
class MemoryStore implements BoardStore {
  saves: PersistedRun[] = [];
  private map = new Map<string, PersistedRun>();
  save(run: RunView, logs: BoardLogEntry[]): void {
    const entry: PersistedRun = { run, logs, savedAt: Date.now() };
    this.saves.push(entry);
    this.map.set(run.runId, entry);
  }
  load(runId: string): PersistedRun | undefined {
    return this.map.get(runId);
  }
  list(): PersistedRun[] {
    return [...this.map.values()];
  }
}

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

  it("persists each run update through the store with that run's logs", () => {
    const store = new MemoryStore();
    const hub = new BoardHub(store);
    const orch = fakeOrchestrator(baseView("a"));
    hub.register(orch);
    (orch as unknown as EventEmitter).emit("log", {
      level: "info",
      message: "tick",
    });

    const saved = store.load("a");
    expect(saved?.run.runId).toBe("a");
    expect(saved?.logs.map((l) => l.message)).toContain("tick");
  });

  it("merges live runs over persisted history, newest-first", () => {
    const store = new MemoryStore();
    const past = baseView("past");
    past.startedAt = 1;
    past.status = "completed";
    store.save(past, []);

    const hub = new BoardHub(store);
    const live = baseView("live");
    live.startedAt = 10;
    hub.register(fakeOrchestrator(live));

    const history = hub.history();
    expect(history.map((h) => h.runId)).toEqual(["live", "past"]);
    expect(history.find((h) => h.runId === "live")?.live).toBe(true);
    expect(history.find((h) => h.runId === "past")?.live).toBe(false);
  });

  it("stops a live run gracefully or forcefully and reports live ids", () => {
    const hub = new BoardHub();
    const view = baseView("a");
    const orch = fakeOrchestrator(view);
    const stop = vi.fn();
    const handleInterrupt = vi.fn();
    (orch as unknown as { stop: () => void }).stop = stop;
    (orch as unknown as { handleInterrupt: () => void }).handleInterrupt =
      handleInterrupt;
    hub.register(orch);

    expect(hub.liveRunIds()).toEqual(["a"]);

    expect(hub.stopRun("a", false)).toBe(true);
    expect(handleInterrupt).toHaveBeenCalledTimes(1);

    expect(hub.stopRun("a", true)).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);

    expect(hub.stopRun("missing", false)).toBe(false);
  });

  it("returns a single run from memory, falling back to the store", () => {
    const store = new MemoryStore();
    store.save(baseView("archived"), [
      { ts: 1, level: "info", message: "done", runId: "archived" },
    ]);
    const hub = new BoardHub(store);
    hub.register(fakeOrchestrator(baseView("active")));

    expect(hub.historyRun("active")?.run.runId).toBe("active");
    expect(hub.historyRun("archived")?.logs[0]?.message).toBe("done");
    expect(hub.historyRun("ghost")).toBeUndefined();
  });
});
