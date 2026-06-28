import { describe, expect, it } from "vitest";

import {
  addUsage,
  buildAgentOutputSchema,
  EMPTY_USAGE,
  totalTokens,
  validateAgentOutput,
} from "./types.js";

describe("buildAgentOutputSchema", () => {
  it("omits should_fully_stop by default", () => {
    const schema = buildAgentOutputSchema();
    expect(schema.properties.should_fully_stop).toBeUndefined();
    expect(schema.required).not.toContain("should_fully_stop");
  });
  it("includes should_fully_stop when requested", () => {
    const schema = buildAgentOutputSchema({ includeStopField: true });
    expect(schema.properties.should_fully_stop).toBeDefined();
  });
});

describe("validateAgentOutput", () => {
  const schema = buildAgentOutputSchema({ includeStopField: true });

  it("accepts a well-formed object and defaults arrays", () => {
    const output = validateAgentOutput(
      { success: true, summary: "did a thing" },
      schema,
    );
    expect(output).toEqual({
      success: true,
      summary: "did a thing",
      key_changes_made: [],
      key_learnings: [],
      should_fully_stop: false,
    });
  });

  it("coerces should_fully_stop to a boolean", () => {
    const output = validateAgentOutput(
      { success: true, summary: "s", should_fully_stop: true },
      schema,
    );
    expect(output.should_fully_stop).toBe(true);
  });

  it("drops should_fully_stop when the schema omits it", () => {
    const noStop = buildAgentOutputSchema();
    const output = validateAgentOutput(
      { success: true, summary: "s", should_fully_stop: true },
      noStop,
    );
    expect(output.should_fully_stop).toBeUndefined();
  });

  it("throws when success is missing", () => {
    expect(() => validateAgentOutput({ summary: "s" }, schema)).toThrow();
  });

  it("throws when an array contains non-strings", () => {
    expect(() =>
      validateAgentOutput(
        { success: true, summary: "s", key_changes_made: [1] },
        schema,
      ),
    ).toThrow();
  });
});

describe("usage helpers", () => {
  it("adds usage and propagates the estimated flag", () => {
    const a = { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5 };
    const b = { ...EMPTY_USAGE, inputTokens: 1, estimated: true };
    const sum = addUsage(a, b);
    expect(sum.inputTokens).toBe(11);
    expect(sum.outputTokens).toBe(5);
    expect(sum.estimated).toBe(true);
    expect(totalTokens(sum)).toBe(16);
  });
});
