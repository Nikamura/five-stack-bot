import { createHash } from "node:crypto";

export type AvailabilityValue = "yes" | "maybe" | "no";
export interface AvailabilityVote { slot: number; value: AvailabilityValue }
export interface AvailabilitySubmission {
  expectedRevision: string;
  votes: Array<{ slot: number; value: "yes" | "maybe" }>;
  filler: boolean;
  unavailable: boolean;
}

export class AvailabilityInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Validate a complete answer against the start times that are still editable. */
export function parseAvailabilitySubmission(input: unknown, editableSlots: number[]): AvailabilitySubmission {
  const fail = (message: string): never => { throw new AvailabilityInputError(message); };
  if (!isRecord(input) || !hasExactKeys(input, ["expectedRevision", "votes", "filler", "unavailable"])) {
    return fail("Provide expectedRevision, votes, filler, and unavailable only.");
  }
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    return fail("Reload your availability before saving.");
  }
  if (typeof input.filler !== "boolean" || typeof input.unavailable !== "boolean" || !Array.isArray(input.votes)) {
    return fail("Availability must contain a vote list and boolean options.");
  }
  if (input.votes.length > editableSlots.length) return fail("Too many selected start times.");
  const allowed = new Set(editableSlots);
  const seen = new Set<number>();
  const votes: AvailabilitySubmission["votes"] = [];
  for (const vote of input.votes) {
    if (!isRecord(vote) || !hasExactKeys(vote, ["slot", "value"]) ||
      typeof vote.slot !== "number" || !Number.isSafeInteger(vote.slot) || vote.slot % 30 !== 0 ||
      !allowed.has(vote.slot) || (vote.value !== "yes" && vote.value !== "maybe")) {
      return fail("Choose only available future start times with yes or maybe.");
    }
    if (seen.has(vote.slot)) return fail("Each start time can have only one answer.");
    seen.add(vote.slot);
    votes.push({ slot: vote.slot, value: vote.value });
  }
  if (input.unavailable !== (votes.length === 0)) {
    return fail("Choose Can't play explicitly to submit no available times.");
  }
  if (input.unavailable && input.filler) return fail("Can't play cannot also be Only if needed.");
  return {
    expectedRevision: input.expectedRevision,
    votes: votes.sort((a, b) => a.slot - b.slot),
    filler: input.filler,
    unavailable: input.unavailable,
  };
}

/** A Save is a complete answer; untouched editable slots become explicit no. */
export function completeAvailabilityVotes(submission: AvailabilitySubmission, editableSlots: number[]): AvailabilityVote[] {
  const selected = new Map<number, AvailabilityValue>(submission.votes.map((vote) => [vote.slot, vote.value]));
  return editableSlots.map((slot) => ({ slot, value: selected.get(slot) ?? "no" }));
}

/** Stable across other players' activity and the passage of time. */
export function availabilityRevision(args: {
  votes: Array<AvailabilityVote & { votedAt: number }>;
  filler: boolean;
  skipped: boolean;
}): string {
  const votes = [...args.votes].sort((a, b) => a.slot - b.slot).map((vote) => [vote.slot, vote.value, vote.votedAt]);
  return createHash("sha256").update(JSON.stringify([votes, args.filler, args.skipped])).digest("hex");
}

/** Allows a lost-response retry without changing vote priority or re-saving. */
export function sameAvailabilityAnswer(args: {
  currentVotes: AvailabilityVote[];
  completeVotes: AvailabilityVote[];
  currentFiller: boolean;
  filler: boolean;
  skipped: boolean;
}): boolean {
  if (args.skipped || args.currentFiller !== args.filler) return false;
  const current = new Map(args.currentVotes.map((vote) => [vote.slot, vote.value]));
  return args.completeVotes.every((vote) => current.get(vote.slot) === vote.value);
}
