import { EMPTY_USAGE, PermanentAgentError, type TokenUsage } from "./types.js";

/**
 * Minimal client for Cloudflare Workers AI via its OpenAI-compatible REST
 * endpoint. autoralph uses Workers AI as the model provider behind OpenCode
 * (Kimi K2.x models). The endpoint mirrors the OpenAI chat-completions wire
 * format, so the same client works for any `@cf/...` text-generation model.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** OpenAI-style response_format, e.g. a json_schema constraint. */
  responseFormat?: unknown;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  usage: TokenUsage;
}

interface OpenAICompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface CloudflareClientDeps {
  accountId: string;
  apiToken: string;
  model: string;
  fetch?: typeof fetch;
  /** Override the base URL (without trailing slash) for testing. */
  baseUrl?: string;
}

export function cloudflareBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class CloudflareWorkersAIClient {
  readonly model: string;
  private accountId: string;
  private apiToken: string;
  private fetchFn: typeof fetch;
  private baseUrl: string;

  constructor(deps: CloudflareClientDeps) {
    if (!deps.accountId) {
      throw new PermanentAgentError(
        "Cloudflare account id is required (set CLOUDFLARE_ACCOUNT_ID)",
      );
    }
    if (!deps.apiToken) {
      throw new PermanentAgentError(
        "Cloudflare API token is required (set CLOUDFLARE_API_TOKEN)",
      );
    }
    this.accountId = deps.accountId;
    this.apiToken = deps.apiToken;
    this.model = deps.model;
    this.fetchFn = deps.fetch ?? fetch;
    this.baseUrl = (deps.baseUrl ?? cloudflareBaseUrl(deps.accountId)).replace(
      /\/$/,
      "",
    );
  }

  async chatCompletion(
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: options.messages,
    };
    if (options.responseFormat !== undefined) {
      body.response_format = options.responseFormat;
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }

    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const detail = await safeText(response);
      const message = `Cloudflare Workers AI request failed (${response.status}): ${detail}`;
      // 401/403 mean the credentials will never work; do not retry those.
      if (response.status === 401 || response.status === 403) {
        throw new PermanentAgentError(
          "Cloudflare Workers AI authentication failed - check CLOUDFLARE_API_TOKEN",
          message,
        );
      }
      const error = new Error(message);
      if (RETRYABLE_STATUS.has(response.status)) {
        (error as Error & { retryable?: boolean }).retryable = true;
      }
      throw error;
    }

    const json = (await response.json()) as OpenAICompletionResponse;
    const content = json.choices?.[0]?.message?.content ?? "";
    const usage: TokenUsage = {
      ...EMPTY_USAGE,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
    return { content, usage };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
