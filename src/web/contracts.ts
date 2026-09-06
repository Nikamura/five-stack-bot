/** Shared JSON contract for the Telegram Mini App and its same-origin API. */
export type AvailabilityValue = "yes" | "maybe" | "no";
export interface AvailabilityVote { slot: number; value: AvailabilityValue }
export interface SaveAvailabilityInput {
  expectedRevision: string;
  votes: Array<{ slot: number; value: "yes" | "maybe" }>;
  filler: boolean;
  unavailable: boolean;
}
export interface MiniAppUser { id: number; username?: string; first_name: string; last_name?: string }
export interface PlayerAvailability {
  id: number;
  displayName: string;
  username: string | null;
  responded: boolean;
  skipped: boolean;
  filler: boolean;
  votes: AvailabilityVote[];
  lateMinutes: number;
}
export interface SessionSnapshot {
  session: {
    id: number;
    date: string;
    timezone: string;
    openerName: string;
    startMinutes: number;
    endMinutes: number;
    closesAt: number;
    closed: boolean;
    validStacks: number[];
  };
  serverNow: number;
  reminderAvailableAt?: number;
  players: PlayerAvailability[];
  slots: Array<{
    minutes: number;
    startsAt: number;
    yes: number;
    maybe: number;
    no: number;
    notVoted: number;
    filler: number;
    yesUserIds: number[];
    maybeUserIds: number[];
    fillerUserIds: number[];
  }>;
  me: {
    id: number;
    revision: string;
    responded: boolean;
    skipped: boolean;
    filler: boolean;
    votes: AvailabilityVote[];
  };
  parties?: Array<{ slot: number; endSlot: number; size: number; core: number[]; maybeIds: number[]; fillerIds: number[] }>;
  lock: { slot: number; size: number; core: number[]; alternates: number[] } | null;
}
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
