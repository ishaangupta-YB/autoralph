import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileBoardStore, summarizeRun } from "./store.js";
import type { BoardLogEntry } from "./hub.js";
import type { RunView } from "../core/events.js";

function view(runId: string, startedAt: number): RunView {
  return {
    runId,
    objective: `objective ${runId}`,
    agent: "claude",
    status: "completed",
    stopReason: "max-iterations",
    branch: "autoralph/x",
    baseCommit: "abc",
    currentIteration: 2,
    maxIterations: 4,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    commitCount: 2,
    successCount: 2,
    failCount: 0,
    consecutiveFailures: 0,
    startedAt,
    endedAt: startedAt + 100,
    iterations: [],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autoralph-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileBoardStore", () => {
  it("saves and loads a run with its logs", () => {
    const store = new FileBoardStore(join(dir, "history"));
    const logs: BoardLogEntry[] = [
      { ts: 1, level: "info", message: "hello", runId: "r1" },
    ];
    store.save(view("r1", 1), logs);

    const loaded = store.load("r1");
    expect(loaded?.run.runId).toBe("r1");
    expect(loaded?.logs).toEqual(logs);
    expect(typeof loaded?.savedAt).toBe("number");
  });

  it("returns undefined for an unknown run", () => {
    const store = new FileBoardStore(join(dir, "history"));
    expect(store.load("missing")).toBeUndefined();
  });

  it("lists runs newest-first and overwrites on re-save", () => {
    const store = new FileBoardStore(join(dir, "history"));
    store.save(view("old", 1), []);
    store.save(view("new", 5), []);
    store.save({ ...view("old", 1), commitCount: 9 }, []);

    const list = store.list();
    expect(list.map((p) => p.run.runId)).toEqual(["new", "old"]);
    expect(list[1]!.run.commitCount).toBe(9);
  });

  it("skips malformed and hidden files when listing", () => {
    const historyDir = join(dir, "history");
    const store = new FileBoardStore(historyDir);
    store.save(view("good", 1), []);
    writeFileSync(join(historyDir, "broken.json"), "{ not json", "utf-8");
    writeFileSync(join(historyDir, ".hidden.json"), "{}", "utf-8");

    const list = store.list();
    expect(list.map((p) => p.run.runId)).toEqual(["good"]);
  });

  it("lists nothing when the directory does not exist", () => {
    const store = new FileBoardStore(join(dir, "nope"));
    expect(store.list()).toEqual([]);
  });
});

describe("summarizeRun", () => {
  it("projects the fields a history row needs and carries the live flag", () => {
    const summary = summarizeRun(view("r1", 1), true, 42);
    expect(summary).toMatchObject({
      runId: "r1",
      agent: "claude",
      status: "completed",
      commitCount: 2,
      live: true,
      savedAt: 42,
    });
    expect(summary).not.toHaveProperty("iterations");
  });
});
