// Slot helpers — sessions are divided into 30-minute candidate start times.

export const SLOT_MIN = 30;

/**
 * Build the slot list for a session, in minutes-from-midnight.
 * Inclusive of `startHour`, exclusive of `endHour`.
 * Hours are in chat-local time. `endHour === 24` means midnight.
 */
export function buildSlots(startHour: number, endHour: number): number[] {
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) {
    throw new Error("Hours must be numeric");
  }
  // Slot grid is 30 minutes, so endpoints must land on :00 or :30.
  if ((startHour * 2) % 1 !== 0 || (endHour * 2) % 1 !== 0) {
    throw new Error("Hours must be on a 30-minute boundary");
  }
  if (startHour < 0 || startHour > 23.5) throw new Error("startHour out of range");
  if (endHour < 0.5 || endHour > 24) throw new Error("endHour out of range");
  if (endHour <= startHour) throw new Error("endHour must be > startHour");
  const start = Math.round(startHour * 60);
  const end = Math.round(endHour * 60);
  const out: number[] = [];
  for (let m = start; m < end; m += SLOT_MIN) out.push(m);
  return out;
}

export function formatSlot(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Parse a single endpoint of a range. Accepted forms:
 *   `HH`         → hour only      (19)
 *   `HH:MM`      → colon notation (19:30, 19:00)
 *   `HHMM`/`HMM` → compact 24h    (1930, 930)
 * Minutes must be `00` or `30` (slot grid is 30 minutes).
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
  return h + min / 60;
}

/**
 * Parse the `<start>-<end>` shortcut. Endpoints accept the forms documented
 * on `parseTimePoint`. Returns null if the input is malformed.
 */
export function parseRangeArg(arg: string): { startHour: number; endHour: number } | null {
  const m = arg.trim().match(/^([\d:]+)\s*-\s*([\d:]+)$/);
  if (!m) return null;
  const startHour = parseTimePoint(m[1]!);
  const endHour = parseTimePoint(m[2]!);
  if (startHour === null || endHour === null) return null;
  if (startHour < 0 || startHour > 23.5) return null;
  if (endHour < 0.5 || endHour > 24) return null;
  if (endHour <= startHour) return null;
  return { startHour, endHour };
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
 *   - exactly one range token like `18-23`
 *   - optional stacks token like `[5,3,2]`
 *   - any number of `@username` tokens (passed through as `rest` for the
 *     caller to extract from message entities)
 */
export function parseLfpArgs(text: string): {
  range: { startHour: number; endHour: number } | null;
  stacks: number[] | null;
  rest: string;
} {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let range: { startHour: number; endHour: number } | null = null;
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
