import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.mjs",
);

/** Wait until the process prints a board URL, then return it. */
function waitForBoardUrl(child: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`No board URL. Output:\n${buffer}`)),
      20_000,
    );
    child.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      const match = buffer.match(/board:\s*(http:\/\/127\.0\.0\.1:\d+)/i);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.on("exit", (code) =>
      reject(new Error(`exited early (${code}). Output:\n${buffer}`)),
    );
  });
}

describe("kanban board e2e", () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
  });

  it("serves the board, state, and SSE over HTTP from the demo command", async () => {
    child = spawn(process.execPath, [cli, "demo", "--board-port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const url = await waitForBoardUrl(child);

    const html = await fetch(`${url}/`).then((r) => r.text());
    expect(html).toContain("autoralph");
    expect(html).toContain("EventSource");

    const health = await fetch(`${url}/healthz`).then((r) => r.text());
    expect(health).toBe("ok");

    // The demo registers two agent runs (claude + opencode).
    const state = await fetch(`${url}/api/state`).then((r) => r.json());
    expect(Array.isArray(state.runs)).toBe(true);
    expect(state.runs.length).toBeGreaterThanOrEqual(1);

    // SSE stream emits at least one snapshot frame.
    const res = await fetch(`${url}/api/events`);
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    const frame = new TextDecoder().decode(chunk.value);
    expect(frame).toContain("data:");
    await reader.cancel();
  });
});
