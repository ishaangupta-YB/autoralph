import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command, Option } from "commander";

import { createAgent } from "./agents/factory.js";
import { SimulationAgent } from "./agents/simulation.js";
import { buildAgentOutputSchema, type Agent } from "./agents/types.js";
import { BoardHub } from "./board/hub.js";
import { BoardServer } from "./board/server.js";
import { FileBoardStore } from "./board/store.js";
import {
  bootstrapConfig,
  loadConfig,
  type AgentName,
  type PartialConfigFile,
} from "./core/config.js";
import {
  branchExists,
  createBranch,
  ensureGitRepository,
  getHeadCommit,
  hasCommits,
  isWorkingTreeClean,
} from "./core/git.js";
import { Orchestrator } from "./core/orchestrator.js";
import { setupRun } from "./core/run.js";
import { makeRunId, slugify } from "./core/slug.js";
import type { RunView } from "./core/events.js";

interface RunCliOptions {
  agent?: AgentName;
  model?: string;
  fallbackModels?: string;
  maxIterations?: string;
  maxTokens?: string;
  stopWhen?: string;
  branch?: string;
  currentBranch?: boolean;
  push?: boolean;
  board?: boolean;
  boardPort?: string;
  boardHost?: string;
  commitPrefix?: string;
}

function toInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
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

function installSignalHandlers(orchestrator: Orchestrator): () => void {
  const onInt = () => orchestrator.handleInterrupt();
  const onTerm = () => orchestrator.stop();
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

async function startBoard(
  options: RunCliOptions,
  config: ReturnType<typeof loadConfig>,
  cwd: string,
): Promise<{ hub: BoardHub; server?: BoardServer; url?: string }> {
  const store = new FileBoardStore(join(cwd, ".autoralph", "history"));
  const hub = new BoardHub(store);
  if (options.board === false || !config.board.enabled) {
    return { hub };
  }
  const server = new BoardServer({
    hub,
    port: toInt(options.boardPort, "--board-port") ?? config.board.port,
    host: options.boardHost ?? config.board.host,
  });
  const url = await server.start();
  process.stdout.write(`\n  Kanban board: ${url}\n\n`);
  return { hub, server, url };
}

async function runObjective(
  objective: string,
  options: RunCliOptions,
): Promise<void> {
  const cwd = process.cwd();
  ensureGitRepository(cwd);

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
    board: {
      enabled: options.board !== false,
      port: toInt(options.boardPort, "--board-port") ?? 7654,
      host: options.boardHost ?? "127.0.0.1",
    },
  };
  bootstrapConfig();
  const config = loadConfig(overrides);

  if (!options.currentBranch) {
    let branch = options.branch ?? `autoralph/${slugify(objective)}`;
    let suffix = 1;
    while (branchExists(branch, cwd)) {
      branch = `${options.branch ?? `autoralph/${slugify(objective)}`}-${suffix++}`;
    }
    createBranch(branch, cwd);
  } else if (!isWorkingTreeClean(cwd)) {
    process.stderr.write(
      "Warning: working tree is not clean; failed iterations will reset it.\n",
    );
  }

  const baseCommit = hasCommits(cwd) ? getHeadCommit(cwd) : "";
  const runInfo = setupRun({
    runId: makeRunId(objective),
    objective,
    baseCommit,
    cwd,
    stopWhen: options.stopWhen,
  });

  const schema = buildAgentOutputSchema({
    includeStopField: options.stopWhen !== undefined,
  });
  const agent = createAgent({ config, schema, runDir: runInfo.runDir });

  const orchestrator = new Orchestrator({
    agent,
    runInfo,
    objective,
    cwd,
    limits: {
      maxIterations: config.maxIterations,
      maxTokens: config.maxTokens,
      stopWhen: options.stopWhen,
      push: options.push === true,
    },
    commitMessagePrefix: options.commitPrefix,
  });

  const { hub, server, url } = await startBoard(options, config, cwd);
  hub.register(orchestrator);

  const removeSignals = installSignalHandlers(orchestrator);
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
  }
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
    .argument("[objective]", "objective for the agent loop")
    .addOption(
      new Option("-a, --agent <name>", "agent to run").choices([
        "claude",
        "opencode",
      ]),
    )
    .option("-m, --model <id>", "model id (OpenCode via Cloudflare Workers AI)")
    .option("--fallback-models <list>", "comma-separated fallback model ids")
    .option("-i, --max-iterations <n>", "stop after N iterations")
    .option("-t, --max-tokens <n>", "stop after N total tokens")
    .option("-s, --stop-when <text>", "natural-language stop condition")
    .option("-b, --branch <name>", "branch to create for the run")
    .option(
      "--current-branch",
      "run on the current branch instead of a new one",
    )
    .option("--push", "push after each successful iteration")
    .option("--no-board", "disable the Kanban board")
    .option("--board-port <n>", "board port (default 7654)")
    .option("--board-host <host>", "board host (default 127.0.0.1)")
    .option("--commit-prefix <text>", "commit message prefix")
    .action(async (objective: string | undefined, options: RunCliOptions) => {
      if (!objective) {
        program.help();
        return;
      }
      await runObjective(objective, options);
    });

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
