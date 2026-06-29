import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendNotes,
  listRunConfigs,
  readNotes,
  readRunConfig,
  setupRun,
  writeRunConfig,
  type RunConfig,
} from "./run.js";
import { DEFAULT_RETRY } from "./config.js";
import { makeTempRepo } from "../test-utils.js";

let repo: { dir: string; cleanup: () => void };

beforeEach(() => {
  repo = makeTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

describe("setupRun", () => {
  it("creates run metadata and excludes it from version control", () => {
    const info = setupRun({
      runId: "run-1",
      objective: "do the thing",
      baseCommit: "abc",
      cwd: repo.dir,
      stopWhen: "done",
    });

    expect(existsSync(info.promptPath)).toBe(true);
    expect(existsSync(info.notesPath)).toBe(true);
    expect(existsSync(info.schemaPath)).toBe(true);
    expect(readFileSync(info.promptPath, "utf-8")).toContain("do the thing");

    const schema = JSON.parse(readFileSync(info.schemaPath, "utf-8"));
    expect(schema.properties.should_fully_stop).toBeDefined();

    const exclude = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: repo.dir, encoding: "utf-8" },
    ).trim();
    expect(readFileSync(join(repo.dir, exclude), "utf-8")).toContain(
      ".autoralph/",
    );
  });

  it("does not duplicate the ignore rule on repeated setup", () => {
    setupRun({ runId: "a", objective: "o", baseCommit: "", cwd: repo.dir });
    setupRun({ runId: "b", objective: "o", baseCommit: "", cwd: repo.dir });
    const exclude = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: repo.dir, encoding: "utf-8" },
    ).trim();
    const content = readFileSync(join(repo.dir, exclude), "utf-8");
    const occurrences = content
      .split("\n")
      .filter((l) => l.trim() === ".autoralph/").length;
    expect(occurrences).toBe(1);
  });
});

describe("appendNotes / readNotes", () => {
  it("appends iteration entries that can be read back", () => {
    const info = setupRun({
      runId: "notes",
      objective: "o",
      baseCommit: "",
      cwd: repo.dir,
    });
    appendNotes(info.notesPath, 1, {
      summary: "did A",
      key_changes_made: ["change one"],
      key_learnings: ["learned one"],
    });
    const notes = readNotes(info.notesPath);
    expect(notes).toContain("Iteration 1");
    expect(notes).toContain("did A");
    expect(notes).toContain("change one");
    expect(notes).toContain("learned one");
  });
});

describe("run config persistence", () => {
  function sample(runId: string, objective = "build it"): RunConfig {
    return {
      runId,
      objective,
      agent: "claude",
      model: "m",
      fallbackModels: [],
      branch: `autoralph/${runId}`,
      useCurrentBranch: false,
      push: false,
      retry: { ...DEFAULT_RETRY },
      createdAt: Date.now(),
    };
  }

  it("round-trips a run config through disk", () => {
    writeRunConfig(repo.dir, sample("run-x"));
    const read = readRunConfig(repo.dir, "run-x");
    expect(read?.objective).toBe("build it");
    expect(read?.retry.maxConsecutiveFailures).toBe(
      DEFAULT_RETRY.maxConsecutiveFailures,
    );
  });

  it("returns null for an unknown run", () => {
    expect(readRunConfig(repo.dir, "ghost")).toBeNull();
  });

  it("lists persisted runs newest-first", () => {
    writeRunConfig(repo.dir, { ...sample("old"), createdAt: 1 });
    writeRunConfig(repo.dir, { ...sample("new"), createdAt: 2 });
    expect(listRunConfigs(repo.dir).map((c) => c.runId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("lists nothing when no runs exist", () => {
    expect(listRunConfigs(repo.dir)).toEqual([]);
  });
});
