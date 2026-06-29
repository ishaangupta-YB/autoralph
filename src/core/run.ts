import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";

import { buildAgentOutputSchema, type AgentOutput } from "../agents/types.js";
import type { AgentName, RetryConfig } from "./config.js";

export interface RunInfo {
  runId: string;
  runDir: string;
  promptPath: string;
  notesPath: string;
  schemaPath: string;
  logPath: string;
  baseCommit: string;
  stopWhen: string | undefined;
}

const LOG_FILENAME = "autoralph.log";
// Ignore the whole metadata dir: per-run state under runs/ and the persisted
// board history under history/ are both local-only and must stay untracked.
const RUN_METADATA_IGNORE = ".autoralph/";

/**
 * Keep run metadata out of version control by appending to the local
 * .git/info/exclude rather than mutating the tracked .gitignore. This keeps the
 * ignore rule scoped to the current clone.
 */
function ensureRunMetadataIgnored(cwd: string): void {
  const excludePath = execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd, encoding: "utf-8" },
  ).trim();
  const resolved = isAbsolute(excludePath)
    ? excludePath
    : join(cwd, excludePath);
  mkdirSync(dirname(resolved), { recursive: true });

  if (existsSync(resolved)) {
    const content = readFileSync(resolved, "utf-8");
    if (
      content.split("\n").some((line) => line.trim() === RUN_METADATA_IGNORE)
    ) {
      return;
    }
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    appendFileSync(resolved, `${separator}${RUN_METADATA_IGNORE}\n`, "utf-8");
  } else {
    writeFileSync(resolved, `${RUN_METADATA_IGNORE}\n`, "utf-8");
  }
}

export interface SetupRunParams {
  runId: string;
  objective: string;
  baseCommit: string;
  cwd: string;
  stopWhen?: string;
}

export function setupRun(params: SetupRunParams): RunInfo {
  const { runId, objective, baseCommit, cwd, stopWhen } = params;
  ensureRunMetadataIgnored(cwd);

  const runDir = join(cwd, ".autoralph", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const promptPath = join(runDir, "prompt.md");
  writeFileSync(promptPath, `${objective}\n`, "utf-8");

  const notesPath = join(runDir, "notes.md");
  if (!existsSync(notesPath)) {
    writeFileSync(
      notesPath,
      `# autoralph run: ${runId}\n\nObjective: see .autoralph/runs/${runId}/prompt.md\n\n## Iteration Log\n`,
      "utf-8",
    );
  }

  const schemaPath = join(runDir, "output-schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify(
      buildAgentOutputSchema({ includeStopField: stopWhen !== undefined }),
      null,
      2,
    ),
    "utf-8",
  );

  return {
    runId,
    runDir,
    promptPath,
    notesPath,
    schemaPath,
    logPath: join(runDir, LOG_FILENAME),
    baseCommit,
    stopWhen,
  };
}

function formatListSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `**${title}:**\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

/**
 * Append an iteration entry to the persistent notes file. This file is injected
 * into subsequent prompts and is the run's shared long-term memory.
 */
export function appendNotes(
  notesPath: string,
  iteration: number,
  output: Pick<AgentOutput, "summary" | "key_changes_made" | "key_learnings">,
): void {
  const entry = [
    `\n### Iteration ${iteration}\n`,
    `**Summary:** ${output.summary}\n`,
    formatListSection("Changes", output.key_changes_made),
    formatListSection("Learnings", output.key_learnings),
  ].join("\n");
  appendFileSync(notesPath, entry, "utf-8");
}

export function readNotes(notesPath: string): string {
  return existsSync(notesPath) ? readFileSync(notesPath, "utf-8") : "";
}

/**
 * Everything needed to recreate a run later (`autoralph resume <id>`). Persisted
 * to `.autoralph/runs/<runId>/run.json` in the repository root so it survives a
 * board restart and is discoverable independently of in-memory state.
 */
export interface RunConfig {
  runId: string;
  objective: string;
  agent: AgentName;
  model: string;
  fallbackModels: string[];
  branch: string;
  useCurrentBranch: boolean;
  push: boolean;
  commitPrefix?: string;
  stopWhen?: string;
  maxIterations?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  retry: RetryConfig;
  /** Absolute path of the isolated worktree, when the run uses one. */
  worktreePath?: string;
  createdAt: number;
}

const RUN_CONFIG_FILENAME = "run.json";

function runsRootDir(repoRoot: string): string {
  return join(repoRoot, ".autoralph", "runs");
}

/** Persist a run's full configuration to the repo-root metadata directory. */
export function writeRunConfig(repoRoot: string, config: RunConfig): void {
  const dir = join(runsRootDir(repoRoot), config.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, RUN_CONFIG_FILENAME),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}

/** Read a persisted run configuration, or null when it does not exist. */
export function readRunConfig(
  repoRoot: string,
  runId: string,
): RunConfig | null {
  const path = join(runsRootDir(repoRoot), runId, RUN_CONFIG_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RunConfig;
  } catch {
    return null;
  }
}

/** List every persisted run configuration, newest-first. */
export function listRunConfigs(repoRoot: string): RunConfig[] {
  const root = runsRootDir(repoRoot);
  if (!existsSync(root)) return [];
  const configs: RunConfig[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const config = readRunConfig(repoRoot, entry.name);
    if (config) configs.push(config);
  }
  return configs.sort((a, b) => b.createdAt - a.createdAt);
}
