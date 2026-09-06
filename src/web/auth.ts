import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError, type MiniAppUser } from "./contracts.js";

export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const FUTURE_CLOCK_SKEW_SECONDS = 30;

export interface MiniAppIdentity {
  user: MiniAppUser;
  sessionId: number;
  expiresAt: number;
}

function unauthorized(message = "Open availability from the button in your Telegram group."): never {
  throw new ApiError(401, "UNAUTHORIZED", message);
}

function sessionSignature(sessionId: number, botToken: string): Buffer {
  return createHmac("sha256", botToken)
    .update(`five-stack-mini-app-session:v1:${sessionId}`)
    .digest();
}

/** An unguessable session capability, also covered by Telegram's initData HMAC. */
export function createSessionStartParam(sessionId: number, botToken: string): string {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !botToken) {
    throw new Error("A positive session ID and bot token are required.");
  }
  return `s${sessionId}_${sessionSignature(sessionId, botToken).toString("base64url")}`;
}

export function parseSessionStartParam(value: string, botToken: string): number {
  const match = /^s([1-9][0-9]*)_([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match?.[1] || !match[2]) unauthorized();
  const sessionId = Number(match[1]);
  if (!Number.isSafeInteger(sessionId)) unauthorized();
  const supplied = Buffer.from(match[2], "base64url");
  const expected = sessionSignature(sessionId, botToken);
  if (supplied.toString("base64url") !== match[2] || supplied.length !== expected.length
    || !timingSafeEqual(expected, supplied)) unauthorized();
  return sessionId;
}

export function createMiniAppLink(options: {
  botUsername: string;
  sessionId: number;
  botToken: string;
  shortName?: string;
}): string {
  const username = options.botUsername.replace(/^@/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new Error("Invalid bot username.");
  if (options.shortName !== undefined && !/^[A-Za-z0-9_]{1,64}$/.test(options.shortName)) {
    throw new Error("Invalid Mini App short name.");
  }
  const url = new URL(`https://t.me/${username}${options.shortName ? `/${options.shortName}` : ""}`);
  url.searchParams.set("startapp", createSessionStartParam(options.sessionId, options.botToken));
  url.searchParams.set("mode", "compact");
  return url.href;
}

/** Verify only raw initData, never initDataUnsafe or a session ID from a URL/body. */
export function authenticateMiniApp(
  authorization: string | undefined,
  botToken: string,
  now = Date.now(),
): MiniAppIdentity {
  if (!authorization?.startsWith("tma ") || authorization.length > 16_384 || !botToken) unauthorized();
  const raw = authorization.slice(4);
  if (!raw || /%(?![0-9a-f]{2})/i.test(raw)) unauthorized();
  const fields = new URLSearchParams(raw);
  const unique = new Set<string>();
  for (const [key] of fields) {
    if (!/^[a-zA-Z0-9_]+$/.test(key) || unique.has(key)) unauthorized();
    unique.add(key);
  }
  const hash = fields.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) unauthorized();
  fields.delete("hash");
  // Bot-token validation includes signature when present; only hash is excluded.
  fields.sort();
  const checkString = [...fields].map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) unauthorized();

  const date = fields.get("auth_date");
  if (!date || !/^[1-9][0-9]*$/.test(date)) unauthorized();
  const issuedAt = Number(date);
  const nowSeconds = Math.floor(now / 1_000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowSeconds + FUTURE_CLOCK_SKEW_SECONDS) unauthorized();
  const expiresAt = (issuedAt + INIT_DATA_MAX_AGE_SECONDS) * 1_000;
  if (now >= expiresAt) unauthorized("Your Telegram session expired. Close and reopen availability.");

  let value: unknown;
  try { value = JSON.parse(fields.get("user") ?? "null"); } catch { unauthorized(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) unauthorized();
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "number" || !Number.isSafeInteger(candidate.id) || candidate.id <= 0
    || typeof candidate.first_name !== "string" || !candidate.first_name || candidate.first_name.length > 128
    || (candidate.username !== undefined && (typeof candidate.username !== "string" || candidate.username.length > 128))
    || (candidate.last_name !== undefined && (typeof candidate.last_name !== "string" || candidate.last_name.length > 128))) {
    unauthorized();
  }
  const startParam = fields.get("start_param");
  if (!startParam) unauthorized();
  return {
    user: {
      id: candidate.id,
      first_name: candidate.first_name,
      ...(typeof candidate.username === "string" ? { username: candidate.username } : {}),
      ...(typeof candidate.last_name === "string" ? { last_name: candidate.last_name } : {}),
    },
    sessionId: parseSessionStartParam(startParam, botToken),
    expiresAt,
  };
}
