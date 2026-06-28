import { describe, expect, it } from "vitest";

import { makeRunId, slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(slugify("Build a Parser!")).toBe("build-a-parser");
  });
  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });
  it("truncates to the max length without trailing hyphen", () => {
    const slug = slugify("a".repeat(100), 10);
    expect(slug).toHaveLength(10);
  });
  it("falls back to 'run' for empty input", () => {
    expect(slugify("!!!")).toBe("run");
  });
});

describe("makeRunId", () => {
  it("combines a slug with a timestamp and random suffix", () => {
    const id = makeRunId("My Objective");
    expect(id).toMatch(/^my-objective-\d{8}-\d{6}-[a-z0-9]{1,4}$/);
  });
  it("produces unique ids for rapid successive calls", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => makeRunId("same objective")),
    );
    expect(ids.size).toBe(50);
  });
});
