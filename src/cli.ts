import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command, Option } from "commander";

import { SimulationAgent } from "./agents/simulation.js";
import type { Agent } from "./agents/types.js";
import { BoardHub } from "./board/hub.js";
import {
  BoardServer,
  type LaunchRequest,
  type RunController,
} from "./board/server.js";
import { FileBoardStore } from "./board/store.js";
import {
  AGENT_NAMES,
  bootstrapConfig,
  loadConfig,
  type AgentName,
  type Config,
  type PartialConfigFile,
} from "./core/config.js";
import {
  ensureGitRepository,
  getHeadCommit,
  isWorkingTreeClean,
} from "./core/git.js";
import { Orchestrator } from "./core/orchestrator.js";
import { RunManager, type LaunchOverrides } from "./core/run-manager.js";
import { listRunConfigs, setupRun } from "./core/run.js";
import { makeRunId } from "./core/slug.js";
import type { RunView } from "./core/events.js";

interface RunCliOptions {
  agent?: AgentName;
  model?: string;
  fallbackModels?: string;
  maxIterations?: string;
  maxTokens?: string;
  maxDuration?: string;
  stopWhen?: string;
  branch?: string;
  currentBranch?: boolean;
  worktree?: boolean;
  keepWorktrees?: boolean;
  push?: boolean;
  board?: boolean;
  boardPort?: string;
  boardHost?: string;
  control?: boolean;
  commitPrefix?: string;
  backoffBase?: string;
  backoffFactor?: string;
  maxBackoff?: string;
  maxFailures?: string;
}

function toInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function toFloat(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

/** Seconds (CLI-friendly) to milliseconds (internal). */
function secondsToMs(
  value: string | undefined,
  label: string,
): number | undefined {
  const seconds = toFloat(value, label);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

/** Resolve the effective configuration from CLI flags, file, and env. */
function resolveConfig(options: RunCliOptions): Config {
  const overrides: PartialConfigFile = {
    agent: options.agent,
    model: options.model,
    fallbackModels: options.fallbackModels
      ? options.fallbackModels
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : undefined,
    maxIterations: toInt(options.maxIterations, "--max-iterations"),
    maxTokens: toInt(options.maxTokens, "--max-tokens"),
    maxDurationMs: secondsToMs(options.maxDuration, "--max-duration"),
    board: {
      enabled: options.board !== false,
      port: toInt(options.boardPort, "--board-port") ?? 7654,
      host: options.boardHost ?? "127.0.0.1",
    },
    retry: {
      maxConsecutiveFailures: toInt(options.maxFailures, "--max-failures"),
      backoffBaseMs: secondsToMs(options.backoffBase, "--backoff-base"),
      backoffFactor: toFloat(options.backoffFactor, "--backoff-factor"),
      maxBackoffMs: secondsToMs(options.maxBackoff, "--max-backoff"),
    },
  };
  bootstrapConfig();
  return loadConfig(overrides);
}

/** Per-run overrides derived from the CLI flags (excludes global config). */
function launchOverrides(options: RunCliOptions): LaunchOverrides {
  return {
    agent: options.agent,
    model: options.model,
    fallbackModels: options.fallbackModels
      ? options.fallbackModels
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : undefined,
    maxIterations: toInt(options.maxIterations, "--max-iterations"),
    maxTokens: toInt(options.maxTokens, "--max-tokens"),
    maxDurationMs: secondsToMs(options.maxDuration, "--max-duration"),
    stopWhen: options.stopWhen,
    branch: options.branch,
    push: options.push === true,
    commitPrefix: options.commitPrefix,
  };
}

function printSummary(view: RunView, boardUrl?: string): void {
  const tokens = view.usage.inputTokens + view.usage.outputTokens;
  const lines = [
    "",
    `  autoralph ${view.status}${view.stopReason ? ` (${view.stopReason})` : ""}`,
    `  agent:       ${view.agent}`,
    `  branch:      ${view.branch}`,
    `  iterations:  ${view.currentIteration}`,
    `  commits:     ${view.commitCount}`,
    `  ok / fail:   ${view.successCount} / ${view.failCount}`,
    `  tokens:      ${view.usage.estimated ? "~" : ""}${tokens}`,
  ];
  if (boardUrl) lines.push(`  board:       ${boardUrl}`);
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Route SIGINT/SIGTERM to every live run on the hub (graceful, then force). */
function installSignalHandlers(hub: BoardHub): () => void {
  const onInt = () => hub.liveRunIds().forEach((id) => hub.stopRun(id, false));
  const onTerm = () => hub.liveRunIds().forEach((id) => hub.stopRun(id, true));
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

function isAgentName(value: string | undefined): value is AgentName {
  return (
    value !== undefined && (AGENT_NAMES as readonly string[]).includes(value)
  );
}

async function startBoard(
  options: RunCliOptions,
  config: Config,
  hub: BoardHub,
  controller?: RunController,
): Promise<{ server?: BoardServer; url?: string }> {
  if (options.board === false || !config.board.enabled) {
    return {};
  }
  const server = new BoardServer({
    hub,
    port: toInt(options.boardPort, "--board-port") ?? config.board.port,
    host: options.boardHost ?? config.board.host,
    controller,
  });
  const url = await server.start();
  process.stdout.write(`\n  Kanban board: ${url}\n\n`);
  return { server, url };
}

async function runObjectives(
  objectives: string[],
  options: RunCliOptions,
): Promise<void> {
  const cwd = process.cwd();
  ensureGitRepository(cwd);
  const config = resolveConfig(options);

  const parallel = objectives.length > 1;
  const useWorktree = parallel || options.worktree === true;
  const useCurrentBranch =
    !useWorktree && options.currentBranch === true && objectives.length === 1;

  if (parallel && options.currentBranch) {
    process.stderr.write(
      "Note: --current-branch is ignored for parallel runs; each runs in its own worktree.\n",
    );
  }
  if (useCurrentBranch && !isWorkingTreeClean(cwd)) {
    process.stderr.write(
      "Warning: working tree is not clean; failed iterations will reset it.\n",
    );
  }

  const store = new FileBoardStore(join(cwd, ".autoralph", "history"));
  const hub = new BoardHub(store);
  const manager = new RunManager({ cwd, baseConfig: config, hub, store });

  const controller =
    options.control === false ? undefined : makeController(manager);
  const { server, url } = await startBoard(options, config, hub, controller);

  const overrides = launchOverrides(options);
  const launched = objectives.map((objective) =>
    manager.launch(objective, {
      ...overrides,
      worktree: useWorktree,
      useCurrentBranch,
    }),
  );

  const removeSignals = installSignalHandlers(hub);
  try {
    const views = await Promise.all(launched.map((l) => l.orchestrator.run()));
    for (const view of views) printSummary(view, url);
    if (server) {
      process.stdout.write("  Board still live. Press Ctrl+C to exit.\n");
      await waitForInterrupt();
    }
  } finally {
    removeSignals();
    await server?.stop();
    if (!options.keepWorktrees) manager.cleanupWorktrees();
  }
}

/** Build the board's run controller; board-launched runs are worktree-isolated. */
function makeController(manager: RunManager): RunController {
  return {
    agents: [...AGENT_NAMES],
    launch: async (request: LaunchRequest) => {
      const { orchestrator, config } = manager.launch(request.objective, {
        agent: isAgentName(request.agent) ? request.agent : undefined,
        maxIterations: request.maxIterations,
        maxTokens: request.maxTokens,
        stopWhen: request.stopWhen,
        worktree: true,
        push: false,
      });
      // Fire-and-forget: the hub streams its progress to every board client.
      void orchestrator.run();
      return { runId: config.runId };
    },
  };
}

async function resumeRun(runId: string, options: RunCliOptions): Promise<void> {
  const cwd = process.cwd();
  ensureGitRepository(cwd);
  const config = resolveConfig(options);

  const store = new FileBoardStore(join(cwd, ".autoralph", "history"));
  const hub = new BoardHub(store);
  const manager = new RunManager({ cwd, baseConfig: config, hub, store });

  const { orchestrator, config: runConfig } = manager.resume(runId);
  process.stdout.write(
    `\n  Resuming ${runConfig.runId} on ${runConfig.branch}\n`,
  );

  const controller =
    options.control === false ? undefined : makeController(manager);
  const { server, url } = await startBoard(options, config, hub, controller);

  const removeSignals = installSignalHandlers(hub);
  try {
    const view = await orchestrator.run();
    printSummary(view, url);
    if (server) {
      process.stdout.write("  Board still live. Press Ctrl+C to exit.\n");
      await waitForInterrupt();
    }
  } finally {
    removeSignals();
    await server?.stop();
    if (!options.keepWorktrees) manager.cleanupWorktrees();
  }
}

function listRuns(): void {
  const cwd = process.cwd();
  ensureGitRepository(cwd);
  const configs = listRunConfigs(cwd);
  if (configs.length === 0) {
    process.stdout.write("\n  No persisted runs found.\n\n");
    return;
  }
  process.stdout.write("\n  Persisted runs (newest first):\n\n");
  for (const c of configs) {
    const when = new Date(c.createdAt).toISOString();
    const objective =
      c.objective.length > 60 ? `${c.objective.slice(0, 57)}…` : c.objective;
    process.stdout.write(
      `  ${c.runId}\n    agent: ${c.agent}  branch: ${c.branch}  ${when}\n    ${objective}\n\n`,
    );
  }
  process.stdout.write("  Resume one with: autoralph resume <runId>\n\n");
}

function waitForInterrupt(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

function initDemoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoralph-demo-"));
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init"]);
  run(["config", "user.email", "demo@autoralph.dev"]);
  run(["config", "user.name", "autoralph demo"]);
  writeFileSync(join(dir, "README.md"), "# autoralph demo workspace\n");
  run(["add", "-A"]);
  run(["-c", "commit.gpgsign=false", "commit", "-m", "chore: seed demo repo"]);
  return dir;
}

function demoAgent(name: string): Agent {
  const ok = (
    summary: string,
    changes: string[],
    learnings: string[],
    file: string,
  ) => ({
    output: {
      success: true,
      summary,
      key_changes_made: changes,
      key_learnings: learnings,
    },
    writeFile: { path: file, content: `${summary}\n` },
    messages: [`Planning: ${summary}`, "Editing files…", "Validating…"],
    delayMs: 350,
  });

  if (name === "claude") {
    return new SimulationAgent({
      name: "claude",
      steps: [
        ok(
          "Scaffold module skeleton",
          ["Added module entrypoint"],
          ["Repo uses ESM"],
          "a.txt",
        ),
        ok(
          "Implement core function",
          ["Wrote core logic"],
          ["Edge case on empty input"],
          "b.txt",
        ),
        {
          throwRetryable: "server_is_overloaded: provider busy",
          messages: ["Calling model…"],
          delayMs: 300,
        },
        ok("Add tests", ["Added unit tests"], ["All paths covered"], "c.txt"),
      ],
    });
  }
  return new SimulationAgent({
    name: "opencode",
    steps: [
      ok(
        "Set up Cloudflare provider",
        ["Configured Kimi model"],
        ["Workers AI is OpenAI-compatible"],
        "x.txt",
      ),
      {
        output: {
          success: false,
          summary: "Attempted refactor did not improve anything",
          key_changes_made: [],
          key_learnings: ["This direction is a dead end; reverting"],
        },
        messages: ["Trying refactor…", "Measuring…"],
        delayMs: 300,
      },
      ok(
        "Optimize hot path",
        ["Reduced allocations"],
        ["Batching helps throughput"],
        "y.txt",
      ),
      ok("Document usage", ["Updated docs"], [], "z.txt"),
    ],
  });
}

async function runDemo(options: {
  boardPort?: string;
  boardHost?: string;
}): Promise<void> {
  const hub = new BoardHub();
  const server = new BoardServer({
    hub,
    port: toInt(options.boardPort, "--board-port") ?? 7654,
    host: options.boardHost ?? "127.0.0.1",
  });
  const url = await server.start();
  process.stdout.write(`\n  autoralph demo board: ${url}\n\n`);

  const orchestrators = (["claude", "opencode"] as const).map((name) => {
    const dir = initDemoRepo();
    const runInfo = setupRun({
      runId: makeRunId(`demo-${name}`),
      objective:
        name === "claude"
          ? "Demo: build a feature with Claude Code"
          : "Demo: build a feature with OpenCode on Kimi",
      baseCommit: getHeadCommit(dir),
      cwd: dir,
    });
    const orchestrator = new Orchestrator({
      agent: demoAgent(name),
      runInfo,
      objective: runInfo.runId,
      cwd: dir,
      limits: { maxIterations: 4 },
      backoffBaseMs: 1500,
    });
    hub.register(orchestrator);
    return orchestrator;
  });

  const stop = () => orchestrators.forEach((o) => o.handleInterrupt());
  process.on("SIGINT", stop);

  await Promise.all(orchestrators.map((o) => o.run()));
  process.stdout.write(
    "  Demo complete. Board still live; press Ctrl+C to exit.\n",
  );
  await waitForInterrupt();
  await server.stop();
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("autoralph")
    .description(
      "Autonomous coding-agent orchestrator with a real-time Kanban board.",
    )
    .version("0.1.0");

  program
    .argument(
      "[objectives...]",
      "one or more objectives; multiple run in parallel, each in its own worktree",
    )
    .addOption(
      new Option("-a, --agent <name>", "agent to run").choices([
        ...AGENT_NAMES,
      ]),
    )
    .option("-m, --model <id>", "model id (OpenCode via Cloudflare Workers AI)")
    .option("--fallback-models <list>", "comma-separated fallback model ids")
    .option("-i, --max-iterations <n>", "stop after N iterations")
    .option("-t, --max-tokens <n>", "stop after N total tokens")
    .option(
      "--max-duration <seconds>",
      "stop after N seconds of wall-clock time",
    )
    .option("-s, --stop-when <text>", "natural-language stop condition")
    .option("-b, --branch <name>", "branch to create for the run")
    .option(
      "--current-branch",
      "run on the current branch instead of a new one",
    )
    .option(
      "-w, --worktree",
      "isolate the run in its own git worktree (implied for parallel runs)",
    )
    .option("--keep-worktrees", "do not remove worktrees when runs finish")
    .option("--push", "push after each successful iteration")
    .option("--no-board", "disable the Kanban board")
    .option("--no-control", "disable start/stop control endpoints on the board")
    .option("--board-port <n>", "board port (default 7654)")
    .option("--board-host <host>", "board host (default 127.0.0.1)")
    .option("--commit-prefix <text>", "commit message prefix")
    .option(
      "--max-failures <n>",
      "consecutive failures tolerated before aborting",
    )
    .option(
      "--backoff-base <seconds>",
      "base backoff delay for retryable errors",
    )
    .option("--backoff-factor <n>", "exponential backoff growth factor")
    .option("--max-backoff <seconds>", "cap on any single backoff delay")
    .action(async (objectives: string[], options: RunCliOptions) => {
      if (!objectives || objectives.length === 0) {
        program.help();
        return;
      }
      await runObjectives(objectives, options);
    });

  program
    .command("resume <runId>")
    .description("Resume a previously persisted run from its last iteration.")
    .option("--no-board", "disable the Kanban board")
    .option("--no-control", "disable start/stop control endpoints on the board")
    .option("--keep-worktrees", "do not remove worktrees when the run finishes")
    .option("--board-port <n>", "board port (default 7654)")
    .option("--board-host <host>", "board host (default 127.0.0.1)")
    .action((runId: string, options: RunCliOptions) =>
      resumeRun(runId, options),
    );

  program
    .command("runs")
    .description("List persisted runs that can be resumed.")
    .action(listRuns);

  program
    .command("demo")
    .description("Run a scripted multi-agent demo against the live board.")
    .option("--board-port <n>", "board port (default 7654)")
    .option("--board-host <host>", "board host (default 127.0.0.1)")
    .action(runDemo);

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    process.stderr.write(
      `\nautoralph error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
