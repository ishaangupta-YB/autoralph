import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  branchExists,
  commitAll,
  createBranch,
  getCurrentBranch,
  isGitRepository,
  isWorkingTreeClean,
  resetHard,
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
