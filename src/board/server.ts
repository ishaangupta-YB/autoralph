import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";

import { renderIndexHtml } from "./assets.js";
import type { BoardHub, BoardSnapshot } from "./hub.js";

export interface BoardServerOptions {
  hub: BoardHub;
  port?: number;
  host?: string;
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
  private clients = new Set<ServerResponse>();
  private boundPort: number | null = null;
  private onUpdate: (snapshot: BoardSnapshot) => void;

  constructor(options: BoardServerOptions) {
    this.hub = options.hub;
    this.requestedPort = options.port ?? 7654;
    this.host = options.host ?? "127.0.0.1";
    this.server = createServer((req, res) => this.handle(req, res));
    this.onUpdate = (snapshot) => this.broadcast(snapshot);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderIndexHtml());
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

    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
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
