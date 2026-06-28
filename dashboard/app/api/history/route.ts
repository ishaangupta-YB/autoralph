import {
  boardBaseUrl,
  isDemoMode,
  type PersistedRun,
  type RunHistorySummary,
} from "@/lib/board";
import { demoHistory, demoHistoryRun } from "@/lib/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Run history, mirroring the CLI board's `/api/history`. Without a `runId` it
 * returns the list of run summaries; with one it returns that run's full state
 * and logs. In demo mode it serves a self-contained history; otherwise it
 * proxies the CLI board, degrading to `connected: false` when the board is
 * down so the UI can show an empty state instead of erroring.
 */
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("runId");

  if (isDemoMode()) {
    if (runId) {
      const run = demoHistoryRun(runId) ?? null;
      return Response.json({ connected: true, demo: true, run });
    }
    return Response.json({ connected: true, demo: true, runs: demoHistory() });
  }

  const target = runId
    ? `${boardBaseUrl()}/api/history?runId=${encodeURIComponent(runId)}`
    : `${boardBaseUrl()}/api/history`;

  try {
    const res = await fetch(target, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) {
      return Response.json({ connected: true, demo: false, run: null });
    }
    if (!res.ok) throw new Error(`board responded ${res.status}`);
    const data = await res.json();
    if (runId) {
      return Response.json({
        connected: true,
        demo: false,
        run: data as PersistedRun,
      });
    }
    return Response.json({
      connected: true,
      demo: false,
      runs: (data as { runs: RunHistorySummary[] }).runs ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return runId
      ? Response.json({
          connected: false,
          demo: false,
          run: null,
          error: message,
        })
      : Response.json({
          connected: false,
          demo: false,
          runs: [],
          error: message,
        });
  }
}
