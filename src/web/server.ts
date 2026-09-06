import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { authenticateMiniApp, type MiniAppIdentity } from "./auth.js";
import { ApiError, type MiniAppUser, type SessionSnapshot } from "./contracts.js";

export interface MiniAppServerOptions {
  botToken: string;
  publicUrl: string;
  loadSession: (sessionId: number, user: MiniAppUser) => Promise<SessionSnapshot>;
  saveAvailability: (sessionId: number, user: MiniAppUser, input: unknown) => Promise<SessionSnapshot>;
  staticDir?: string;
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/model.js": { file: "model.js", type: "text/javascript; charset=utf-8" },
  "/stream.js": { file: "stream.js", type: "text/javascript; charset=utf-8" },
  "/demo.js": { file: "demo.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
const BODY_LIMIT = 32 * 1024;
const MAX_STREAMS_PER_USER = 3;
const MAX_STREAMS = 100;

function applyHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://*.telegram.me https://t.me",
  ].join("; "));
}

function publicError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(500, "INTERNAL", "Could not load availability. Please try again.");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new ApiError(415, "CONTENT_TYPE", "Send availability as JSON.");
  }
  if (Number(request.headers["content-length"]) > BODY_LIMIT) {
    request.resume();
    throw new ApiError(413, "TOO_LARGE", "Availability is too large.");
  }
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timeout);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("aborted", aborted);
    };
    const fail = (error: unknown) => { cleanup(); request.resume(); reject(error); };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > BODY_LIMIT) { fail(new ApiError(413, "TOO_LARGE", "Availability is too large.")); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ApiError(400, "INVALID_JSON", "Availability must be valid JSON.")); }
    };
    const failed = () => fail(new ApiError(400, "INCOMPLETE", "Availability was not received completely."));
    const aborted = () => failed();
    const timeout = setTimeout(() => fail(new ApiError(408, "TIMEOUT", "Saving took too long. Please try again.")), 10_000);
    timeout.unref();
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("aborted", aborted);
  });
}

/** No public session identifiers or auth credentials are accepted in API URLs. */
export function createMiniAppServer(options: MiniAppServerOptions): Server {
  const publicOrigin = new URL(options.publicUrl).origin;
  const staticDir = options.staticDir ?? fileURLToPath(new URL("../../web/", import.meta.url));
  const streams = new Set<() => void>();
  const streamsPerUser = new Map<number, number>();
  const rates = new Map<number, { startedAt: number; requests: number; saves: number }>();
  let lastRateSweep = Date.now();
  let closing = false;

  function limit(userId: number, saving: boolean): void {
    const now = Date.now();
    if (now - lastRateSweep >= 60_000) {
      for (const [id, rate] of rates) if (now - rate.startedAt >= 60_000) rates.delete(id);
      lastRateSweep = now;
    }
    let rate = rates.get(userId);
    if (!rate || now - rate.startedAt >= 60_000) {
      rate = { startedAt: now, requests: 0, saves: 0 };
      rates.set(userId, rate);
    }
    if (++rate.requests > 120 || (saving && ++rate.saves > 30)) {
      throw new ApiError(429, "RATE_LIMIT", "Please wait a moment before trying again.");
    }
  }

  async function events(response: ServerResponse, identity: MiniAppIdentity): Promise<void> {
    const count = streamsPerUser.get(identity.user.id) ?? 0;
    if (count >= MAX_STREAMS_PER_USER || streams.size >= MAX_STREAMS) {
      throw new ApiError(429, "TOO_MANY_CONNECTIONS", "Close another availability window and try again.");
    }
    streamsPerUser.set(identity.user.id, count + 1);
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let cancelDrain: (() => void) | undefined;
    let lastState = "";
    let lastWrite = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      cancelDrain?.();
      streams.delete(stop);
      const remaining = (streamsPerUser.get(identity.user.id) ?? 1) - 1;
      if (remaining) streamsPerUser.set(identity.user.id, remaining);
      else streamsPerUser.delete(identity.user.id);
      response.off("close", stop);
      if (!response.writableEnded) response.end();
    };
    streams.add(stop);
    response.once("close", stop);

    const write = async (content: string): Promise<boolean> => {
      if (stopped || response.destroyed) { stop(); return false; }
      lastWrite = Date.now();
      if (response.write(content)) return true;
      // Pause polling while the socket drains; never queue more snapshots behind a slow client.
      return new Promise(resolve => {
        const finish = (drained: boolean) => {
          clearTimeout(timeout);
          response.off("drain", drainedHandler);
          cancelDrain = undefined;
          resolve(drained && !stopped);
        };
        const drainedHandler = () => finish(true);
        const timeout = setTimeout(() => {
          finish(false);
          response.destroy();
          stop();
        }, 5_000);
        timeout.unref();
        cancelDrain = () => finish(false);
        response.once("drain", drainedHandler);
      });
    };
    const refresh = async () => {
      try {
        if (stopped) return;
        if (Date.now() >= identity.expiresAt) {
          throw new ApiError(401, "UNAUTHORIZED", "Your Telegram session expired. Close and reopen availability.");
        }
        // The service checks membership on every read, including after roster removal.
        const snapshot = await options.loadSession(identity.sessionId, identity.user);
        if (stopped) return;
        if (!response.headersSent) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          });
        }
        const state = JSON.stringify({ ...snapshot, serverNow: 0 });
        if (state !== lastState) {
          if (!await write(`event: session\ndata: ${JSON.stringify(snapshot)}\n\n`)) return;
          lastState = state;
        } else if (Date.now() - lastWrite >= 15_000) {
          if (!await write(": keepalive\n\n")) return;
        }
        if (snapshot.session.closed) { stop(); return; }
        timer = setTimeout(() => { void refresh(); }, 1_000);
        timer.unref();
      } catch (error) {
        if (stopped) return;
        const exposed = publicError(error);
        if (!response.headersSent) json(response, exposed.status, { error: { code: exposed.code, message: exposed.message } });
        else await write(`event: error\ndata: ${JSON.stringify({ code: exposed.code, message: exposed.message })}\n\n`);
        stop();
      }
    };
    await refresh();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applyHeaders(response);
    if (closing) throw new ApiError(503, "RESTARTING", "Availability is restarting. Please try again.");
    const rawPath = (request.url ?? "/").split("?")[0] ?? "/";
    // Exact raw-path matching also rejects percent-encoded traversal and normalization tricks.
    if (rawPath === "/healthz" && request.method === "GET") { json(response, 200, { ok: true }); return; }
    if (rawPath.startsWith("/api/")) {
      const url = new URL(request.url ?? "/", publicOrigin);
      if (url.search) throw new ApiError(400, "INVALID_URL", "API URLs must not contain query parameters.");
      if (request.headers.origin !== undefined && request.headers.origin !== publicOrigin) {
        throw new ApiError(403, "ORIGIN", "Open availability from the Telegram group.");
      }
      const identity = authenticateMiniApp(request.headers.authorization, options.botToken);
      if (rawPath === "/api/availability" && request.method === "POST") {
        if (request.headers.origin !== publicOrigin) throw new ApiError(403, "ORIGIN", "A same-origin request is required.");
        limit(identity.user.id, true);
        const input = await readJson(request);
        json(response, 200, await options.saveAvailability(identity.sessionId, identity.user, input));
      } else if (rawPath === "/api/session" && request.method === "GET") {
        limit(identity.user.id, false);
        json(response, 200, await options.loadSession(identity.sessionId, identity.user));
      } else if (rawPath === "/api/events" && request.method === "GET") {
        limit(identity.user.id, false);
        await events(response, identity);
      } else {
        throw new ApiError(404, "NOT_FOUND", "This endpoint does not exist.");
      }
      return;
    }
    const asset = Object.hasOwn(STATIC_FILES, rawPath) ? STATIC_FILES[rawPath] : undefined;
    if (!asset || (request.method !== "GET" && request.method !== "HEAD")) {
      throw new ApiError(404, "NOT_FOUND", "This page does not exist.");
    }
    let contents: Buffer;
    try { contents = await readFile(join(staticDir, asset.file)); }
    catch { throw new ApiError(404, "NOT_FOUND", "This page does not exist."); }
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": asset.type, "Content-Length": contents.length });
    response.end(request.method === "HEAD" ? undefined : contents);
  }

  const server = createServer({ maxHeaderSize: 20 * 1024 }, (request, response) => {
    void handle(request, response).catch(error => {
      const exposed = publicError(error);
      if (exposed.status === 429) response.setHeader("Retry-After", "60");
      json(response, exposed.status, { error: { code: exposed.code, message: exposed.message } });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  // Node otherwise waits indefinitely for SSE before close's callback can fire.
  const originalClose = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    closing = true;
    for (const stop of streams) stop();
    rates.clear();
    return originalClose(callback);
  };
  return server;
}
