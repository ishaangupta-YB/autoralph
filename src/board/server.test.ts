import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BoardServer } from "./server.js";
import { BoardHub } from "./hub.js";
import { Orchestrator } from "../core/orchestrator.js";
import { SimulationAgent } from "../agents/simulation.js";
import { getHeadCommit } from "../core/git.js";
import { setupRun } from "../core/run.js";
import { makeTempRepo } from "../test-utils.js";

let repo: { dir: string; cleanup: () => void };
let server: BoardServer;

beforeEach(() => {
  repo = makeTempRepo();
});
afterEach(async () => {
  await server?.stop();
  repo.cleanup();
});

function buildHub(): BoardHub {
  const hub = new BoardHub();
  const runInfo = setupRun({
    runId: "srv-run",
    objective: "serve",
    baseCommit: getHeadCommit(repo.dir),
    cwd: repo.dir,
  });
  const orch = new Orchestrator({
    agent: new SimulationAgent({
      steps: [
        {
          output: {
            success: true,
            summary: "served",
            key_changes_made: [],
            key_learnings: [],
          },
        },
      ],
    }),
    runInfo,
    objective: "serve",
    cwd: repo.dir,
  });
  hub.register(orch);
  return hub;
}

describe("BoardServer", () => {
  it("serves the board HTML and a JSON snapshot on an ephemeral port", async () => {
    server = new BoardServer({ hub: buildHub(), port: 0 });
    const url = await server.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const html = await fetch(`${url}/`).then((r) => r.text());
    expect(html).toContain("autoralph");
    expect(html).toContain("EventSource");

    const state = await fetch(`${url}/api/state`).then((r) => r.json());
    expect(state.runs[0].runId).toBe("srv-run");

    const health = await fetch(`${url}/healthz`).then((r) => r.text());
    expect(health).toBe("ok");
  });

  it("streams an initial snapshot over SSE", async () => {
    server = new BoardServer({ hub: buildHub(), port: 0 });
    const url = await server.start();

    const response = await fetch(`${url}/api/events`, {
      headers: { accept: "text/event-stream" },
    });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("data:");
    expect(chunk).toContain("srv-run");
    await reader.cancel();
  });

  it("returns 404 for unknown paths", async () => {
    server = new BoardServer({ hub: buildHub(), port: 0 });
    const url = await server.start();
    const res = await fetch(`${url}/nope`);
    expect(res.status).toBe(404);
  });

  it("lists run history and serves a single run by id", async () => {
    server = new BoardServer({ hub: buildHub(), port: 0 });
    const url = await server.start();

    const history = await fetch(`${url}/api/history`).then((r) => r.json());
    expect(history.runs.map((r: { runId: string }) => r.runId)).toContain(
      "srv-run",
    );

    const detail = await fetch(`${url}/api/history?runId=srv-run`).then((r) =>
      r.json(),
    );
    expect(detail.run.runId).toBe("srv-run");
    expect(Array.isArray(detail.logs)).toBe(true);
  });

  it("returns 404 for an unknown history run", async () => {
    server = new BoardServer({ hub: buildHub(), port: 0 });
    const url = await server.start();
    const res = await fetch(`${url}/api/history?runId=does-not-exist`);
    expect(res.status).toBe(404);
  });
});
