import { EventEmitter } from "node:events";

import type { RunView } from "../core/events.js";
import type { Orchestrator } from "../core/orchestrator.js";
import {
  summarizeRun,
  type BoardStore,
  type PersistedRun,
  type RunHistorySummary,
} from "./store.js";

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

interface BoardHubEvents {
  update: [BoardSnapshot];
}

const MAX_LOGS = 200;

/**
 * Aggregates state from one or more orchestrators into a single snapshot the
 * board renders. Supports multi-agent orchestration: each registered run is
 * tracked by runId and shown as its own column. Pure in-memory and transport
 * agnostic, so it is trivially unit-testable without a server.
 *
 * When constructed with a {@link BoardStore}, every run update is also written
 * through to disk so history survives process restarts and is queryable via
 * {@link history} / {@link historyRun} even after the run leaves memory.
 */
export class BoardHub extends EventEmitter<BoardHubEvents> {
  private runs = new Map<string, RunView>();
  private logs: BoardLogEntry[] = [];
  readonly startedAt = Date.now();

  constructor(private readonly store?: BoardStore) {
    super();
  }

  register(orchestrator: Orchestrator): void {
    const view = orchestrator.getView();
    this.runs.set(view.runId, view);

    orchestrator.on("state", (next) => {
      this.runs.set(next.runId, next);
      this.persist(next.runId);
      this.emit("update", this.snapshot());
    });
    orchestrator.on("log", (entry) => {
      this.pushLog({
        ts: Date.now(),
        level: entry.level,
        message: entry.message,
        runId: view.runId,
      });
      this.persist(view.runId);
      this.emit("update", this.snapshot());
    });
    orchestrator.on("done", (next) => {
      this.runs.set(next.runId, next);
      this.persist(next.runId);
      this.emit("update", this.snapshot());
    });

    this.persist(view.runId);
    this.emit("update", this.snapshot());
  }

  private logsFor(runId: string): BoardLogEntry[] {
    return this.logs.filter((entry) => entry.runId === runId);
  }

  private persist(runId: string): void {
    if (!this.store) return;
    const run = this.runs.get(runId);
    if (run) this.store.save(run, this.logsFor(runId));
  }

  /**
   * Unified run history: persisted runs from the store merged with runs still
   * live in this process (the live copy wins). Sorted newest-first.
   */
  history(): RunHistorySummary[] {
    const byId = new Map<string, RunHistorySummary>();
    if (this.store) {
      for (const entry of this.store.list()) {
        byId.set(
          entry.run.runId,
          summarizeRun(entry.run, false, entry.savedAt),
        );
      }
    }
    for (const run of this.runs.values()) {
      byId.set(run.runId, summarizeRun(run, run.status === "running"));
    }
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Full state + logs for one run, preferring the live in-memory copy. */
  historyRun(runId: string): PersistedRun | undefined {
    const live = this.runs.get(runId);
    if (live) {
      return { run: live, logs: this.logsFor(runId), savedAt: Date.now() };
    }
    return this.store?.load(runId);
  }

  pushLog(entry: BoardLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS);
    }
  }

  snapshot(): BoardSnapshot {
    return {
      runs: [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt),
      logs: this.logs,
      startedAt: this.startedAt,
    };
  }
}
