import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOpenCodeConfig,
  classifyProviderError,
  estimateTokens,
  OpenCodeAgent,
  OPENCODE_PROVIDER_ID,
} from "./opencode.js";
import { buildAgentOutputSchema, PermanentAgentError } from "./types.js";
import { finishChild } from "../test-utils.js";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin = { end: vi.fn() };
  pid = 4242;
  kill = vi.fn();
}

function fakeSpawn(
  script: (child: FakeChild, args: readonly string[]) => void,
) {
  const calls: string[][] = [];
  const spawnFn = ((_cmd: string, args: readonly string[]) => {
    calls.push([...args]);
    const child = new FakeChild();
    queueMicrotask(() => script(child, args));
    return child as never;
  }) as never;
  return { spawnFn, calls };
}

const schema = buildAgentOutputSchema();
const cloudflare = { accountId: "acc", apiToken: "tok" };

describe("buildOpenCodeConfig", () => {
  it("registers every model under the Cloudflare provider", () => {
    const config = buildOpenCodeConfig({
      accountId: "acc",
      apiToken: "tok",
      models: ["@cf/a", "@cf/b"],
    });
    const provider = config.provider[OPENCODE_PROVIDER_ID] as Record<
      string,
      unknown
    >;
    expect((provider.options as { baseURL: string }).baseURL).toContain(
      "/accounts/acc/ai/v1",
    );
    expect(Object.keys(provider.models as object)).toEqual(["@cf/a", "@cf/b"]);
  });
});

describe("classifyProviderError", () => {
  it("detects retryable overload", () => {
    expect(classifyProviderError("server_is_overloaded")).toBe("retryable");
  });
  it("detects permanent auth errors", () => {
    expect(classifyProviderError("401 unauthorized")).toBe("permanent");
  });
  it("returns unknown otherwise", () => {
    expect(classifyProviderError("weird")).toBe("unknown");
  });
});

describe("estimateTokens", () => {
  it("approximates 4 chars per token", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });
});

describe("OpenCodeAgent", () => {
  let dir: string;
  afterEach(() => {
    dir = "";
  });

  function makeConfigPath(): string {
    dir = mkdtempSync(join(tmpdir(), "oc-"));
    return join(dir, "opencode.json");
  }

  it("writes the provider config and parses JSON output", async () => {
    const configPath = makeConfigPath();
    const { spawnFn, calls } = fakeSpawn((child) => {
      child.stdout.push('{"success":true,"summary":"done"}');
      finishChild(child, 0);
    });
    const agent = new OpenCodeAgent({
      schema,
      models: ["@cf/moonshotai/kimi-k2.7-code"],
      cloudflare,
      configPath,
      spawnFn,
    });

    const result = await agent.run("obj", dir);
    expect(result.output.success).toBe(true);
    expect(result.usage.estimated).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(calls[0]).toContain(
      `${OPENCODE_PROVIDER_ID}/@cf/moonshotai/kimi-k2.7-code`,
    );
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.provider[OPENCODE_PROVIDER_ID]).toBeDefined();
  });

  it("falls back to the next model on a retryable failure", async () => {
    const configPath = makeConfigPath();
    let call = 0;
    const { spawnFn, calls } = fakeSpawn((child) => {
      call++;
      if (call === 1) {
        child.stderr.push("server_is_overloaded");
        finishChild(child, 1);
      } else {
        child.stdout.push('{"success":true,"summary":"recovered"}');
        finishChild(child, 0);
      }
    });
    const agent = new OpenCodeAgent({
      schema,
      models: ["@cf/primary", "@cf/fallback"],
      cloudflare,
      configPath,
      spawnFn,
    });

    const result = await agent.run("obj", dir);
    expect(result.output.summary).toBe("recovered");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`${OPENCODE_PROVIDER_ID}/@cf/fallback`);
  });

  it("throws PermanentAgentError on auth failure without trying fallbacks", async () => {
    const configPath = makeConfigPath();
    const { spawnFn, calls } = fakeSpawn((child) => {
      child.stderr.push("401 unauthorized");
      finishChild(child, 1);
    });
    const agent = new OpenCodeAgent({
      schema,
      models: ["@cf/primary", "@cf/fallback"],
      cloudflare,
      configPath,
      spawnFn,
    });
    await expect(agent.run("obj", dir)).rejects.toBeInstanceOf(
      PermanentAgentError,
    );
    expect(calls).toHaveLength(1);
  });

  it("requires Cloudflare credentials", async () => {
    const configPath = makeConfigPath();
    const { spawnFn } = fakeSpawn(() => {});
    const agent = new OpenCodeAgent({
      schema,
      models: ["@cf/primary"],
      cloudflare: {},
      configPath,
      spawnFn,
    });
    await expect(agent.run("obj", dir)).rejects.toBeInstanceOf(
      PermanentAgentError,
    );
  });
});
