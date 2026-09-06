import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSessionStartParam } from "./auth.js";
import { ApiError, type SessionSnapshot } from "./contracts.js";
import { createMiniAppServer, type MiniAppServerOptions } from "./server.js";

const TOKEN = "123456789:test-token-only";
const ORIGIN = "https://five-stack-bot.cn.lt";

function authorization(fields: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1_000)),
    user: JSON.stringify({ id: 12345, first_name: "Karolis" }),
    start_param: createSessionStartParam(42, TOKEN),
    ...fields,
  });
  params.sort();
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret)
    .update([...params].map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex"));
  return `tma ${params}`;
}

function snapshot(revision = "initial"): SessionSnapshot {
  return {
    session: {
      id: 42, date: "2026-09-06", timezone: "Europe/Vilnius", openerName: "Jonas",
      startMinutes: 720, endMinutes: 1320, closesAt: Date.now() + 60_000, closed: false, validStacks: [5, 3, 2],
    },
    serverNow: Date.now(), players: [], slots: [],
    me: { id: 12345, revision, responded: false, skipped: false, filler: false, votes: [] }, lock: null,
  };
}

async function fixture(t: TestContext, overrides: Partial<MiniAppServerOptions> = {}) {
  const staticDir = await mkdtemp(join(tmpdir(), "five-stack-web-test-"));
  await Promise.all([
    writeFile(join(staticDir, "index.html"), "<!doctype html><title>Availability</title>"),
    writeFile(join(staticDir, "app.js"), "export const demo = true;"),
    writeFile(join(staticDir, "styles.css"), "body { color: black; }"),
  ]);
  let current = snapshot();
  const server = createMiniAppServer({
    botToken: TOKEN, publicUrl: ORIGIN, staticDir,
    remindNonVoters: async () => ({ message: "Reminded players who haven't voted.", nextAllowedAt: Date.now() + 900_000 }),
    loadSession: async (id, user) => { assert.equal(id, 42); assert.equal(user.id, 12345); return current; },
    saveAvailability: async (id, user, input) => {
      assert.equal(id, 42); assert.equal(user.id, 12345);
      assert.deepEqual(input, { expectedRevision: "initial", votes: [{ slot: 780, value: "yes" }], filler: false, unavailable: false });
      current = { ...current, me: { ...current.me, revision: "saved", responded: true, votes: [{ slot: 780, value: "yes" }] } };
      return current;
    },
    ...overrides,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(staticDir, { recursive: true, force: true });
  });
  return { base, server, headers: { authorization: authorization() }, set: (value: SessionSnapshot) => { current = value; } };
}

test("manual reminder requires signed identity, same origin and an empty body", async t => {
  let reminders = 0;
  const result = { message: "Reminded players who haven't voted.", nextAllowedAt: Date.now() + 900_000 };
  const { base, headers } = await fixture(t, {
    remindNonVoters: async (id, user) => {
      assert.equal(id, 42);
      assert.equal(user.id, 12345);
      reminders++;
      return result;
    },
  });
  const post = (body: string, extraHeaders: Record<string, string>, path = "/api/reminder") =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body });
  assert.equal((await post("{}", { origin: ORIGIN })).status, 401);
  assert.equal((await post("{}", headers)).status, 403);
  assert.equal((await post("{}", { ...headers, origin: "https://other.example" })).status, 403);
  for (const body of ['{"sessionId":43}', '{"userId":99}', "[]", "null", "invalid"]) {
    assert.equal((await post(body, { ...headers, origin: ORIGIN })).status, 400);
  }
  assert.equal((await post("{}", { ...headers, origin: ORIGIN }, "/api/reminder?sessionId=43")).status, 400);
  assert.equal(reminders, 0);
  const response = await post("{}", { ...headers, origin: ORIGIN });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(reminders, 1);
});

test("manual reminder propagates membership, closure and send failures", async t => {
  let error = new ApiError(403, "FORBIDDEN", "Only this group's roster can open its availability.");
  const { base, headers } = await fixture(t, { remindNonVoters: async () => { throw error; } });
  for (const [status, code] of [[403, "FORBIDDEN"], [410, "CLOSED"], [502, "REMINDER_FAILED"]] as const) {
    error = new ApiError(status, code, "Unavailable");
    const response = await fetch(`${base}/api/reminder`, { method: "POST", headers: { ...headers, origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, status);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, code);
  }
});

test("health and demo HTML are public; live API requires signed Telegram authentication", async t => {
  const { base } = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  assert.match(await (await fetch(`${base}/?demo=1`)).text(), /Availability/);
  for (const path of ["/api/session", "/api/events"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: "UNAUTHORIZED", message: "Open availability from the button in your Telegram group." } });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("auth forged, expired, duplicate, missing signed session and spoofed query IDs are rejected", async t => {
  let loads = 0;
  const { base } = await fixture(t, { loadSession: async () => { loads++; return snapshot(); } });
  for (const auth of [authorization().replace("Karolis", "Attacker"),
    authorization({ auth_date: String(Math.floor(Date.now() / 1_000) - 86_401) }),
    authorization({ start_param: "42" }), `${authorization()}&user={}`]) {
    assert.equal((await fetch(`${base}/api/session`, { headers: { authorization: auth } })).status, 401);
  }
  for (const path of ["/api/session?sessionId=43", "/api/events?initData=anything", "/api/session?demo=1"]) {
    assert.equal((await fetch(`${base}${path}`, { headers: { authorization: authorization() } })).status, 400);
  }
  assert.equal(loads, 0);
});

test("snapshot returns authenticated session and same-origin no-cache security headers", async t => {
  const { base, headers } = await fixture(t);
  const response = await fetch(`${base}/api/session`, { headers });
  assert.equal(response.status, 200);
  const data = await response.json() as SessionSnapshot;
  assert.equal(data.session.id, 42);
  assert.equal(data.me.id, 12345);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy")!, /https:\/\/telegram.org/);
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors[^;]+https:\/\/web.telegram.org/);
});

test("saving forwards only verified identity and JSON; rejected origins never mutate", async t => {
  const { base, headers } = await fixture(t);
  const body = JSON.stringify({ expectedRevision: "initial", votes: [{ slot: 780, value: "yes" }], filler: false, unavailable: false });
  for (const origin of [undefined, "https://evil.invalid", "null"]) {
    const response = await fetch(`${base}/api/availability`, {
      method: "POST", body, headers: { ...headers, "content-type": "application/json", ...(origin ? { origin } : {}) },
    });
    assert.equal(response.status, 403);
  }
  const response = await fetch(`${base}/api/availability`, {
    method: "POST", body, headers: { ...headers, "content-type": "application/json", origin: ORIGIN },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as SessionSnapshot).me.revision, "saved");
});

test("invalid, non-JSON and oversized submissions fail before service mutation", async t => {
  let saves = 0;
  const { base, headers } = await fixture(t, { saveAvailability: async () => { saves++; return snapshot(); } });
  for (const [body, type, expected] of [["{", "application/json", 400], ["{}", "text/plain", 415],
    [JSON.stringify({ long: "x".repeat(32 * 1024) }), "application/json", 413]] as const) {
    const response = await fetch(`${base}/api/availability`, { method: "POST", body, headers: { ...headers, origin: ORIGIN, "content-type": type } });
    assert.equal(response.status, expected);
  }
  assert.equal(saves, 0);
});

test("roster denial and conflict errors retain safe status/code; unexpected errors stay private", async t => {
  const { base, headers } = await fixture(t, {
    loadSession: async () => { throw new ApiError(403, "NOT_IN_ROSTER", "You are not in this group's roster."); },
    saveAvailability: async () => { throw new ApiError(409, "CONFLICT", "Your saved answer changed. Reload it first."); },
  });
  for (const path of ["/api/session", "/api/events"]) {
    const response = await fetch(`${base}${path}`, { headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "NOT_IN_ROSTER");
  }
  const response = await fetch(`${base}/api/availability`, { method: "POST", body: "{}", headers: { ...headers, origin: ORIGIN, "content-type": "application/json" } });
  assert.equal(response.status, 409);
  const other = await fixture(t, { loadSession: async () => { throw new Error("secret internal database path"); } });
  const unexpected = await fetch(`${other.base}/api/session`, { headers });
  assert.equal(unexpected.status, 500);
  assert.doesNotMatch(await unexpected.text(), /secret|database/);
});

test("SSE sends initial snapshot and live saved updates without reopening", { timeout: 5_000 }, async t => {
  const { base, headers } = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value!).toString(), /event: session/);
  assert.match(Buffer.from(first.value!).toString(), /"revision":"initial"/);
  await fetch(`${base}/api/availability`, {
    method: "POST", headers: { ...headers, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: "initial", votes: [{ slot: 780, value: "yes" }], filler: false, unavailable: false }),
  });
  const update = await reader.read();
  assert.match(Buffer.from(update.value!).toString(), /"revision":"saved"/);
  await reader.cancel();
});

test("SSE revokes access when the roster changes, emitting safe error then ending", { timeout: 5_000 }, async t => {
  let allowed = true;
  const { base, headers } = await fixture(t, { loadSession: async () => {
    if (!allowed) throw new ApiError(403, "NOT_IN_ROSTER", "Roster access was removed.");
    return snapshot();
  } });
  const response = await fetch(`${base}/api/events`, { headers });
  const reader = response.body!.getReader();
  await reader.read();
  allowed = false;
  assert.match(Buffer.from((await reader.read()).value!).toString(), /event: error\ndata: {"code":"NOT_IN_ROSTER"/);
  assert.equal((await reader.read()).done, true);
});

test("an already-open SSE connection cannot outlive its Telegram authentication", { timeout: 5_000 }, async t => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/events`, { headers: { authorization: authorization({
    auth_date: String(Math.floor(Date.now() / 1_000) - 86_398),
  }) } });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  await reader.read();
  const error = Buffer.from((await reader.read()).value!).toString();
  assert.match(error, /event: error\ndata: {"code":"UNAUTHORIZED"/);
  assert.equal((await reader.read()).done, true);
});

test("closed session is sent once before the stream ends", async t => {
  const closed = snapshot();
  closed.session.closed = true;
  const { base, headers } = await fixture(t, { loadSession: async () => closed });
  const response = await fetch(`${base}/api/events`, { headers });
  const body = await response.text();
  assert.match(body, /event: session/);
  assert.match(body, /"closed":true/);
});

test("gentle authenticated rate limiting rejects a request burst without wildcard CORS", async t => {
  const { base, headers } = await fixture(t);
  for (let i = 0; i < 120; i++) {
    const response = await fetch(`${base}/api/session`, { headers });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const response = await fetch(`${base}/api/session`, { headers });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("per-user SSE connection cap prevents unbounded polling and server.close ends active streams", { timeout: 5_000 }, async t => {
  const { base, headers, server } = await fixture(t);
  const active = [];
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${base}/api/events`, { headers });
    const reader = response.body!.getReader();
    await reader.read();
    active.push(reader);
  }
  const extra = await fetch(`${base}/api/events`, { headers });
  assert.equal(extra.status, 429);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const reader of active) assert.equal((await reader.read()).done, true);
});

test("static paths use an exact allowlist, including raw and encoded traversal attempts", async t => {
  const { base } = await fixture(t);
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  const head = await fetch(`${base}/styles.css`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const path of ["/../package.json", "/%2e%2e/package.json", "/app.js/../../.env", "/%2fetc%2fpasswd", "/constructor", "/.env"]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = get(base, { path }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
    });
    assert.equal(status, 404, path);
  }
});
