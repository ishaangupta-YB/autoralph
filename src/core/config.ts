import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Every selectable agent identifier; the single source of truth for choices. */
export const AGENT_NAMES = ["claude", "opencode"] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

/** Default non-standard port for the real-time Kanban board. */
export const DEFAULT_BOARD_PORT = 7654;
export const DEFAULT_BOARD_HOST = "127.0.0.1";

/** Cloudflare Workers AI Kimi models, newest first. */
export const KIMI_MODELS = {
  "kimi-k2.7-code": "@cf/moonshotai/kimi-k2.7-code",
  "kimi-k2.6": "@cf/moonshotai/kimi-k2.6",
  "kimi-k2.5": "@cf/moonshotai/kimi-k2.5",
} as const;

export const DEFAULT_OPENCODE_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const DEFAULT_OPENCODE_FALLBACK_MODELS = [
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.5",
];

export interface BoardConfig {
  enabled: boolean;
  port: number;
  host: string;
}

/** Defaults for the loop's failure handling and exponential backoff. */
export const DEFAULT_RETRY: RetryConfig = {
  maxConsecutiveFailures: 3,
  backoffBaseMs: 60_000,
  backoffFactor: 2,
  maxBackoffMs: 900_000,
};

export interface RetryConfig {
  /** Consecutive failures tolerated before the run aborts. */
  maxConsecutiveFailures: number;
  /** Base backoff delay in ms for retryable provider errors. */
  backoffBaseMs: number;
  /** Exponential growth factor applied per consecutive retry. */
  backoffFactor: number;
  /** Hard cap on any single backoff delay in ms. */
  maxBackoffMs: number;
}

export interface CloudflareConfig {
  accountId?: string;
  apiToken?: string;
}

export interface Config {
  agent: AgentName;
  /** Primary model id for the opencode/Cloudflare provider. */
  model: string;
  /** Ordered fallback models tried when the primary model errors. */
  fallbackModels: string[];
  maxIterations?: number;
  maxTokens?: number;
  /** Wall-clock budget in ms after which the run stops. */
  maxDurationMs?: number;
  board: BoardConfig;
  retry: RetryConfig;
  cloudflare: CloudflareConfig;
  /** Absolute path or bare binary name to use instead of the default. */
  agentPathOverride?: string;
  /** Extra CLI args forwarded to the underlying agent binary. */
  agentArgsOverride?: string[];
}

export interface PartialConfigFile {
  agent?: AgentName;
  model?: string;
  fallbackModels?: string[];
  maxIterations?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  board?: Partial<BoardConfig>;
  retry?: Partial<RetryConfig>;
  cloudflare?: CloudflareConfig;
  agentPathOverride?: string;
  agentArgsOverride?: string[];
}

export function getConfigDir(): string {
  return join(homedir(), ".autoralph");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function defaultConfig(): Config {
  return {
    agent: "claude",
    model: DEFAULT_OPENCODE_MODEL,
    fallbackModels: [...DEFAULT_OPENCODE_FALLBACK_MODELS],
    board: {
      enabled: true,
      port: DEFAULT_BOARD_PORT,
      host: DEFAULT_BOARD_HOST,
    },
    retry: { ...DEFAULT_RETRY },
    cloudflare: {},
  };
}

function readConfigFile(configPath: string): PartialConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve effective config from (in increasing precedence): defaults, the
 * config file, environment variables, then CLI overrides. Cloudflare
 * credentials are sourced from the environment by preference so secrets never
 * have to live in the config file.
 */
export function loadConfig(
  overrides: PartialConfigFile = {},
  configPath = getConfigPath(),
): Config {
  const base = defaultConfig();
  const file = readConfigFile(configPath);

  const merged: Config = {
    agent: overrides.agent ?? file.agent ?? base.agent,
    model: overrides.model ?? file.model ?? base.model,
    fallbackModels:
      overrides.fallbackModels ?? file.fallbackModels ?? base.fallbackModels,
    maxIterations: overrides.maxIterations ?? file.maxIterations,
    maxTokens: overrides.maxTokens ?? file.maxTokens,
    maxDurationMs: overrides.maxDurationMs ?? file.maxDurationMs,
    board: {
      enabled:
        overrides.board?.enabled ?? file.board?.enabled ?? base.board.enabled,
      port: overrides.board?.port ?? file.board?.port ?? base.board.port,
      host: overrides.board?.host ?? file.board?.host ?? base.board.host,
    },
    retry: {
      maxConsecutiveFailures:
        overrides.retry?.maxConsecutiveFailures ??
        file.retry?.maxConsecutiveFailures ??
        base.retry.maxConsecutiveFailures,
      backoffBaseMs:
        overrides.retry?.backoffBaseMs ??
        file.retry?.backoffBaseMs ??
        base.retry.backoffBaseMs,
      backoffFactor:
        overrides.retry?.backoffFactor ??
        file.retry?.backoffFactor ??
        base.retry.backoffFactor,
      maxBackoffMs:
        overrides.retry?.maxBackoffMs ??
        file.retry?.maxBackoffMs ??
        base.retry.maxBackoffMs,
    },
    cloudflare: {
      accountId:
        overrides.cloudflare?.accountId ??
        process.env.CLOUDFLARE_ACCOUNT_ID ??
        file.cloudflare?.accountId,
      apiToken:
        overrides.cloudflare?.apiToken ??
        process.env.CLOUDFLARE_API_TOKEN ??
        process.env.CLOUDFLARE_API_KEY ??
        file.cloudflare?.apiToken,
    },
    agentPathOverride: overrides.agentPathOverride ?? file.agentPathOverride,
    agentArgsOverride: overrides.agentArgsOverride ?? file.agentArgsOverride,
  };

  return merged;
}

/** Write a starter config file the first time autoralph runs. */
export function bootstrapConfig(configPath = getConfigPath()): void {
  if (existsSync(configPath)) return;
  mkdirSync(dirname(configPath), { recursive: true });
  const starter: PartialConfigFile = {
    agent: "claude",
    model: DEFAULT_OPENCODE_MODEL,
    fallbackModels: [...DEFAULT_OPENCODE_FALLBACK_MODELS],
    board: {
      enabled: true,
      port: DEFAULT_BOARD_PORT,
      host: DEFAULT_BOARD_HOST,
    },
  };
  writeFileSync(configPath, `${JSON.stringify(starter, null, 2)}\n`, "utf-8");
}
