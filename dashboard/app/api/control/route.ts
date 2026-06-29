import {
  boardBaseUrl,
  isDemoMode,
  type ControlCapabilities,
} from "@/lib/board";
import { demoSnapshot } from "@/lib/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Control plane, mirroring the CLI board's `GET/POST /api/control`
 * (`src/board/server.ts`). GET reports launch capabilities and the live run
 * ids; POST forwards `start` / `stop` / `force-stop` actions to the board.
 *
 * Demo mode is read-only: it advertises `canLaunch: false` (there is no real
 * orchestrator behind it) and answers control POSTs with a harmless no-op so
 * the UI can be exercised without a running CLI.
 */
export async function GET() {
  if (isDemoMode()) {
    const live = demoSnapshot()
      .runs.filter((r) => r.status === "running")
      .map((r) => r.runId);
    const caps: ControlCapabilities = {
      canLaunch: false,
      agents: [],
      liveRuns: live,
    };
    return Response.json({ connected: true, demo: true, ...caps });
  }

  try {
    const res = await fetch(`${boardBaseUrl()}/api/control`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`board responded ${res.status}`);
    const caps = (await res.json()) as ControlCapabilities;
    return Response.json({ connected: true, demo: false, ...caps });
  } catch (error) {
    return Response.json({
      connected: false,
      demo: false,
      canLaunch: false,
      agents: [],
      liveRuns: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (isDemoMode()) {
    return Response.json({ ok: true, demo: true, runId: "demo-noop" });
  }

  try {
    const res = await fetch(`${boardBaseUrl()}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
