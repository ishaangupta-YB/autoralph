import { describe, expect, it } from "vitest";

import { totalTokens } from "@/lib/board";
import { demoSnapshot, demoTimeline } from "@/lib/demo";

const NOW = 1_700_000_000_000;

describe("demoTimeline", () => {
  it("starts empty and ends with both runs completed", () => {
    const frames = demoTimeline(NOW);
    expect(frames.length).toBeGreaterThan(1);

    const first = frames[0]!;
    expect(first.runs).toHaveLength(2);
    expect(first.runs.every((r) => r.iterations.length === 0)).toBe(true);

    const last = frames[frames.length - 1]!;
    expect(last.runs.every((r) => r.status === "completed")).toBe(true);
    expect(last.runs.every((r) => r.stopReason === "max-iterations")).toBe(true);
  });

  it("never lets currentIteration exceed maxIterations", () => {
    for (const frame of demoTimeline(NOW)) {
      for (const run of frame.runs) {
        expect(run.currentIteration).toBeLessThanOrEqual(run.maxIterations ?? 0);
      }
    }
  });

  it("produces monotonically non-decreasing log timestamps", () => {
    const { logs } = demoSnapshot(NOW);
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i]!.ts).toBeGreaterThanOrEqual(logs[i - 1]!.ts);
    }
  });

  it("exercises a provider backoff and a fallback in the logs", () => {
    const { logs } = demoSnapshot(NOW);
    expect(logs.some((l) => l.level === "warn" && /backing off/.test(l.message))).toBe(
      true,
    );
    expect(logs.some((l) => /Fell back to/.test(l.message))).toBe(true);
  });
});

describe("demoSnapshot", () => {
  it("accounts tokens and commit/fail counts consistently", () => {
    const snap = demoSnapshot(NOW);
    for (const run of snap.runs) {
      const committed = run.iterations.filter((i) => i.status === "committed");
      const discarded = run.iterations.filter((i) => i.status === "discarded");
      expect(run.commitCount).toBe(committed.length);
      expect(run.failCount).toBe(discarded.length);

      const summed = run.iterations.reduce((acc, i) => acc + totalTokens(i.usage), 0);
      expect(totalTokens(run.usage)).toBe(summed);
    }
  });

  it("places at least one discarded iteration on the board", () => {
    const snap = demoSnapshot(NOW);
    const discarded = snap.runs.flatMap((r) =>
      r.iterations.filter((i) => i.status === "discarded"),
    );
    expect(discarded.length).toBeGreaterThan(0);
    expect(discarded.every((i) => typeof i.error === "string")).toBe(true);
  });
});
