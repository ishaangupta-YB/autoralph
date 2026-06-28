import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

/** Create a throwaway git repository with one initial commit. */
export function makeTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "autoralph-test-"));
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init"]);
  run(["config", "user.email", "test@autoralph.dev"]);
  run(["config", "user.name", "autoralph test"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface ClosableChild {
  stdout: Readable;
  stderr: Readable;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/**
 * End a fake child's stdout/stderr and emit `close` only once both streams have
 * fully drained. Real child processes emit `close` after their pipes end, so
 * tests that push data then synchronously emit `close` would race the async
 * `data` handlers. This mirrors the real ordering.
 */
export function finishChild(child: ClosableChild, code: number): void {
  let pending = 2;
  const done = () => {
    if (--pending === 0) child.emit("close", code);
  };
  child.stdout.push(null);
  child.stderr.push(null);
  child.stdout.once("end", done);
  child.stderr.once("end", done);
  child.stdout.resume();
  child.stderr.resume();
}

export function gitLog(dir: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], {
    cwd: dir,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}
