import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/control/route";

const original = process.env.AUTORALPH_DASHBOARD_DEMO;

beforeEach(() => {
  process.env.AUTORALPH_DASHBOARD_DEMO = "1";
});
afterEach(() => {
  if (original === undefined) delete process.env.AUTORALPH_DASHBOARD_DEMO;
  else process.env.AUTORALPH_DASHBOARD_DEMO = original;
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/control", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("control route (demo mode)", () => {
  it("advertises read-only capabilities with the live demo runs", async () => {
    const data = await GET().then((r) => r.json());
    expect(data.demo).toBe(true);
    expect(data.canLaunch).toBe(false);
    expect(data.agents).toEqual([]);
    // The terminal demo snapshot has no running runs, so liveRuns is empty.
    expect(Array.isArray(data.liveRuns)).toBe(true);
  });

  it("answers control actions with a harmless no-op", async () => {
    const res = await POST(post({ action: "start", objective: "x" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, demo: true, runId: "demo-noop" });
  });

  it("rejects a malformed JSON body before touching demo logic", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
  });
});

describe("control route (no board)", () => {
  beforeEach(() => {
    delete process.env.AUTORALPH_DASHBOARD_DEMO;
    // Point at a port nothing is listening on so the proxy fails fast.
    process.env.AUTORALPH_BOARD_URL = "http://127.0.0.1:1";
  });
  afterEach(() => {
    delete process.env.AUTORALPH_BOARD_URL;
  });

  it("degrades to disconnected capabilities when the board is down", async () => {
    const data = await GET().then((r) => r.json());
    expect(data.connected).toBe(false);
    expect(data.canLaunch).toBe(false);
    expect(typeof data.error).toBe("string");
  });
});
