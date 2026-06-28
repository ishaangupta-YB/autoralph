import { describe, expect, it } from "vitest";

import { demoHistory, demoHistoryRun } from "@/lib/demo";

const NOW = 1_700_000_000_000;

describe("demoHistory", () => {
  it("lists the timeline runs plus archived runs, newest-first", () => {
    const history = demoHistory(NOW);
    expect(history.length).toBeGreaterThanOrEqual(4);

    for (let i = 1; i < history.length; i++) {
      expect(history[i - 1]!.startedAt).toBeGreaterThanOrEqual(
        history[i]!.startedAt,
      );
    }

    const ids = history.map((h) => h.runId);
    expect(ids).toContain("demo-archive-auth");
    expect(ids).toContain("demo-archive-perf");
  });

  it("marks completed runs as not live and exposes a stop reason", () => {
    const perf = demoHistory(NOW).find((h) => h.runId === "demo-archive-perf");
    expect(perf?.live).toBe(false);
    expect(perf?.status).toBe("aborted");
    expect(perf?.stopReason).toBe("consecutive-failures");
    expect(perf?.failCount).toBeGreaterThan(0);
  });
});

describe("demoHistoryRun", () => {
  it("returns full state and logs for a known run", () => {
    const detail = demoHistoryRun("demo-archive-auth", NOW);
    expect(detail?.run.runId).toBe("demo-archive-auth");
    expect(detail?.run.iterations.length).toBe(5);
    expect(detail?.logs.length).toBeGreaterThan(0);
    expect(detail?.logs.every((l) => l.runId === "demo-archive-auth")).toBe(
      true,
    );
  });

  it("returns undefined for an unknown run", () => {
    expect(demoHistoryRun("nope", NOW)).toBeUndefined();
  });
});
