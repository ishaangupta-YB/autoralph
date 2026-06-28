/**
 * Shared contracts for every agent integration.
 *
 * An agent is any system that, given a prompt and a working directory, performs
 * one incremental unit of work and returns a structured {@link AgentOutput}
 * describing what it did, plus the {@link TokenUsage} it consumed.
 */

export interface AgentOutput {
  /**
   * Whether the iteration produced a meaningful, keepable contribution. When
   * false the orchestrator discards any working-tree changes from this
   * iteration.
   */
  success: boolean;
  /** One-sentence summary of what was accomplished. */
  summary: string;
  /** Material outcomes, grouped by logical unit of work (not by file). */
  key_changes_made: string[];
  /** Surprising or non-obvious learnings worth carrying into future iterations. */
  key_learnings: string[];
  /**
   * Set to true only when a configured stop condition is fully satisfied and
   * the whole loop should end. Present only when a stop condition is active.
   */
  should_fully_stop?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** True when the numbers are approximations rather than provider-reported. */
  estimated?: boolean;
}

export interface AgentResult {
  output: AgentOutput;
  usage: TokenUsage;
}

export interface AgentRunOptions {
  /** Called with cumulative usage as it accrues during a run. */
  onUsage?: (usage: TokenUsage) => void;
  /** Called with human-readable progress text streamed by the agent. */
  onMessage?: (text: string) => void;
  /** Abort the run cooperatively (token cap, shutdown, etc.). */
  signal?: AbortSignal;
  /** Absolute path to mirror the raw agent stream for debugging. */
  logPath?: string;
}

export interface Agent {
  /** Stable identifier used in logs, events, and the board. */
  name: string;
  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult>;
  /** Release any long-lived resources (servers, sockets) at shutdown. */
  close?(): Promise<void> | void;
}

/**
 * Thrown when an agent hits a condition that retrying cannot fix (exhausted
 * credit, invalid credentials). The orchestrator aborts immediately rather
 * than backing off.
 */
export class PermanentAgentError extends Error {
  detail: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "PermanentAgentError";
    this.detail = detail ?? message;
  }
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    estimated: a.estimated || b.estimated,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

export interface AgentOutputSchema {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, unknown>;
}

export interface BuildSchemaOptions {
  includeStopField?: boolean;
}

/**
 * Build the JSON schema that agents must satisfy. The stop field is only
 * advertised when a stop condition is active so simple runs are not asked to
 * reason about a condition that does not exist.
 */
export function buildAgentOutputSchema(
  options: BuildSchemaOptions = {},
): AgentOutputSchema {
  const properties: Record<string, unknown> = {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  };
  const required = ["success", "summary", "key_changes_made", "key_learnings"];

  if (options.includeStopField) {
    properties.should_fully_stop = { type: "boolean" };
  }

  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("expected an array of strings");
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new TypeError("expected every array item to be a string");
    }
    return item;
  });
}

/**
 * Validate and normalize an unknown value into an {@link AgentOutput}. Throws a
 * descriptive error when a required field is missing or mistyped.
 */
export function validateAgentOutput(
  value: unknown,
  schema: AgentOutputSchema,
): AgentOutput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("agent output must be a JSON object");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.success !== "boolean") {
    throw new TypeError("agent output 'success' must be a boolean");
  }
  if (typeof record.summary !== "string") {
    throw new TypeError("agent output 'summary' must be a string");
  }

  const output: AgentOutput = {
    success: record.success,
    summary: record.summary,
    key_changes_made: asStringArray(record.key_changes_made ?? []),
    key_learnings: asStringArray(record.key_learnings ?? []),
  };

  if (schema.properties.should_fully_stop !== undefined) {
    output.should_fully_stop = record.should_fully_stop === true;
  }

  return output;
}
