import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SimulationAgent, type SimulationStep } from "../agents/simulation.js";
import type { Agent, AgentResult } from "../agents/types.js";
import { Orchestrator } from "./orchestrator.js";
import { getHeadCommit } from "./git.js";
import { setupRun, readNotes, type RunInfo } from "./run.js";
import { gitLog, makeTempRepo } from "../test-utils.js";

let repo: { dir: string; cleanup: () => void };

beforeEach(() => {
  repo = makeTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

function makeRun(): RunInfo {
  return setupRun({
    runId: "test-run",
    objective: "build the thing",
    baseCommit: getHeadCommit(repo.dir),
    cwd: repo.dir,
  });
}

const success = (summary: string, file: string): SimulationStep => ({
  output: {
    success: true,
    summary,
    key_changes_made: [`wrote ${file}`],
    key_learnings: [],
  },
  writeFile: { path: file, content: `${summary}\n` },
});

function orchestrator(agent: Agent, overrides = {}): Orchestrator {
  return new Orchestrator({
    agent,
    runInfo: makeRun(),
    objective: "build the thing",
    cwd: repo.dir,
    backoffBaseMs: 1,
    sleep: async () => {},
    ...overrides,
  });
}

describe("Orchestrator success path", () => {
  it("commits each successful iteration and stops at max-iterations", async () => {
    const agent = new SimulationAgent({
      steps: [success("step one", "a.txt"), success("step two", "b.txt")],
      onExhausted: "noop",
    });
    const orch = orchestrator(agent, { limits: { maxIterations: 2 } });
    const view = await orch.run();

    expect(view.status).toBe("completed");
    expect(view.stopReason).toBe("max-iterations");
    expect(view.commitCount).toBe(2);
    expect(view.successCount).toBe(2);

    const log = gitLog(repo.dir);
    expect(log[0]).toContain("step two");
    expect(log[1]).toContain("step one");
    expect(readNotes(makeRun().notesPath)).toContain("step one");
  });

  it("stops when the agent sets should_fully_stop", async () => {
    const agent = new SimulationAgent({
      steps: [
        {
          output: {
            success: true,
            summary: "all done",
            key_changes_made: ["finished"],
            key_learnings: [],
            should_fully_stop: true,
          },
          writeFile: { path: "done.txt", content: "done\n" },
        },
      ],
    });
    const orch = orchestrator(agent, {
      limits: { maxIterations: 10, stopWhen: "the thing is built" },
    });
    const view = await orch.run();
    expect(view.status).toBe("completed");
    expect(view.stopReason).toBe("objective-complete");
    expect(view.currentIteration).toBe(1);
  });
});

describe("Orchestrator failure handling", () => {
  it("resets the working tree on a reported failure", async () => {
    const agent = new SimulationAgent({
      steps: [
        {
          output: {
            success: false,
            summary: "did not help",
            key_changes_made: [],
            key_learnings: ["dead end"],
          },
          writeFile: { path: "junk.txt", content: "junk\n" },
        },
        success("recovered", "good.txt"),
      ],
    });
    const orch = orchestrator(agent, { limits: { maxIterations: 2 } });
    const view = await orch.run();
    expect(view.failCount).toBe(1);
    expect(view.successCount).toBe(1);
    // The discarded file must not have been committed.
    expect(gitLog(repo.dir).some((m) => m.includes("did not help"))).toBe(
      false,
    );
  });

  it("aborts after three consecutive failures", async () => {
    const fail: SimulationStep = {
      output: {
        success: false,
        summary: "nope",
        key_changes_made: [],
        key_learnings: [],
      },
    };
    const agent = new SimulationAgent({
      steps: [fail, fail, fail, fail],
      onExhausted: "repeat-last",
    });
    const orch = orchestrator(agent, { limits: { maxIterations: 10 } });
    const view = await orch.run();
    expect(view.status).toBe("aborted");
    expect(view.stopReason).toBe("consecutive-failures");
  });

  it("aborts immediately on a permanent agent error", async () => {
    const agent = new SimulationAgent({
      steps: [{ throwPermanent: "credit balance is too low" }],
    });
    const orch = orchestrator(agent, { limits: { maxIterations: 5 } });
    const view = await orch.run();
    expect(view.status).toBe("aborted");
    expect(view.stopReason).toBe("permanent-error");
  });

  it("backs off and recovers from a retryable error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const agent = new SimulationAgent({
      steps: [
        { throwRetryable: "server_is_overloaded" },
        success("after backoff", "ok.txt"),
      ],
    });
    const orch = orchestrator(agent, {
      limits: { maxIterations: 2 },
      sleep,
      backoffBaseMs: 1000,
    });
    const view = await orch.run();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(1000);
    expect(view.successCount).toBe(1);
    expect(view.failCount).toBe(1);
  });
});

describe("Orchestrator token cap", () => {
  it("completes with max-tokens once the budget is exceeded", async () => {
    const agent = new SimulationAgent({
      steps: [
        {
          ...success("big step", "big.txt"),
          usage: { inputTokens: 6000, outputTokens: 6000 },
        },
        success("should not run", "never.txt"),
      ],
      onExhausted: "repeat-last",
    });
    const orch = orchestrator(agent, { limits: { maxTokens: 5000 } });
    const view = await orch.run();
    expect(view.stopReason).toBe("max-tokens");
    expect(view.status).toBe("completed");
  });
});

describe("Orchestrator shutdown", () => {
  it("force stop ends the run", async () => {
    const agent: Agent = {
      name: "stuck",
      run: (_p, _c, options) =>
        new Promise<AgentResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("Agent was aborted")),
          );
        }),
    };
    const orch = orchestrator(agent, { limits: { maxIterations: 5 } });
    const promise = orch.run();
    await new Promise((r) => setTimeout(r, 10));
    orch.stop();
    const view = await promise;
    expect(view.status).toBe("stopped");
    expect(view.stopReason).toBe("force-stop");
  });

  it("graceful interrupt stops after the current iteration", async () => {
    const agent = new SimulationAgent({
      steps: [success("one", "a.txt"), success("two", "b.txt")],
      onExhausted: "repeat-last",
    });
    const orch = orchestrator(agent, { limits: { maxIterations: 10 } });
    orch.on("iteration:end", () => orch.handleInterrupt());
    const view = await orch.run();
    expect(view.status).toBe("stopped");
    expect(view.stopReason).toBe("interrupt");
    expect(view.currentIteration).toBe(1);
  });
});

describe("Orchestrator events", () => {
  it("emits lifecycle events consumed by the board", async () => {
    const agent = new SimulationAgent({ steps: [success("only", "a.txt")] });
    const orch = orchestrator(agent, { limits: { maxIterations: 1 } });
    const starts: number[] = [];
    let doneFired = false;
    orch.on("iteration:start", (e) => starts.push(e.iteration));
    orch.on("done", () => {
      doneFired = true;
    });
    await orch.run();
    expect(starts).toEqual([1]);
    expect(doneFired).toBe(true);
  });
});
