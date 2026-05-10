// Short-lived in-memory state for multi-step text flows
// (e.g., "tap [➕ Add player]" then send a username).
//
// Keyed by (chatId, userId). Survives bot uptime, lost on restart — that's
// acceptable for these few-second flows. State-machine interactions that
// need to survive a restart are encoded into inline-keyboard callback_data.

type Pending =
  | { kind: "roster_add" }
  | { kind: "tz_other" };

const map = new Map<string, { value: Pending; expiresAt: number }>();

const TTL_MS = 5 * 60 * 1000;

function key(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function setPending(chatId: number, userId: number, value: Pending): void {
  map.set(key(chatId, userId), { value, expiresAt: Date.now() + TTL_MS });
}

export function takePending(chatId: number, userId: number): Pending | null {
  const k = key(chatId, userId);
  const v = map.get(k);
  if (!v) return null;
  map.delete(k);
  if (v.expiresAt < Date.now()) return null;
  return v.value;
}

export function clearPending(chatId: number, userId: number): void {
  map.delete(key(chatId, userId));
}
