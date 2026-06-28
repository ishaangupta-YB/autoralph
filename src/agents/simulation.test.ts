import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SimulationAgent } from "./simulation.js";
import { PermanentAgentError } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sim-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ok = {
  success: true,
  summary: "did it",
  key_changes_made: ["x"],
  key_learnings: [],
};

describe("SimulationAgent", () => {
  it("replays scripted steps in order and writes files", async () => {
    const agent = new SimulationAgent({
      steps: [{ output: ok, writeFile: { path: "out.txt", content: "hi" } }],
    });
    const result = await agent.run("p", dir);
    expect(result.output.summary).toBe("did it");
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
    expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("hi");
  });

  it("reports a no-op once steps are exhausted in noop mode", async () => {
    const agent = new SimulationAgent({ steps: [{ output: ok }] });
    await agent.run("p", dir);
    const second = await agent.run("p", dir);
    expect(second.output.success).toBe(false);
  });

  it("repeats the last step in repeat-last mode", async () => {
    const agent = new SimulationAgent({
      steps: [{ output: ok }],
      onExhausted: "repeat-last",
    });
    await agent.run("p", dir);
    const second = await agent.run("p", dir);
    expect(second.output.success).toBe(true);
  });

  it("throws a permanent error when scripted", async () => {
    const agent = new SimulationAgent({
      steps: [{ throwPermanent: "no credit" }],
    });
    await expect(agent.run("p", dir)).rejects.toBeInstanceOf(
      PermanentAgentError,
    );
  });

  it("throws a retryable error flagged for backoff", async () => {
    const agent = new SimulationAgent({
      steps: [{ throwRetryable: "overloaded" }],
    });
    await expect(agent.run("p", dir)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("streams messages to the onMessage callback", async () => {
    const agent = new SimulationAgent({
      steps: [{ output: ok, messages: ["thinking", "done"] }],
    });
    const messages: string[] = [];
    await agent.run("p", dir, { onMessage: (m) => messages.push(m) });
    expect(messages).toEqual(["thinking", "done"]);
  });
});
