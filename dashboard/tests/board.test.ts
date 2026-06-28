import { afterEach, describe, expect, it } from "vitest";

import { boardBaseUrl, isDemoMode, totalTokens } from "@/lib/board";

describe("boardBaseUrl", () => {
  const original = process.env.AUTORALPH_BOARD_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.AUTORALPH_BOARD_URL;
    else process.env.AUTORALPH_BOARD_URL = original;
  });

  it("defaults to the local CLI board port", () => {
    delete process.env.AUTORALPH_BOARD_URL;
    expect(boardBaseUrl()).toBe("http://127.0.0.1:7654");
  });

  it("honours the env override and strips a trailing slash", () => {
    process.env.AUTORALPH_BOARD_URL = "http://board.internal:9000/";
    expect(boardBaseUrl()).toBe("http://board.internal:9000");
  });
});

describe("isDemoMode", () => {
  const original = process.env.AUTORALPH_DASHBOARD_DEMO;
  afterEach(() => {
    if (original === undefined) delete process.env.AUTORALPH_DASHBOARD_DEMO;
    else process.env.AUTORALPH_DASHBOARD_DEMO = original;
  });

  it("is true only when explicitly enabled", () => {
    process.env.AUTORALPH_DASHBOARD_DEMO = "1";
    expect(isDemoMode()).toBe(true);
  });

  it("is false when unset or disabled", () => {
    delete process.env.AUTORALPH_DASHBOARD_DEMO;
    expect(isDemoMode()).toBe(false);
    process.env.AUTORALPH_DASHBOARD_DEMO = "0";
    expect(isDemoMode()).toBe(false);
  });
});

describe("totalTokens", () => {
  it("sums input and output, ignoring cache buckets", () => {
    expect(
      totalTokens({
        inputTokens: 1200,
        outputTokens: 800,
        cacheReadTokens: 50,
        cacheCreationTokens: 25,
      }),
    ).toBe(2000);
  });

  it("treats missing values as zero", () => {
    expect(
      totalTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });
});
