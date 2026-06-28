import { boardBaseUrl, isDemoMode } from "@/lib/board";
import { demoTimeline } from "@/lib/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * SSE endpoint the browser subscribes to (same origin, so no CORS). In demo
 * mode it replays the scripted timeline frame-by-frame, then holds the final
 * frame open. Otherwise it proxies the CLI board's `/api/events` stream,
 * forwarding every chunk and closing cleanly so the client's EventSource
 * reconnects if the board restarts.
 */
export async function GET(request: Request) {
  if (isDemoMode()) {
    return demoStream(request);
  }
  return proxyStream(request);
}

function demoStream(request: Request): Response {
  const encoder = new TextEncoder();
  const frames = demoTimeline();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      let aborted = false;
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      for (const frame of frames) {
        if (aborted) break;
        controller.enqueue(encoder.encode(sseData(frame)));
        await sleep(650);
      }
      // Hold the connection open on the final frame with periodic heartbeats.
      while (!aborted) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        await sleep(15000);
      }
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

async function proxyStream(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  try {
    const upstream = await fetch(`${boardBaseUrl()}/api/events`, {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      throw new Error(`board responded ${upstream.status}`);
    }
    return new Response(upstream.body, { headers: SSE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        controller.enqueue(
          encoder.encode(`event: board-error\ndata: ${JSON.stringify({ message })}\n\n`),
        );
        controller.close();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
