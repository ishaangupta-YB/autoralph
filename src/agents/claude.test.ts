import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ClaudeAgent } from "./claude.js";
import { buildAgentOutputSchema, PermanentAgentError } from "./types.js";
import { finishChild } from "../test-utils.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin = { end: vi.fn() };
  pid = 1234;
  kill = vi.fn();
}

function fakeSpawn(script: (child: FakeChild) => void) {
  const child = new FakeChild();
  const spawnFn = (() => {
    queueMicrotask(() => script(child));
    return child as never;
  }) as never;
  return { spawnFn, child };
}

const schema = buildAgentOutputSchema();

function emitLine(child: FakeChild, event: unknown): void {
  child.stdout.push(`${JSON.stringify(event)}\n`);
}

describe("ClaudeAgent", () => {
  it("parses the final result and accumulates usage", async () => {
    const { spawnFn } = fakeSpawn((child) => {
      emitLine(child, {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "working on it" }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      });
      emitLine(child, {
        type: "result",
        result: '{"success":true,"summary":"done","key_changes_made":["x"]}',
      });
      finishChild(child, 0);
    });

    const messages: string[] = [];
    const agent = new ClaudeAgent({ schema, spawnFn });
    const result = await agent.run("do it", "/tmp", {
      onMessage: (m) => messages.push(m),
    });

    expect(result.output).toMatchObject({ success: true, summary: "done" });
    expect(result.output.key_changes_made).toEqual(["x"]);
    expect(result.usage.inputTokens).toBe(100);
    expect(messages).toContain("working on it");
  });

  it("recovers JSON wrapped in prose in the result", async () => {
    const { spawnFn } = fakeSpawn((child) => {
      emitLine(child, {
        type: "result",
        result: 'Sure!\n```json\n{"success":false,"summary":"nope"}\n```',
      });
      finishChild(child, 0);
    });
    const agent = new ClaudeAgent({ schema, spawnFn });
    const result = await agent.run("p", "/tmp");
    expect(result.output.success).toBe(false);
  });

  it("raises PermanentAgentError on low credit balance", async () => {
    const { spawnFn } = fakeSpawn((child) => {
      emitLine(child, {
        type: "result",
        is_error: true,
        result: "Your credit balance is too low to continue.",
      });
      finishChild(child, 1);
    });
    const agent = new ClaudeAgent({ schema, spawnFn });
    await expect(agent.run("p", "/tmp")).rejects.toBeInstanceOf(
      PermanentAgentError,
    );
  });

  it("rejects when no result is produced", async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stderr.push("boom");
      finishChild(child, 2);
    });
    const agent = new ClaudeAgent({ schema, spawnFn });
    await expect(agent.run("p", "/tmp")).rejects.toThrow(/without a result/);
  });
});
