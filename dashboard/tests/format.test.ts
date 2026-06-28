import { describe, expect, it } from "vitest";

import { COLUMNS, fmtCount, fmtTime, runColor } from "@/lib/format";
import type { IterationStatus } from "@/lib/board";

describe("fmtCount", () => {
  it("passes small numbers through verbatim", () => {
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(7)).toBe("7");
    expect(fmtCount(999)).toBe("999");
  });

  it("abbreviates thousands with one decimal", () => {
    expect(fmtCount(1000)).toBe("1.0k");
    expect(fmtCount(2000)).toBe("2.0k");
    expect(fmtCount(8000)).toBe("8.0k");
    expect(fmtCount(12500)).toBe("12.5k");
  });

  it("is resilient to non-finite input", () => {
    expect(fmtCount(Number.NaN)).toBe("0");
    expect(fmtCount(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("fmtTime", () => {
  it("zero-pads hours, minutes, and seconds", () => {
    const ts = new Date(2026, 0, 1, 4, 5, 9).getTime();
    expect(fmtTime(ts)).toBe("04:05:09");
  });
});

describe("runColor", () => {
  it("is deterministic and wraps around the palette", () => {
    expect(runColor(0)).toBe(runColor(6));
    expect(runColor(1)).toBe(runColor(7));
    expect(typeof runColor(3)).toBe("string");
  });
});

describe("COLUMNS", () => {
  it("maps every iteration status to exactly one column", () => {
    const all: IterationStatus[] = [
      "queued",
      "running",
      "committed",
      "discarded",
      "repair",
      "aborted",
    ];
    for (const status of all) {
      const matches = COLUMNS.filter((c) => c.statuses.includes(status));
      expect(matches).toHaveLength(1);
    }
  });

  it("renders four columns", () => {
    expect(COLUMNS.map((c) => c.key)).toEqual([
      "active",
      "committed",
      "discarded",
      "blocked",
    ]);
  });
});
