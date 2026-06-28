import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { RunStatus, RunView, StopReason } from "../core/events.js";
import type { TokenUsage } from "../agents/types.js";
import type { BoardLogEntry } from "./hub.js";

/** A run's full state plus its log lines, persisted as one JSON file. */
export interface PersistedRun {
  run: RunView;
  logs: BoardLogEntry[];
  savedAt: number;
}

/** Lightweight row for the history list — enough to render a card. */
export interface RunHistorySummary {
  runId: string;
  objective: string;
  agent: string;
  status: RunStatus;
  stopReason?: StopReason;
  branch: string;
  currentIteration: number;
  maxIterations?: number;
  usage: TokenUsage;
  commitCount: number;
  successCount: number;
  failCount: number;
  startedAt: number;
  endedAt?: number;
  /** True while the run is still active in the current board process. */
  live: boolean;
  savedAt?: number;
}

/**
 * Persistence boundary for run history. The board hub writes through this and
 * reads back past runs so history survives process restarts. Kept as an
 * interface so tests can substitute an in-memory implementation.
 */
export interface BoardStore {
  save(run: RunView, logs: BoardLogEntry[]): void;
  load(runId: string): PersistedRun | undefined;
  list(): PersistedRun[];
}

export function summarizeRun(
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

function safeFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/**
 * File-backed store writing one `<runId>.json` per run under a directory
 * (conventionally `.autoralph/history/`). Writes are full-document overwrites
 * — runs update infrequently (per iteration), so this stays simple and atomic
 * enough without a database. Malformed files are skipped rather than throwing.
 */
export class FileBoardStore implements BoardStore {
  constructor(private readonly dir: string) {}

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  save(run: RunView, logs: BoardLogEntry[]): void {
    this.ensureDir();
    const payload: PersistedRun = { run, logs, savedAt: Date.now() };
    const dest = join(this.dir, safeFileName(run.runId));
    const tmp = join(this.dir, `.${safeFileName(run.runId)}.tmp`);
    writeFileSync(tmp, JSON.stringify(payload), "utf-8");
    // Rename is atomic on the same filesystem, so a concurrent list()/load()
    // never observes a half-written document.
    renameSync(tmp, dest);
  }

  load(runId: string): PersistedRun | undefined {
    const file = join(this.dir, safeFileName(runId));
    if (!existsSync(file)) return undefined;
    return this.read(file);
  }

  list(): PersistedRun[] {
    if (!existsSync(this.dir)) return [];
    const out: PersistedRun[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const parsed = this.read(join(this.dir, name));
      if (parsed) out.push(parsed);
    }
    return out.sort((a, b) => b.run.startedAt - a.run.startedAt);
  }

  private read(file: string): PersistedRun | undefined {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as PersistedRun;
      if (parsed && parsed.run && typeof parsed.run.runId === "string") {
        return parsed;
      }
    } catch {
      // skip malformed/partial file
    }
    return undefined;
  }
}
