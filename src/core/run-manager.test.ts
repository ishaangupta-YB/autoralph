import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BoardHub } from "../board/hub.js";
import { FileBoardStore } from "../board/store.js";
import { makeTempRepo } from "../test-utils.js";
import { defaultConfig } from "./config.js";
import { branchExists, worktreeExists } from "./git.js";
import { RunManager } from "./run-manager.js";
import { readRunConfig } from "./run.js";

let repo: { dir: string; cleanup: () => void };

beforeEach(() => {
  repo = makeTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

function build(): {
  mgr: RunManager;
  hub: BoardHub;
  store: FileBoardStore;
  cwd: string;
} {
  const cwd = repo.dir;
  const store = new FileBoardStore(join(cwd, ".autoralph", "history"));
  const hub = new BoardHub(store);
  const mgr = new RunManager({ cwd, baseConfig: defaultConfig(), hub, store });
  return { mgr, hub, store, cwd };
}

describe("RunManager", () => {
  it("launches a worktree-isolated run and persists its config", () => {
    const { mgr, hub, cwd } = build();
    const { config } = mgr.launch("Add a feature", { worktree: true });

    expect(config.worktreePath).toBeDefined();
    expect(worktreeExists(config.worktreePath!, cwd)).toBe(true);
    expect(branchExists(config.branch, cwd)).toBe(true);
    expect(readRunConfig(cwd, config.runId)?.objective).toBe("Add a feature");
    expect(hub.liveRunIds()).toContain(config.runId);

    mgr.cleanupWorktrees();
    expect(worktreeExists(config.worktreePath!, cwd)).toBe(false);
    // The branch (and its commits) survives worktree cleanup.
    expect(branchExists(config.branch, cwd)).toBe(true);
  });

  it("gives parallel launches unique branches and worktrees", () => {
    const { mgr, cwd } = build();
    const a = mgr.launch("same objective", { worktree: true });
    const b = mgr.launch("same objective", { worktree: true });

    expect(a.config.branch).not.toBe(b.config.branch);
    expect(a.config.worktreePath).not.toBe(b.config.worktreePath);
    expect(worktreeExists(a.config.worktreePath!, cwd)).toBe(true);
    expect(worktreeExists(b.config.worktreePath!, cwd)).toBe(true);

    mgr.cleanupWorktrees();
  });

  it("resumes a persisted run, seeding counters from the store", () => {
    const { mgr, store } = build();
    const { config, orchestrator } = mgr.launch("resume me", {
      worktree: true,
    });
    // Persist prior progress as the board would.
    store.save(
      { ...orchestrator.getView(), currentIteration: 3, commitCount: 3 },
      [],
    );

    const resumed = mgr.resume(config.runId);
    expect(resumed.orchestrator.getView().currentIteration).toBe(3);
    expect(resumed.orchestrator.getView().commitCount).toBe(3);

    mgr.cleanupWorktrees();
  });

  it("throws when resuming an unknown run", () => {
    const { mgr } = build();
    expect(() => mgr.resume("does-not-exist")).toThrow(/no persisted run/i);
  });
});
