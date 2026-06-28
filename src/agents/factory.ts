import { join } from "node:path";

import type { Config } from "../core/config.js";
import { ClaudeAgent } from "./claude.js";
import { OpenCodeAgent } from "./opencode.js";
import type { Agent, AgentOutputSchema } from "./types.js";

export interface CreateAgentParams {
  config: Config;
  schema: AgentOutputSchema;
  /** Run directory used to place agent-local files (e.g. opencode config). */
  runDir: string;
}

/**
 * Construct the configured agent. The set of models handed to OpenCode is the
 * primary model followed by the configured fallbacks (deduplicated), which the
 * agent walks in order when a provider error is retryable.
 */
export function createAgent(params: CreateAgentParams): Agent {
  const { config, schema, runDir } = params;

  switch (config.agent) {
    case "claude":
      return new ClaudeAgent({
        schema,
        binPath: config.agentPathOverride,
        extraArgs: config.agentArgsOverride,
      });

    case "opencode": {
      const models = [config.model, ...config.fallbackModels].filter(
        (model, index, all) => all.indexOf(model) === index,
      );
      return new OpenCodeAgent({
        schema,
        models,
        cloudflare: config.cloudflare,
        configPath: join(runDir, "opencode.json"),
        binPath: config.agentPathOverride,
        extraArgs: config.agentArgsOverride,
      });
    }

    default: {
      const exhaustive: never = config.agent;
      throw new Error(`Unknown agent: ${String(exhaustive)}`);
    }
  }
}
