import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  EMPTY_USAGE,
  PermanentAgentError,
  type Agent,
  type AgentResult,
  type AgentRunOptions,
  type AgentOutput,
  type TokenUsage,
} from "./types.js";

export interface SimulationStep {
  /** Output to return; not required when the step throws instead. */
  output?: AgentOutput;
  usage?: Partial<TokenUsage>;
  messages?: string[];
  /** Throw a (retryable) error instead of returning output. */
  throwRetryable?: string;
  /** Throw a PermanentAgentError instead of returning output. */
  throwPermanent?: string;
  /** Create or modify a file (relative to cwd) so commits have real content. */
  writeFile?: { path: string; content: string };
  /** Per-message delay in ms (default 0) to make the board visibly stream. */
  delayMs?: number;
}

export interface SimulationAgentOptions {
  name?: string;
  steps: SimulationStep[];
  /** Behaviour once steps run out: repeat the last step or report no-op. */
  onExhausted?: "repeat-last" | "noop";
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A scripted agent used for tests, demos, and the live Kanban walkthrough. It
 * deterministically replays a list of steps (success/failure/throw), can write
 * real files so commits are non-empty, and honours the abort signal so token
 * and shutdown handling can be exercised without any external binary.
 */
export class SimulationAgent implements Agent {
  readonly name: string;
  private steps: SimulationStep[];
  private onExhausted: "repeat-last" | "noop";
  private index = 0;

  constructor(options: SimulationAgentOptions) {
    this.name = options.name ?? "simulation";
    this.steps = options.steps;
    this.onExhausted = options.onExhausted ?? "noop";
  }

  private nextStep(): SimulationStep | null {
    if (this.index < this.steps.length) {
      return this.steps[this.index++] ?? null;
    }
    if (this.onExhausted === "repeat-last" && this.steps.length > 0) {
      return this.steps[this.steps.length - 1] ?? null;
    }
    return null;
  }

  async run(
    prompt: string,
    cwd: string,
    options: AgentRunOptions = {},
  ): Promise<AgentResult> {
    const step = this.nextStep();

    if (!step) {
      return {
        output: {
          success: false,
          summary: "No further work scripted.",
          key_changes_made: [],
          key_learnings: [],
        },
        usage: { ...EMPTY_USAGE },
      };
    }

    for (const message of step.messages ?? []) {
      if (options.signal?.aborted) throw new Error("Agent was aborted");
      options.onMessage?.(message);
      if (step.delayMs) await sleep(step.delayMs);
    }

    if (step.throwPermanent) {
      throw new PermanentAgentError(step.throwPermanent);
    }
    if (step.throwRetryable) {
      const error = new Error(step.throwRetryable);
      (error as Error & { retryable?: boolean }).retryable = true;
      throw error;
    }

    if (step.writeFile) {
      writeFileSync(join(cwd, step.writeFile.path), step.writeFile.content);
    }

    if (!step.output) {
      throw new Error("SimulationStep without output must throw an error");
    }

    const usage: TokenUsage = {
      ...EMPTY_USAGE,
      inputTokens: step.usage?.inputTokens ?? 1200,
      outputTokens: step.usage?.outputTokens ?? 800,
      cacheReadTokens: step.usage?.cacheReadTokens ?? 0,
      cacheCreationTokens: step.usage?.cacheCreationTokens ?? 0,
    };
    options.onUsage?.(usage);

    return { output: step.output, usage };
  }
}
