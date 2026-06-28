import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CloudflareConfig } from "../core/config.js";
import { appendDebugLog, serializeError } from "../core/logger.js";
import { parseAgentJson } from "./json-extract.js";
import { isAbortError, terminateProcess, wireAbortSignal } from "./process.js";
import type { SpawnFn } from "./claude.js";
import {
  EMPTY_USAGE,
  PermanentAgentError,
  validateAgentOutput,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";

export const OPENCODE_PROVIDER_ID = "cloudflare-workers-ai";

const RETRYABLE_PROVIDER_MARKERS = [
  "server_is_overloaded",
  "service_unavailable",
  "overloaded_error",
  "rate limit",
  "429",
  "502",
  "503",
  "504",
  "timeout",
];

const PERMANENT_PROVIDER_MARKERS = [
  "authentication",
  "invalid api key",
  "unauthorized",
  "403",
  "401",
];

export interface OpenCodeProviderConfig {
  $schema: string;
  provider: Record<string, unknown>;
}

/**
 * Build an OpenCode provider config that routes a Kimi model through Cloudflare
 * Workers AI's OpenAI-compatible endpoint using the `@ai-sdk/openai-compatible`
 * adapter. Every model in `models` (primary + fallbacks) is registered so the
 * fallback loop can switch between them without rewriting the file.
 */
export function buildOpenCodeConfig(params: {
  accountId: string;
  apiToken: string;
  models: string[];
}): OpenCodeProviderConfig {
  const models: Record<string, { name: string }> = {};
  for (const model of params.models) {
    models[model] = { name: model };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Cloudflare Workers AI",
        options: {
          baseURL: `https://api.cloudflare.com/client/v4/accounts/${params.accountId}/ai/v1`,
          apiKey: params.apiToken,
        },
        models,
      },
    },
  };
}

export function classifyProviderError(
  text: string,
): "retryable" | "permanent" | "unknown" {
  const lowered = text.toLowerCase();
  if (PERMANENT_PROVIDER_MARKERS.some((m) => lowered.includes(m))) {
    return "permanent";
  }
  if (RETRYABLE_PROVIDER_MARKERS.some((m) => lowered.includes(m))) {
    return "retryable";
  }
  return "unknown";
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface OpenCodeAgentOptions {
  schema: AgentOutputSchema;
  models: string[];
  cloudflare: CloudflareConfig;
  configPath: string;
  binPath?: string;
  extraArgs?: string[];
  spawnFn?: SpawnFn;
}

interface SpawnRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs OpenCode (`opencode run`) once per iteration against a Kimi model served
 * by Cloudflare Workers AI. On a retryable provider error it advances to the
 * next configured fallback model; a permanent error (bad credentials) aborts.
 * Token usage is estimated from prompt/response length and flagged as such.
 */
export class OpenCodeAgent implements Agent {
  readonly name = "opencode";
  private schema: AgentOutputSchema;
  private models: string[];
  private cloudflare: CloudflareConfig;
  private configPath: string;
  private binPath: string;
  private extraArgs: string[];
  private spawnFn: SpawnFn;
  private configWritten = false;

  constructor(options: OpenCodeAgentOptions) {
    if (options.models.length === 0) {
      throw new Error("OpenCodeAgent requires at least one model");
    }
    this.schema = options.schema;
    this.models = options.models;
    this.cloudflare = options.cloudflare;
    this.configPath = options.configPath;
    this.binPath = options.binPath ?? "opencode";
    this.extraArgs = options.extraArgs ?? [];
    this.spawnFn = options.spawnFn ?? (spawn as SpawnFn);
  }

  private ensureConfig(): void {
    if (this.configWritten) return;
    if (!this.cloudflare.accountId) {
      throw new PermanentAgentError(
        "Cloudflare account id is required for OpenCode (set CLOUDFLARE_ACCOUNT_ID)",
      );
    }
    if (!this.cloudflare.apiToken) {
      throw new PermanentAgentError(
        "Cloudflare API token is required for OpenCode (set CLOUDFLARE_API_TOKEN)",
      );
    }
    const config = buildOpenCodeConfig({
      accountId: this.cloudflare.accountId,
      apiToken: this.cloudflare.apiToken,
      models: this.models,
    });
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    this.configWritten = true;
  }

  private buildPrompt(prompt: string): string {
    return `${prompt}\n\nReturn ONLY a single JSON object matching this schema, with no surrounding prose or markdown:\n${JSON.stringify(
      this.schema,
    )}`;
  }

  private spawnRun(
    model: string,
    prompt: string,
    cwd: string,
    options: AgentRunOptions,
  ): Promise<SpawnRunResult> {
    const args = [
      "run",
      "--model",
      `${OPENCODE_PROVIDER_ID}/${model}`,
      ...this.extraArgs,
    ];

    return new Promise<SpawnRunResult>((resolve, reject) => {
      const child = this.spawnFn(this.binPath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_CONFIG: this.configPath },
        detached: process.platform !== "win32",
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const aborted = wireAbortSignal(options.signal, child, (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      if (aborted) return;

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`Failed to spawn '${this.binPath}': ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        options.onMessage?.(text);
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdin?.end(this.buildPrompt(prompt));

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        terminateProcess(child);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async run(
    prompt: string,
    cwd: string,
    options: AgentRunOptions = {},
  ): Promise<AgentResult> {
    this.ensureConfig();
    const promptTokens = estimateTokens(this.buildPrompt(prompt));

    let lastError: Error | null = null;

    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i]!;
      if (options.signal?.aborted) {
        throw new Error("Agent was aborted");
      }

      let result: SpawnRunResult;
      try {
        result = await this.spawnRun(model, prompt, cwd, options);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw error;
      }

      const combined = `${result.stdout}\n${result.stderr}`;

      if (result.code !== 0) {
        const classification = classifyProviderError(combined);
        appendDebugLog("agent:opencode:run-failed", {
          model,
          code: result.code,
          classification,
          stderr: result.stderr.slice(0, 500),
        });
        if (classification === "permanent") {
          throw new PermanentAgentError(
            "OpenCode provider returned a non-retryable error",
            result.stderr.slice(0, 500),
          );
        }
        lastError = new Error(
          `opencode (model ${model}) exited ${result.code}: ${result.stderr.slice(
            0,
            300,
          )}`,
        );
        // Retryable or unknown: fall through to the next fallback model.
        continue;
      }

      const parsed = parseAgentJson(result.stdout);
      if (parsed === null) {
        lastError = new Error(
          `opencode (model ${model}) produced no parseable JSON output`,
        );
        appendDebugLog("agent:opencode:parse-failed", {
          model,
          stdout: result.stdout.slice(0, 500),
        });
        continue;
      }

      try {
        const output = validateAgentOutput(parsed, this.schema);
        const usage: TokenUsage = {
          ...EMPTY_USAGE,
          inputTokens: promptTokens,
          outputTokens: estimateTokens(result.stdout),
          estimated: true,
        };
        options.onUsage?.(usage);
        if (i > 0) {
          appendDebugLog("agent:opencode:fallback-succeeded", { model });
        }
        return { output, usage };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        appendDebugLog("agent:opencode:validate-failed", {
          model,
          error: serializeError(error),
        });
        continue;
      }
    }

    const error = new Error(
      `OpenCode exhausted all ${this.models.length} model(s). Last error: ${
        lastError?.message ?? "unknown"
      }`,
    );
    (error as Error & { retryable?: boolean }).retryable = true;
    throw error;
  }
}
