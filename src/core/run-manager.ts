import { join } from "node:path";

import { createAgent } from "../agents/factory.js";
import { buildAgentOutputSchema } from "../agents/types.js";
import type { BoardHub } from "../board/hub.js";
import type { BoardStore } from "../board/store.js";
import type { AgentName, Config } from "./config.js";
import {
  addWorktree,
  branchExists,
  checkoutBranch,
  createBranch,
  getCurrentBranch,
  getHeadCommit,
  hasCommits,
  removeWorktree,
  worktreeExists,
} from "./git.js";
import {
  Orchestrator,
  type ResumeState,
  type RunLimits,
} from "./orchestrator.js";
import {
  readRunConfig,
  setupRun,
  writeRunConfig,
  type RunConfig,
} from "./run.js";
import { makeRunId, slugify } from "./slug.js";

/** Per-run overrides layered over the manager's base {@link Config}. */
export interface LaunchOverrides {
  agent?: AgentName;
  model?: string;
  fallbackModels?: string[];
  maxIterations?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  stopWhen?: string;
  branch?: string;
  /** Run on the current branch instead of cutting a fresh one. */
  useCurrentBranch?: boolean;
  push?: boolean;
  commitPrefix?: string;
  /** Isolate the run in its own git worktree (required for parallel runs). */
  worktree?: boolean;
}

export interface LaunchResult {
  orchestrator: Orchestrator;
  config: RunConfig;
}

export interface RunManagerOptions {
  /** Repository root; the canonical home for branches, worktrees, metadata. */
  cwd: string;
  baseConfig: Config;
  hub: BoardHub;
  /** History store used to seed resumed runs from their last snapshot. */
  store?: BoardStore;
}

/**
 * Owns the lifecycle plumbing shared by every way a run can start: the CLI
 * entrypoint, parallel multi-objective invocations, `resume`, and board-driven
 * launches. It cuts branches/worktrees, lays down run metadata, builds the
 * orchestrator, and registers it with the board hub. Worktrees it creates are
 * tracked so callers can clean them up once their runs settle.
 */
export class RunManager {
  private readonly worktrees: string[] = [];

  constructor(private readonly opts: RunManagerOptions) {}

  /** Set up and register a fresh run. Does not start it — call `.run()`. */
  launch(objective: string, overrides: LaunchOverrides = {}): LaunchResult {
    const { cwd } = this.opts;
    const useWorktree = overrides.worktree === true;
    const useCurrentBranch =
      !useWorktree && overrides.useCurrentBranch === true;
    const runId = makeRunId(objective);
    const branch = useCurrentBranch
      ? getCurrentBranch(cwd)
      : this.uniqueBranch(
          overrides.branch ?? `autoralph/${slugify(objective)}`,
        );

    let agentCwd = cwd;
    let worktreePath: string | undefined;
    if (useWorktree) {
      worktreePath = join(cwd, ".autoralph", "worktrees", runId);
      addWorktree(worktreePath, branch, cwd);
      this.worktrees.push(worktreePath);
      agentCwd = worktreePath;
    } else if (!useCurrentBranch) {
      createBranch(branch, cwd);
    }

    const config = this.toRunConfig({
      runId,
      objective,
      branch,
      useCurrentBranch,
      worktreePath,
      overrides,
    });
    // Persist the recipe in the repo root so `resume` works after a restart.
    writeRunConfig(cwd, config);

    const orchestrator = this.build(config, agentCwd);
    this.opts.hub.register(orchestrator);
    return { orchestrator, config };
  }

  /**
   * Recreate a previously persisted run and continue it from its last recorded
   * iteration. Worktree runs whose directory was cleaned up are re-attached to
   * the (still-present) branch; plain runs check the branch back out.
   */
  resume(runId: string): LaunchResult {
    const { cwd } = this.opts;
    const config = readRunConfig(cwd, runId);
    if (!config) {
      throw new Error(`No persisted run found for "${runId}".`);
    }

    let agentCwd = cwd;
    if (config.worktreePath) {
      if (!worktreeExists(config.worktreePath, cwd)) {
        addWorktree(config.worktreePath, config.branch, cwd);
      }
      agentCwd = config.worktreePath;
      this.worktrees.push(config.worktreePath);
    } else if (!config.useCurrentBranch && branchExists(config.branch, cwd)) {
      checkoutBranch(config.branch, cwd);
    }

    const orchestrator = this.build(config, agentCwd, this.resumeState(runId));
    this.opts.hub.register(orchestrator);
    return { orchestrator, config };
  }

  /** Remove every worktree this manager created (branches are preserved). */
  cleanupWorktrees(): void {
    const { cwd } = this.opts;
    for (const path of this.worktrees.splice(0)) {
      try {
        if (worktreeExists(path, cwd)) removeWorktree(path, cwd);
      } catch {
        // Best-effort: a worktree with uncommitted state may refuse removal.
      }
    }
  }

  /** Seed counters from the last persisted snapshot so numbering continues. */
  private resumeState(runId: string): ResumeState | undefined {
    const persisted = this.opts.store?.load(runId);
    if (!persisted) return undefined;
    const { run } = persisted;
    return {
      currentIteration: run.currentIteration,
      usage: run.usage,
      commitCount: run.commitCount,
      successCount: run.successCount,
      failCount: run.failCount,
    };
  }

  private build(
    config: RunConfig,
    agentCwd: string,
    resumeState?: ResumeState,
  ): Orchestrator {
    const runConfig: Config = {
      ...this.opts.baseConfig,
      agent: config.agent,
      model: config.model,
      fallbackModels: config.fallbackModels,
    };
    const schema = buildAgentOutputSchema({
      includeStopField: config.stopWhen !== undefined,
    });
    const baseCommit = hasCommits(agentCwd) ? getHeadCommit(agentCwd) : "";
    const runInfo = setupRun({
      runId: config.runId,
      objective: config.objective,
      baseCommit,
      cwd: agentCwd,
      stopWhen: config.stopWhen,
    });
    const agent = createAgent({
      config: runConfig,
      schema,
      runDir: runInfo.runDir,
    });
    const limits: RunLimits = {
      maxIterations: config.maxIterations,
      maxTokens: config.maxTokens,
      maxDurationMs: config.maxDurationMs,
      stopWhen: config.stopWhen,
      push: config.push,
    };
    return new Orchestrator({
      agent,
      runInfo,
      objective: config.objective,
      cwd: agentCwd,
      limits,
      commitMessagePrefix: config.commitPrefix,
      maxConsecutiveFailures: config.retry.maxConsecutiveFailures,
      backoffBaseMs: config.retry.backoffBaseMs,
      backoffFactor: config.retry.backoffFactor,
      maxBackoffMs: config.retry.maxBackoffMs,
      resumeState,
    });
  }

  private toRunConfig(args: {
    runId: string;
    objective: string;
    branch: string;
    useCurrentBranch: boolean;
    worktreePath?: string;
    overrides: LaunchOverrides;
  }): RunConfig {
    const base = this.opts.baseConfig;
    const o = args.overrides;
    return {
      runId: args.runId,
      objective: args.objective,
      agent: o.agent ?? base.agent,
      model: o.model ?? base.model,
      fallbackModels: o.fallbackModels ?? base.fallbackModels,
      branch: args.branch,
      useCurrentBranch: args.useCurrentBranch,
      push: o.push === true,
      commitPrefix: o.commitPrefix,
      stopWhen: o.stopWhen,
      maxIterations: o.maxIterations ?? base.maxIterations,
      maxTokens: o.maxTokens ?? base.maxTokens,
      maxDurationMs: o.maxDurationMs ?? base.maxDurationMs,
      retry: base.retry,
      worktreePath: args.worktreePath,
      createdAt: Date.now(),
    };
  }

  private uniqueBranch(desired: string): string {
    const { cwd } = this.opts;
    let branch = desired;
    let suffix = 1;
    while (branchExists(branch, cwd)) {
      branch = `${desired}-${suffix++}`;
    }
    return branch;
  }
}
