import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentName = "claude" | "opencode";

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
  board: BoardConfig;
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
  board?: Partial<BoardConfig>;
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
    board: {
      enabled:
        overrides.board?.enabled ?? file.board?.enabled ?? base.board.enabled,
      port: overrides.board?.port ?? file.board?.port ?? base.board.port,
      host: overrides.board?.host ?? file.board?.host ?? base.board.host,
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
