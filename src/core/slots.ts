// Slot helpers — sessions are divided into 30-minute candidate start times.
// Session ranges are stored as minutes-from-midnight in chat-local time, on a
// 30-minute grid. `endMinutes` is exclusive; `1440` means midnight.

export const SLOT_MIN = 30;
export const DAY_MIN = 1440;

/**
 * Build the slot list for a session, in minutes-from-midnight.
 * Inclusive of `startMinutes`, exclusive of `endMinutes`.
 * Both bounds must be on the 30-minute grid; `endMinutes === 1440` means midnight.
 */
export function buildSlots(startMinutes: number, endMinutes: number): number[] {
  if (!Number.isInteger(startMinutes) || !Number.isInteger(endMinutes)) {
    throw new Error("Minutes must be integers");
  }
  if (startMinutes % SLOT_MIN !== 0 || endMinutes % SLOT_MIN !== 0) {
    throw new Error("Minutes must be on the 30-minute grid");
  }
  if (startMinutes < 0 || startMinutes >= DAY_MIN) throw new Error("startMinutes out of range");
  if (endMinutes < SLOT_MIN || endMinutes > DAY_MIN) throw new Error("endMinutes out of range");
  if (endMinutes <= startMinutes) throw new Error("endMinutes must be > startMinutes");
  const out: number[] = [];
  for (let m = startMinutes; m < endMinutes; m += SLOT_MIN) out.push(m);
  return out;
}

export function formatSlot(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Parse a single endpoint of a range to minutes-from-midnight. Accepted forms:
 *   `HH`         → hour only      (`19`   → 19:00)
 *   `HH:MM`      → colon notation (`19:30`, `19:00`)
 *   `HHMM`/`HMM` → compact 24h    (`1930`, `930`)
 * Minutes must land on the 30-minute grid (`:00` or `:30`).
 */
function parseTimePoint(s: string): number | null {
  let h: number;
  let min: number;
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    h = parseInt(m[1]!, 10);
    min = parseInt(m[2]!, 10);
  } else if ((m = s.match(/^(\d{3,4})$/))) {
    const digits = m[1]!;
    h = parseInt(digits.slice(0, digits.length - 2), 10);
    min = parseInt(digits.slice(-2), 10);
  } else if ((m = s.match(/^(\d{1,2})$/))) {
    h = parseInt(m[1]!, 10);
    min = 0;
  } else {
    return null;
  }
  if (min !== 0 && min !== 30) return null;
  return h * 60 + min;
}

/**
 * Parse the `<start>-<end>` shortcut. Endpoints accept the forms documented on
 * `parseTimePoint` (e.g. `18-23`, `18:30-23:00`, `1830-2300`). End == 24 /
 * `24:00` / `2400` means midnight. Returns null if the input is malformed.
 */
export function parseRangeArg(arg: string): { startMinutes: number; endMinutes: number } | null {
  const m = arg.trim().match(/^([\d:]+)\s*-\s*([\d:]+)$/);
  if (!m) return null;
  const startMinutes = parseTimePoint(m[1]!);
  const endMinutes = parseTimePoint(m[2]!);
  if (startMinutes === null || endMinutes === null) return null;
  if (startMinutes < 0 || startMinutes >= DAY_MIN) return null;
  if (endMinutes < SLOT_MIN || endMinutes > DAY_MIN) return null;
  if (endMinutes <= startMinutes) return null;
  return { startMinutes, endMinutes };
}

/**
 * Compress a list of 30-minute slot starts into a comma-separated list of
 * runs, expressed in HH:MM-HH:MM form where the upper bound is the *end*
 * of the last slot in the run (so `[1080, 1110]` → `"18:00-19:00"`,
 * not `"18:00-18:30"`).
 *
 * Single-slot runs render as `HH:MM-HH:MM` too (start of slot to end of
 * slot, e.g. `[1080]` → `"18:00-18:30"`) — keeps the convention uniform.
 */
export function compressSlotRanges(slots: number[]): string {
  if (slots.length === 0) return "";
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (cur === prev + SLOT_MIN) {
      prev = cur;
    } else {
      ranges.push({ start, end: prev });
      start = cur;
      prev = cur;
    }
  }
  ranges.push({ start, end: prev });
  return ranges
    .map((r) => `${formatSlot(r.start)}-${formatSlot(r.end + SLOT_MIN)}`)
    .join(", ");
}

/**
 * Parse a bracketed stack list like `[5,3,2]`.
 * Returns null if the token isn't a stacks expression.
 */
export function parseStacksArg(token: string): number[] | null {
  const m = token.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
  if (!m) return null;
  const nums = m[1]!
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  return [...new Set(nums)].sort((a, b) => b - a);
}

/**
 * Parse the full /lfp shortcut argument string.
 * Tokens may appear in any order:
 *   - exactly one range token like `18-23`, `18:30-23:00`, or `1830-2300`
 *   - optional stacks token like `[5,3,2]`
 *   - any number of `@username` tokens (passed through as `rest` for the
 *     caller to extract from message entities)
 */
export function parseLfpArgs(text: string): {
  range: { startMinutes: number; endMinutes: number } | null;
  stacks: number[] | null;
  rest: string;
} {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let range: { startMinutes: number; endMinutes: number } | null = null;
  let stacks: number[] | null = null;
  const remaining: string[] = [];
  for (const tok of tokens) {
    if (!range) {
      const r = parseRangeArg(tok);
      if (r) {
        range = r;
        continue;
      }
    }
    if (!stacks) {
      const s = parseStacksArg(tok);
      if (s) {
        stacks = s;
        continue;
      }
    }
    remaining.push(tok);
  }
  return { range, stacks, rest: remaining.join(" ") };
}
