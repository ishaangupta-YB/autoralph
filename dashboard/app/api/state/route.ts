import { boardBaseUrl, isDemoMode, type BoardSnapshot } from "@/lib/board";
import { demoSnapshot } from "@/lib/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMPTY: BoardSnapshot = { runs: [], logs: [], startedAt: Date.now() };

/**
 * One-shot snapshot. In demo mode it returns the simulated terminal state;
 * otherwise it proxies the CLI board's `/api/state`. A down board is reported
 * with `connected: false` rather than a hard error so the UI can degrade.
 */
export async function GET() {
  if (isDemoMode()) {
    return Response.json({ connected: true, demo: true, snapshot: demoSnapshot() });
  }

  try {
    const res = await fetch(`${boardBaseUrl()}/api/state`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`board responded ${res.status}`);
    const snapshot = (await res.json()) as BoardSnapshot;
    return Response.json({ connected: true, demo: false, snapshot });
  } catch (error) {
    return Response.json({
      connected: false,
      demo: false,
      snapshot: EMPTY,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
