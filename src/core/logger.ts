import { appendFileSync } from "node:fs";

/**
 * Append-only JSONL lifecycle log. Each call writes one line so a crashed run
 * still leaves a complete, parseable trail. The active log path is process
 * global because agents deep in the call stack should not need it threaded
 * through every signature.
 */
let activeLogPath: string | null = null;

export function setDebugLogPath(path: string | null): void {
  activeLogPath = path;
}

export function getDebugLogPath(): string | null {
  return activeLogPath;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause !== undefined
        ? { cause: serializeError(error.cause) }
        : {}),
    };
  }
  return { value: String(error) };
}

export function appendDebugLog(
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (!activeLogPath) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  });
  try {
    appendFileSync(activeLogPath, `${line}\n`, "utf-8");
  } catch {
    // Logging must never break a run.
  }
}
