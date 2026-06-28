import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addWorktree,
  branchExists,
  commitAll,
  createBranch,
  getCurrentBranch,
  isGitRepository,
  isWorkingTreeClean,
  removeWorktree,
  resetHard,
  worktreeExists,
} from "./git.js";
import { gitLog, makeTempRepo } from "../test-utils.js";

let repo: { dir: string; cleanup: () => void };

beforeEach(() => {
  repo = makeTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

describe("git helpers", () => {
  it("detects a git repository", () => {
    expect(isGitRepository(repo.dir)).toBe(true);
  });

  it("creates and detects branches", () => {
    expect(branchExists("feature", repo.dir)).toBe(false);
    createBranch("feature", repo.dir);
    expect(getCurrentBranch(repo.dir)).toBe("feature");
    expect(branchExists("feature", repo.dir)).toBe(true);
  });

  it("commits all changes and reports whether anything was committed", () => {
    writeFileSync(join(repo.dir, "a.txt"), "hello");
    expect(commitAll("add a", repo.dir)).toBe(true);
    expect(gitLog(repo.dir)[0]).toBe("add a");
    // Nothing staged the second time.
    expect(commitAll("noop", repo.dir)).toBe(false);
  });

  it("resets the working tree to HEAD", () => {
    writeFileSync(join(repo.dir, "dirty.txt"), "uncommitted");
    expect(isWorkingTreeClean(repo.dir)).toBe(false);
    resetHard(repo.dir);
    expect(isWorkingTreeClean(repo.dir)).toBe(true);
  });
});

describe("git worktrees", () => {
  it("adds an isolated worktree on a new branch and removes it", () => {
    const path = join(repo.dir, ".autoralph", "worktrees", "run-1");
    expect(worktreeExists(path, repo.dir)).toBe(false);

    addWorktree(path, "autoralph/run-1", repo.dir);
    expect(worktreeExists(path, repo.dir)).toBe(true);
    expect(branchExists("autoralph/run-1", repo.dir)).toBe(true);
    // The worktree has its own checkout of the same repository.
    expect(getCurrentBranch(path)).toBe("autoralph/run-1");

    removeWorktree(path, repo.dir);
    expect(worktreeExists(path, repo.dir)).toBe(false);
    // Removing the worktree keeps the branch (and any commits) intact.
    expect(branchExists("autoralph/run-1", repo.dir)).toBe(true);
  });

  it("checks out an existing branch when adding a worktree", () => {
    createBranch("existing", repo.dir);
    // Return to the default branch so `existing` is free for the worktree.
    const def = gitLog(repo.dir); // touch repo to ensure a commit exists
    expect(def.length).toBeGreaterThan(0);
    createBranch("main-work", repo.dir);

    const path = join(repo.dir, ".autoralph", "worktrees", "run-2");
    addWorktree(path, "existing", repo.dir);
    expect(getCurrentBranch(path)).toBe("existing");
    removeWorktree(path, repo.dir);
  });
});
