import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { appendDebugLog, serializeError } from "./logger.js";

/**
 * Canonical absolute path for comparison. `git worktree list` reports the
 * realpath (symlinks resolved), so on platforms where the temp dir is a
 * symlink (e.g. macOS `/var` -> `/private/var`) a plain `resolve()` would not
 * match. Fall back to `resolve()` when the path does not exist on disk yet.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Every git call goes through {@link git}, which uses execFileSync with an argv
 * array (never a shell string). Caller-supplied values such as commit messages,
 * branch names, and paths are therefore inert data: characters like `, $, ", ',
 * and ; cannot be interpreted as shell syntax. Do not add a code path that
 * builds a shell command string from user- or agent-provided input.
 *
 * GIT_TERMINAL_PROMPT=0 is always injected so a misconfigured credential helper
 * cannot hang a long-running loop on a terminal prompt. GPG signing is disabled
 * per-commit via `-c commit.gpgsign=false` because that prompt (pinentry) is
 * separate from the terminal-prompt pathway.
 */
function git(
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): string {
  const baseEnv = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env,
  }).trim();
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf-8");
  return "";
}

function formatGitError(error: unknown): string {
  const parts = [
    error instanceof Error ? error.message : String(error),
    outputText((error as { stdout?: unknown }).stdout),
    outputText((error as { stderr?: unknown }).stderr),
  ]
    .map((part) => part.trim())
    .filter(Boolean);
  return [...new Set(parts)].join("\n");
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? text
  );
}

export class CommitFailedError extends Error {
  detail: string;

  constructor(error: unknown) {
    const detail = formatGitError(error);
    super(`git commit failed: ${firstLine(detail)}`);
    this.name = "CommitFailedError";
    this.detail = detail;
    this.cause = error;
  }
}

export function isGitRepository(cwd: string): boolean {
  try {
    git(["rev-parse", "--git-dir"], cwd, {
      env: { ...process.env, LC_ALL: "C" },
    });
    return true;
  } catch {
    return false;
  }
}

export function ensureGitRepository(cwd: string): void {
  if (!isGitRepository(cwd)) {
    throw new Error(
      'autoralph must run inside a git repository. Run "git init" first.',
    );
  }
}

export function getCurrentBranch(cwd: string): string {
  try {
    return git(["symbolic-ref", "--short", "HEAD"], cwd);
  } catch {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  }
}

export function getHeadCommit(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd);
}

export function hasCommits(cwd: string): boolean {
  try {
    git(["rev-parse", "HEAD"], cwd);
    return true;
  } catch {
    return false;
  }
}

export function isWorkingTreeClean(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd) === "";
}

export function createBranch(branchName: string, cwd: string): void {
  git(["checkout", "-b", branchName], cwd);
}

export function branchExists(branchName: string, cwd: string): boolean {
  try {
    git(["rev-parse", "--verify", `refs/heads/${branchName}`], cwd);
    return true;
  } catch {
    return false;
  }
}

export function checkoutBranch(branchName: string, cwd: string): void {
  git(["checkout", branchName], cwd);
}

/**
 * Create a detached worktree at {@link path} for parallel, isolated runs. Each
 * worktree shares the repository's object store but has its own working tree
 * and index, so concurrent runs never clobber one another's files. When
 * {@link branch} does not yet exist it is created from {@link startPoint}
 * (defaults to HEAD); otherwise the existing branch is checked out.
 */
export function addWorktree(
  path: string,
  branch: string,
  cwd: string,
  startPoint = "HEAD",
): void {
  const args = branchExists(branch, cwd)
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, startPoint];
  git(args, cwd);
}

/** Remove a worktree directory (the branch and its commits are preserved). */
export function removeWorktree(path: string, cwd: string): void {
  git(["worktree", "remove", "--force", path], cwd);
}

/** True when {@link path} is registered as a worktree of the repo at {@link cwd}. */
export function worktreeExists(path: string, cwd: string): boolean {
  try {
    const list = git(["worktree", "list", "--porcelain"], cwd);
    const resolved = canonicalPath(path);
    return list
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .some(
        (line) =>
          canonicalPath(line.slice("worktree ".length).trim()) === resolved,
      );
  } catch {
    return false;
  }
}

/**
 * Stage everything and commit. Returns false when there was nothing to commit
 * (a no-op iteration that nevertheless reported success). Throws
 * {@link CommitFailedError} when a hook or git itself rejects the commit, so
 * the caller can preserve the work for repair instead of discarding it.
 */
export function commitAll(message: string, cwd: string): boolean {
  git(["add", "-A"], cwd);

  try {
    git(["diff", "--cached", "--quiet"], cwd);
    return false;
  } catch {
    // Exit 1 means there are staged changes to commit.
  }

  const commitArgs = [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "commit",
    "-m",
    message,
  ];

  try {
    git(commitArgs, cwd);
    return true;
  } catch (error) {
    const commitError = new CommitFailedError(error);
    appendDebugLog("git:commit:failed", {
      error: serializeError(error),
      detail: commitError.detail,
    });
    throw commitError;
  }
}

export function resetHard(cwd: string): void {
  git(["reset", "--hard", "HEAD"], cwd);
  git(["clean", "-fd"], cwd);
}

export function pushCurrentBranch(cwd: string): void {
  let hasUpstream = true;
  try {
    git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      cwd,
    );
  } catch {
    hasUpstream = false;
  }

  if (hasUpstream) {
    git(["push"], cwd);
    return;
  }
  git(["remote", "get-url", "origin"], cwd);
  git(["push", "-u", "origin", "HEAD"], cwd);
}

export interface BranchDiffStats {
  commits: number;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
}

export function getBranchDiffStats(
  baseCommit: string,
  cwd: string,
): BranchDiffStats {
  const stats: BranchDiffStats = {
    commits: 0,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };
  if (!baseCommit) return stats;

  const range = `${baseCommit}..HEAD`;
  stats.commits =
    Number.parseInt(
      git(["rev-list", "--count", "--first-parent", range], cwd),
      10,
    ) || 0;

  const numstat = git(["diff", "--numstat", range], cwd);
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const [added, deleted] = line.split("\t");
    stats.filesChanged++;
    if (added === "-" || deleted === "-") continue;
    stats.linesAdded += Number.parseInt(added ?? "0", 10) || 0;
    stats.linesDeleted += Number.parseInt(deleted ?? "0", 10) || 0;
  }

  return stats;
}
