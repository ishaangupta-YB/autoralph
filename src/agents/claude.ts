import {
  spawn,
  type SpawnOptions,
  type ChildProcess,
} from "node:child_process";

import { appendDebugLog, serializeError } from "../core/logger.js";
import { parseAgentJson } from "./json-extract.js";
import {
  isAbortError,
  parseJsonLines,
  terminateProcess,
  wireAbortSignal,
} from "./process.js";
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

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ClaudeAgentOptions {
  schema: AgentOutputSchema;
  binPath?: string;
  extraArgs?: string[];
  spawnFn?: SpawnFn;
}

/** Claude Code stream-json event shapes (only the fields we read). */
interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }>;
    usage?: ClaudeUsage;
  };
  usage?: ClaudeUsage;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const PERMANENT_MARKERS = [
  "credit balance is too low",
  "insufficient credit",
  "invalid api key",
  "authentication_error",
];

function toUsage(usage: ClaudeUsage | undefined): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE };
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Runs Claude Code (`claude`) once per iteration in headless stream-json mode.
 * The structured output schema is appended to the prompt and the final
 * `result` text is parsed back into an AgentOutput. A lingering process tree is
 * terminated after the result arrives so a stuck Claude session cannot wedge
 * the loop.
 */
export class ClaudeAgent implements Agent {
  readonly name = "claude";
  private schema: AgentOutputSchema;
  private binPath: string;
  private extraArgs: string[];
  private spawnFn: SpawnFn;

  constructor(options: ClaudeAgentOptions) {
    this.schema = options.schema;
    this.binPath = options.binPath ?? "claude";
    this.extraArgs = options.extraArgs ?? [];
    this.spawnFn = options.spawnFn ?? (spawn as SpawnFn);
  }

  private buildPrompt(prompt: string): string {
    return `${prompt}\n\nReturn ONLY a single JSON object matching this schema, with no surrounding prose or markdown:\n${JSON.stringify(
      this.schema,
    )}`;
  }

  run(
    prompt: string,
    cwd: string,
    options: AgentRunOptions = {},
  ): Promise<AgentResult> {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.extraArgs,
    ];

    return new Promise<AgentResult>((resolve, reject) => {
      const child = this.spawnFn(this.binPath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        detached: process.platform !== "win32",
      });

      let usage: TokenUsage = { ...EMPTY_USAGE };
      let resultText: string | null = null;
      let permanent: PermanentAgentError | null = null;
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

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      if (child.stdout) {
        parseJsonLines<ClaudeStreamEvent>(child.stdout, (event) => {
          if (event.message?.usage) usage = toUsage(event.message.usage);
          if (event.usage) usage = toUsage(event.usage);
          options.onUsage?.(usage);

          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                options.onMessage?.(block.text);
              }
            }
          }

          if (event.type === "result") {
            if (typeof event.result === "string") resultText = event.result;
            const lowered = (event.result ?? "").toLowerCase();
            if (event.subtype === "error_during_execution" || event.is_error) {
              if (PERMANENT_MARKERS.some((m) => lowered.includes(m))) {
                permanent = new PermanentAgentError(
                  "Claude reported a non-retryable error",
                  event.result,
                );
              }
            }
          }
        });
      }

      child.stdin?.end(this.buildPrompt(prompt));

      child.on("close", (code) => {
        if (settled) return;
        settled = true;

        // Defensively reap any lingering process tree.
        terminateProcess(child);

        if (permanent) {
          appendDebugLog("agent:claude:permanent", {
            detail: permanent.detail,
          });
          reject(permanent);
          return;
        }

        if (resultText === null) {
          const error = new Error(
            `claude exited (code ${code}) without a result. stderr: ${stderr.slice(
              0,
              500,
            )}`,
          );
          appendDebugLog("agent:claude:no-result", {
            code,
            stderr: stderr.slice(0, 500),
          });
          reject(error);
          return;
        }

        try {
          const parsed = parseAgentJson(resultText);
          if (parsed === null) {
            throw new Error("could not extract JSON from Claude result");
          }
          const output = validateAgentOutput(parsed, this.schema);
          resolve({ output, usage });
        } catch (error) {
          appendDebugLog("agent:claude:parse-failed", {
            error: serializeError(error),
            result: resultText.slice(0, 500),
          });
          reject(error);
        }
      });
    }).catch((error) => {
      if (isAbortError(error)) throw error;
      throw error;
    });
  }
}
