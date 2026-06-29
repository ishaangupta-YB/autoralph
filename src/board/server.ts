import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";

import { renderIndexHtml } from "./assets.js";
import type { BoardHub, BoardSnapshot } from "./hub.js";

/** Parameters accepted when starting a run from the board UI. */
export interface LaunchRequest {
  objective: string;
  agent?: string;
  maxIterations?: number;
  maxTokens?: number;
  stopWhen?: string;
}

/**
 * Hook the CLI supplies so the board can start new runs on demand. Absent (or
 * when the board is read-only), the start endpoint is disabled and the UI hides
 * its launch form.
 */
export interface RunController {
  /** Agent identifiers offered in the UI. */
  agents: string[];
  launch(request: LaunchRequest): Promise<{ runId: string }>;
}

export interface BoardServerOptions {
  hub: BoardHub;
  port?: number;
  host?: string;
  /** Enables start/stop control endpoints when provided. */
  controller?: RunController;
}

/**
 * Tiny zero-dependency HTTP server for the real-time board. Serves the embedded
 * UI at `/`, a one-shot JSON snapshot at `/api/state`, and a Server-Sent Events
 * stream at `/api/events` that pushes a full snapshot on every hub update. SSE
 * is used (not websockets) because the data flow is strictly server -> browser,
 * keeping the implementation dependency-free and proxy-friendly.
 */
export class BoardServer {
  private hub: BoardHub;
  private requestedPort: number;
  private host: string;
  private server: Server;
  private controller?: RunController;
  private clients = new Set<ServerResponse>();
  private boundPort: number | null = null;
  private onUpdate: (snapshot: BoardSnapshot) => void;

  constructor(options: BoardServerOptions) {
    this.hub = options.hub;
    this.requestedPort = options.port ?? 7654;
    this.host = options.host ?? "127.0.0.1";
    this.controller = options.controller;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.onUpdate = (snapshot) => this.broadcast(snapshot);
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderIndexHtml());
      return;
    }

    if (url === "/api/control") {
      await this.handleControl(req, res);
      return;
    }

    if (url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.hub.snapshot()));
      return;
    }

    if (url === "/api/events") {
      this.openEventStream(res);
      return;
    }

    if (url === "/api/history" || url.startsWith("/api/history?")) {
      const runId = new URL(url, `http://${this.host}`).searchParams.get(
        "runId",
      );
      if (runId) {
        const detail = this.hub.historyRun(runId);
        if (!detail) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "run not found" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(detail));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runs: this.hub.history() }));
      return;
    }

    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  /**
   * Control plane: `GET` reports capabilities (so the UI can hide controls it
   * cannot use), `POST` starts or stops runs. Start requires a configured
   * {@link RunController}; stop works against any live run on the hub.
   */
  private async handleControl(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === "GET") {
      sendJson(res, 200, {
        canLaunch: this.controller !== undefined,
        agents: this.controller?.agents ?? [],
        liveRuns: this.hub.liveRunIds(),
      });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    let body: ControlRequest;
    try {
      body = (await readJsonBody(req)) as ControlRequest;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    if (body.action === "stop" || body.action === "force-stop") {
      if (typeof body.runId !== "string" || body.runId.length === 0) {
        sendJson(res, 400, { error: "runId is required" });
        return;
      }
      const stopped = this.hub.stopRun(
        body.runId,
        body.action === "force-stop",
      );
      sendJson(res, stopped ? 200 : 404, {
        ok: stopped,
        error: stopped ? undefined : "run not live",
      });
      return;
    }

    if (body.action === "start") {
      if (!this.controller) {
        sendJson(res, 403, { error: "run control is disabled on this board" });
        return;
      }
      if (typeof body.objective !== "string" || body.objective.trim() === "") {
        sendJson(res, 400, { error: "objective is required" });
        return;
      }
      try {
        const { runId } = await this.controller.launch({
          objective: body.objective.trim(),
          agent: body.agent,
          maxIterations: body.maxIterations,
          maxTokens: body.maxTokens,
          stopWhen: body.stopWhen,
        });
        sendJson(res, 200, { ok: true, runId });
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    sendJson(res, 400, { error: "unknown action" });
  }

  private openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    this.writeSnapshot(res, this.hub.snapshot());
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  private writeSnapshot(res: ServerResponse, snapshot: BoardSnapshot): void {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  private broadcast(snapshot: BoardSnapshot): void {
    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  /** Start listening. Resolves with the URL once bound. */
  start(): Promise<string> {
    this.hub.on("update", this.onUpdate);
    return new Promise<string>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.removeListener("error", reject);
        const address = this.server.address() as AddressInfo;
        this.boundPort = address.port;
        resolve(this.url);
      });
    });
  }

  get port(): number {
    return this.boundPort ?? this.requestedPort;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** Stop the server and disconnect any open SSE clients. */
  stop(): Promise<void> {
    this.hub.removeListener("update", this.onUpdate);
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

interface ControlRequest {
  action?: "start" | "stop" | "force-stop";
  runId?: string;
  objective?: string;
  agent?: string;
  maxIterations?: number;
  maxTokens?: number;
  stopWhen?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}
