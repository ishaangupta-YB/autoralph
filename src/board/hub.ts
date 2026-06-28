import { EventEmitter } from "node:events";

import type { RunView } from "../core/events.js";
import type { Orchestrator } from "../core/orchestrator.js";

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
 */
export class BoardHub extends EventEmitter<BoardHubEvents> {
  private runs = new Map<string, RunView>();
  private logs: BoardLogEntry[] = [];
  readonly startedAt = Date.now();

  register(orchestrator: Orchestrator): void {
    const view = orchestrator.getView();
    this.runs.set(view.runId, view);

    orchestrator.on("state", (next) => {
      this.runs.set(next.runId, next);
      this.emit("update", this.snapshot());
    });
    orchestrator.on("log", (entry) => {
      this.pushLog({
        ts: Date.now(),
        level: entry.level,
        message: entry.message,
        runId: view.runId,
      });
      this.emit("update", this.snapshot());
    });
    orchestrator.on("done", (next) => {
      this.runs.set(next.runId, next);
      this.emit("update", this.snapshot());
    });

    this.emit("update", this.snapshot());
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
