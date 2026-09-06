import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  authenticateMiniApp,
  createMiniAppLink,
  createSessionStartParam,
  INIT_DATA_MAX_AGE_SECONDS,
  parseSessionStartParam,
} from "./auth.js";
import { ApiError } from "./contracts.js";

const TOKEN = "123456789:test-token-only";
const NOW = 1_800_000_000_000;

function signed(fields: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    auth_date: String(NOW / 1_000),
    user: JSON.stringify({ id: 12345, first_name: "Karolis", username: "karolis" }),
    start_param: createSessionStartParam(42, TOKEN),
    ...fields,
  });
  params.sort();
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret)
    .update([...params].map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex"));
  return `tma ${params}`;
}

function rejects(authorization: string | undefined, now = NOW): void {
  assert.throws(() => authenticateMiniApp(authorization, TOKEN, now),
    (error: unknown) => error instanceof ApiError && error.status === 401);
}

test("valid Telegram HMAC authenticates user and signed session with 24-hour expiry", () => {
  assert.deepEqual(authenticateMiniApp(signed(), TOKEN, NOW), {
    user: { id: 12345, first_name: "Karolis", username: "karolis" },
    sessionId: 42,
    expiresAt: NOW + INIT_DATA_MAX_AGE_SECONDS * 1_000,
  });
});

test("new Telegram signature field is covered by bot-token HMAC", () => {
  assert.equal(authenticateMiniApp(signed({ signature: "telegram-signature" }), TOKEN, NOW).sessionId, 42);
  rejects(signed({ signature: "telegram-signature" }).replace("telegram-signature", "edited-signature"));
});

test("missing, forged and malformed Telegram credentials are rejected", () => {
  for (const value of [undefined, "", "Bearer anything", "tma user={}", signed().replace("Karolis", "Attacker"),
    signed().replace(/hash=[a-f0-9]{64}/, "hash=00"), `${signed()}&user=%`, `tma ${"x".repeat(16_384)}`]) {
    rejects(value);
  }
});

test("duplicate initData fields cannot create parser discrepancies", () => {
  rejects(`${signed()}&user=${encodeURIComponent(JSON.stringify({ id: 888, first_name: "Other" }))}`);
  rejects(`${signed()}&hash=${"a".repeat(64)}`);
  rejects(`${signed()}&auth_date=1800000000`);
});

test("old or future-dated initData expires with limited clock tolerance", () => {
  rejects(signed(), NOW + INIT_DATA_MAX_AGE_SECONDS * 1_000);
  rejects(signed({ auth_date: String(NOW / 1_000 + 31) }));
  rejects(signed({ auth_date: "not-a-date" }));
  rejects(signed({ auth_date: "1800000000.1" }));
  assert.equal(authenticateMiniApp(signed({ auth_date: String(NOW / 1_000 + 30) }), TOKEN, NOW).sessionId, 42);
});

test("signed user must contain a safe positive numeric ID and bounded names", () => {
  for (const user of [null, [], {}, { id: "12345", first_name: "A" }, { id: -1, first_name: "A" },
    { id: Number.MAX_SAFE_INTEGER + 1, first_name: "A" }, { id: 1.1, first_name: "A" },
    { id: 1, first_name: [] }, { id: 1, first_name: "A", username: {} },
    { id: 1, first_name: "x".repeat(129) }]) {
    rejects(signed({ user: JSON.stringify(user) }));
  }
  rejects(signed({ user: "{" }));
});

test("session token cannot be guessed, moved to a different bot or tampered", () => {
  const value = createSessionStartParam(42, TOKEN);
  assert.equal(parseSessionStartParam(value, TOKEN), 42);
  assert.throws(() => parseSessionStartParam(value, "different-bot-token"), ApiError);
  rejects(signed({ start_param: value.replace("s42_", "s43_") }));
  rejects(signed({ start_param: "42" }));
  rejects(signed({ start_param: "" }));
  assert.throws(() => createSessionStartParam(0, TOKEN));
  assert.throws(() => createSessionStartParam(Number.MAX_SAFE_INTEGER + 1, TOKEN));
});

test("group Mini App links use compact direct links with signed startapp", () => {
  const main = new URL(createMiniAppLink({ botUsername: "@FiveStackBot", sessionId: 42, botToken: TOKEN }));
  assert.equal(main.origin, "https://t.me");
  assert.equal(main.pathname, "/FiveStackBot");
  assert.equal(main.searchParams.get("mode"), "compact");
  assert.equal(parseSessionStartParam(main.searchParams.get("startapp")!, TOKEN), 42);
  const named = new URL(createMiniAppLink({ botUsername: "FiveStackBot", sessionId: 42, botToken: TOKEN, shortName: "availability" }));
  assert.equal(named.pathname, "/FiveStackBot/availability");
  assert.throws(() => createMiniAppLink({ botUsername: "bad/path", sessionId: 42, botToken: TOKEN }));
  assert.throws(() => createMiniAppLink({ botUsername: "FiveStackBot", sessionId: 42, botToken: TOKEN, shortName: "../bad" }));
});
