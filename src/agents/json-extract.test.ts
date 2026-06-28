import { describe, expect, it } from "vitest";

import {
  extractBalancedObject,
  extractLastJsonObject,
  parseAgentJson,
  stripJsonFences,
} from "./json-extract.js";

describe("stripJsonFences", () => {
  it("removes ```json fences", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("removes bare ``` fences", () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("leaves unfenced text untouched", () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe("extractBalancedObject", () => {
  it("ignores braces inside strings", () => {
    const text = '{"a":"}{","b":1}';
    expect(extractBalancedObject(text, 0)).toBe(text);
  });
  it("handles escaped quotes", () => {
    const text = '{"a":"he said \\"hi\\"","b":2}';
    expect(extractBalancedObject(text, 0)).toBe(text);
  });
  it("returns null for unbalanced input", () => {
    expect(extractBalancedObject('{"a":1', 0)).toBeNull();
  });
});

describe("extractLastJsonObject", () => {
  it("prefers the rightmost object", () => {
    const text = '{"first":1} trailing {"second":2}';
    expect(extractLastJsonObject(text)).toBe('{"second":2}');
  });
  it("honours an acceptance predicate", () => {
    const text = '{"keep":true} ... {"other":1}';
    const result = extractLastJsonObject(
      text,
      (v) => typeof v === "object" && v !== null && "keep" in v,
    );
    expect(result).toBe('{"keep":true}');
  });
});

describe("parseAgentJson", () => {
  it("parses pure JSON", () => {
    expect(parseAgentJson('{"success":true}')).toEqual({ success: true });
  });
  it("recovers JSON wrapped in prose", () => {
    const text = 'Here is my answer:\n```json\n{"success":false}\n```\nThanks!';
    expect(parseAgentJson(text)).toEqual({ success: false });
  });
  it("returns null when no JSON is present", () => {
    expect(parseAgentJson("no json here")).toBeNull();
  });
});
