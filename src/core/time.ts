import { DateTime } from "luxon";

/**
 * Compute the unix-ms wall-clock instant for a `slot_minutes` value, on the
 * date "tonight" in the chat's timezone, evaluated against `nowMs`.
 *
 * "Tonight" = today's local date, even if the slot is in the past.
 * (If the user opens a session at 22:00 for 18-23, slots 18:00..21:30
 * are technically past — that's fine, they just won't be useful.)
 */
export function slotInstantMs(args: {
  slotMinutes: number;
  tz: string;
  nowMs: number;
}): number {
  const { slotMinutes, tz, nowMs } = args;
  const local = DateTime.fromMillis(nowMs, { zone: tz }).startOf("day");
  return local.plus({ minutes: slotMinutes }).toMillis();
}

/**
 * archive_at = min(last-slot-start, next-3am-local).
 * Last slot start = endHour*60 - 30 minutes from local midnight.
 * 3 AM = 03:00 the morning after the session date.
 */
export function computeArchiveAt(args: {
  endHour: number;
  tz: string;
  nowMs: number;
}): number {
  const { endHour, tz, nowMs } = args;
  const lastSlotStart = slotInstantMs({
    slotMinutes: endHour * 60 - 30,
    tz,
    nowMs,
  });
  const local = DateTime.fromMillis(nowMs, { zone: tz }).startOf("day");
  const threeAm = local.plus({ days: 1, hours: 3 }).toMillis();
  return Math.min(lastSlotStart, threeAm);
}

export function formatLocalTime(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat("HH:mm");
}

export function isValidIanaZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

export const COMMON_TZS = [
  "Europe/Vilnius",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Helsinki",
  "UTC",
] as const;
