import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapConfig, defaultConfig, loadConfig } from "./config.js";

let dir: string;
let configPath: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  configPath = join(dir, "config.json");
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_KEY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("loadConfig", () => {
  it("returns defaults when no file or overrides exist", () => {
    const config = loadConfig({}, configPath);
    expect(config.agent).toBe(defaultConfig().agent);
    expect(config.board.port).toBe(7654);
    expect(config.fallbackModels.length).toBeGreaterThan(0);
  });

  it("applies precedence: overrides > file > defaults", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ agent: "opencode", model: "@cf/file-model" }),
    );
    const config = loadConfig({ model: "@cf/override-model" }, configPath);
    expect(config.agent).toBe("opencode");
    expect(config.model).toBe("@cf/override-model");
  });

  it("sources Cloudflare credentials from the environment", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc-from-env";
    process.env.CLOUDFLARE_API_TOKEN = "tok-from-env";
    const config = loadConfig({}, configPath);
    expect(config.cloudflare.accountId).toBe("acc-from-env");
    expect(config.cloudflare.apiToken).toBe("tok-from-env");
  });

  it("falls back to CLOUDFLARE_API_KEY for the token", () => {
    process.env.CLOUDFLARE_API_KEY = "key-from-env";
    const config = loadConfig({}, configPath);
    expect(config.cloudflare.apiToken).toBe("key-from-env");
  });

  it("ignores malformed config files", () => {
    writeFileSync(configPath, "{ not valid json");
    const config = loadConfig({}, configPath);
    expect(config.agent).toBe(defaultConfig().agent);
  });
});

describe("bootstrapConfig", () => {
  it("writes a starter config only when none exists", () => {
    bootstrapConfig(configPath);
    const first = readFileSync(configPath, "utf-8");
    expect(JSON.parse(first).board.port).toBe(7654);

    writeFileSync(configPath, JSON.stringify({ agent: "opencode" }));
    bootstrapConfig(configPath);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).agent).toBe(
      "opencode",
    );
  });
});
