import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as stateGET } from "@/app/api/state/route";
import { GET as historyGET } from "@/app/api/history/route";

const originalDemo = process.env.AUTORALPH_DASHBOARD_DEMO;

beforeEach(() => {
  process.env.AUTORALPH_DASHBOARD_DEMO = "1";
});
afterEach(() => {
  if (originalDemo === undefined) delete process.env.AUTORALPH_DASHBOARD_DEMO;
  else process.env.AUTORALPH_DASHBOARD_DEMO = originalDemo;
});

describe("state route (demo mode)", () => {
  it("returns the simulated terminal snapshot", async () => {
    const data = await stateGET().then((r) => r.json());
    expect(data.demo).toBe(true);
    expect(data.connected).toBe(true);
    expect(data.snapshot.runs.length).toBeGreaterThan(0);
  });
});

describe("history route (demo mode)", () => {
  it("lists demo runs without a runId", async () => {
    const req = new Request("http://localhost/api/history");
    const data = await historyGET(req).then((r) => r.json());
    expect(data.demo).toBe(true);
    expect(data.runs.length).toBeGreaterThanOrEqual(4);
  });

  it("returns a single run's full detail with a runId", async () => {
    const req = new Request(
      "http://localhost/api/history?runId=demo-archive-auth",
    );
    const data = await historyGET(req).then((r) => r.json());
    expect(data.run?.run.runId).toBe("demo-archive-auth");
    expect(data.run?.logs.length).toBeGreaterThan(0);
  });

  it("returns a null run for an unknown id", async () => {
    const req = new Request("http://localhost/api/history?runId=ghost");
    const data = await historyGET(req).then((r) => r.json());
    expect(data.run).toBeNull();
  });
});
