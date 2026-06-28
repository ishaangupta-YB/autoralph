import { describe, expect, it } from "vitest";

import { buildIterationPrompt } from "./prompt.js";

describe("buildIterationPrompt", () => {
  it("includes the objective, iteration number, and notes path", () => {
    const prompt = buildIterationPrompt({
      iteration: 3,
      runId: "my-run",
      objective: "Build a parser",
    });
    expect(prompt).toContain("iteration 3");
    expect(prompt).toContain("Build a parser");
    expect(prompt).toContain(".autoralph/runs/my-run/notes.md");
  });

  it("omits the stop section by default", () => {
    const prompt = buildIterationPrompt({
      iteration: 1,
      runId: "r",
      objective: "o",
    });
    expect(prompt).not.toContain("Stop Condition");
    expect(prompt).not.toContain("should_fully_stop");
  });

  it("adds the stop section and field when stopWhen is set", () => {
    const prompt = buildIterationPrompt({
      iteration: 1,
      runId: "r",
      objective: "o",
      stopWhen: "all tests pass",
    });
    expect(prompt).toContain("Stop Condition");
    expect(prompt).toContain("all tests pass");
    expect(prompt).toContain("should_fully_stop");
  });

  it("adds the repair section when a commit failed", () => {
    const prompt = buildIterationPrompt({
      iteration: 2,
      runId: "r",
      objective: "o",
      commitRepair: "pre-commit hook rejected the change",
    });
    expect(prompt).toContain("Commit Repair Required");
    expect(prompt).toContain("pre-commit hook rejected the change");
  });
});
