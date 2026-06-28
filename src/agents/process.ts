import { execFileSync, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * Terminate a child process and, on POSIX, its whole process group (so an agent
 * that spawned a server or watcher does not leak). On Windows, taskkill /T tears
 * down the tree rooted at the PID.
 */
export function terminateProcess(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Already exited.
    }
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Not a group leader; fall back to the direct child.
    }
  }
  child.kill("SIGTERM");
}

/**
 * Wire an AbortSignal to terminate a child and reject. Returns true when the
 * signal was already aborted so the caller can return early.
 */
export function wireAbortSignal(
  signal: AbortSignal | undefined,
  child: ChildProcess,
  reject: (error: Error) => void,
  onAbort: () => void = () => terminateProcess(child),
): boolean {
  if (!signal) return false;

  const handler = () => {
    onAbort();
    reject(new Error("Agent was aborted"));
  };
  if (signal.aborted) {
    handler();
    return true;
  }
  signal.addEventListener("abort", handler, { once: true });
  child.on("close", () => signal.removeEventListener("abort", handler));
  return false;
}

/** Parse a JSONL stream line-by-line, skipping unparseable lines. */
export function parseJsonLines<T>(
  stream: Readable,
  onEvent: (event: T) => void,
  onChunk?: (chunk: Buffer) => void,
): void {
  let buffer = "";
  stream.on("data", (data: Buffer) => {
    onChunk?.(data);
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as T);
      } catch {
        // Skip partial or non-JSON lines.
      }
    }
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "Agent was aborted")
  );
}
