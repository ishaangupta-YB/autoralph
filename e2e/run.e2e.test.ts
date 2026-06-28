import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.mjs",
);

/** A fake `opencode` binary that writes a file and prints a JSON AgentOutput. */
const FAKE_OPENCODE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const name = "gen-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".txt";
  fs.writeFileSync(name, "work\\n");
  process.stdout.write(
    JSON.stringify({
      success: true,
      summary: "wrote " + name,
      key_changes_made: ["created " + name],
      key_learnings: ["the fake provider ran"],
    }),
  );
});
`;

const isWindows = process.platform === "win32";

describe("orchestration loop e2e (fake opencode binary)", () => {
  let repo: string;
  let binDir: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "autoralph-run-"));
    binDir = mkdtempSync(join(tmpdir(), "autoralph-bin-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git(["init"]);
    git(["config", "user.email", "e2e@autoralph.dev"]);
    git(["config", "user.name", "autoralph e2e"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README.md"), "# e2e\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);

    const fakePath = join(binDir, "opencode");
    writeFileSync(fakePath, FAKE_OPENCODE);
    chmodSync(fakePath, 0o755);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  // The fake binary relies on a shebang, which is not executable via PATH on Windows.
  it.skipIf(isWindows)(
    "runs the loop, commits each successful iteration, and prints a summary",
    () => {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "build a thing",
          "--agent",
          "opencode",
          "--max-iterations",
          "2",
          "--current-branch",
          "--no-board",
        ],
        {
          cwd: repo,
          encoding: "utf-8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            CLOUDFLARE_ACCOUNT_ID: "test-account",
            CLOUDFLARE_API_TOKEN: "test-token",
            HOME: binDir,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("autoralph completed");
      expect(result.stdout).toContain("max-iterations");

      const log = execFileSync("git", ["log", "--format=%s"], {
        cwd: repo,
        encoding: "utf-8",
      });
      const commits = log.trim().split("\n").filter(Boolean);
      // Two autoralph iteration commits plus the initial commit.
      const iterationCommits = commits.filter((c) =>
        c.startsWith("autoralph: iteration"),
      );
      expect(iterationCommits).toHaveLength(2);
    },
  );
});
