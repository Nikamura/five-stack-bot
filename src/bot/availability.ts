import { DateTime } from "luxon";
import * as q from "../db/queries.js";
import type { SessionRow, VoteRow } from "../db/types.js";
import {
  AvailabilityInputError,
  availabilityRevision,
  completeAvailabilityVotes,
  parseAvailabilitySubmission,
  sameAvailabilityAnswer,
} from "../core/availability.js";
import { buildSlots } from "../core/slots.js";
import { tallySlots } from "../core/lock.js";
import { slotInstantMs } from "../core/time.js";
import { ApiError, type MiniAppUser, type SessionSnapshot } from "../web/contracts.js";
import { withMutex } from "./mutex.js";
import { queueSessionEvaluation } from "./session.js";

/** Identity comes from verified initData or a Telegram update, never a request-body ID. */
function requireRosterSession(sessionId: number, user: MiniAppUser): { session: SessionRow; bound: boolean } {
  const session = q.getSession(sessionId);
  if (!session) throw new ApiError(404, "NOT_FOUND", "This availability session was not found.");
  if (!Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new ApiError(403, "FORBIDDEN", "Only this group's roster can open its availability.");
  }
  let bound = false;
  if (user.username) {
    bound = q.rebindSyntheticRosterMember({
      chatId: session.chat_id,
      userId: user.id,
      username: user.username,
      displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username,
    });
  }
  if (!q.getRosterMember(session.chat_id, user.id)) {
    throw new ApiError(403, "FORBIDDEN", "Only this group's roster can open its availability.");
  }
  return { session, bound };
}

function revision(votes: VoteRow[], filler: boolean, skipped: boolean): string {
  return availabilityRevision({
    votes: votes.map((vote) => ({ slot: vote.slot_minutes, value: vote.value, votedAt: vote.voted_at })),
    filler,
    skipped,
  });
}

/** Caller already owns the session mutex; do not call the public getter here. */
function snapshot(session: SessionRow, userId: number, now: number): SessionSnapshot {
  const chat = q.getOrCreateChat(session.chat_id);
  const slots = buildSlots(session.start_minutes, session.end_minutes);
  const slotSet = new Set(slots);
  const roster = q.getRoster(session.chat_id);
  const rosterIds = new Set(roster.map((member) => member.telegram_user_id));
  const votes = q.getSessionVotes(session.id);
  const skips = q.getSkips(session.id);
  const fillers = q.getFillers(session.id);
  const late = q.getLockLate(session.id);
  const tallies = tallySlots({ slots, votes, rosterIds, skipIds: skips, fillerIds: fillers });
  const votesFor = (id: number) => votes.filter((vote) => vote.telegram_user_id === id && slotSet.has(vote.slot_minutes))
    .sort((a, b) => a.slot_minutes - b.slot_minutes)
    .map((vote) => ({ slot: vote.slot_minutes, value: vote.value }));
  const myVotes = votes.filter((vote) => vote.telegram_user_id === userId);
  const lock = q.getLock(session.id);
  const party = q.getLockParty(session.id);
  return {
    session: {
      id: session.id,
      date: DateTime.fromMillis(session.opened_at, { zone: chat.tz }).toISODate()!,
      timezone: chat.tz,
      openerName: session.opener_display_name,
      startMinutes: session.start_minutes,
      endMinutes: session.end_minutes,
      closesAt: session.archive_at,
      closed: session.archived_at !== null || session.archive_at <= now,
      validStacks: q.parseStacks(chat.valid_stacks),
    },
    serverNow: now,
    players: roster.map((member) => {
      const playerVotes = votesFor(member.telegram_user_id);
      return {
        id: member.telegram_user_id,
        displayName: member.display_name,
        username: member.username,
        responded: playerVotes.length > 0 || skips.has(member.telegram_user_id),
        skipped: skips.has(member.telegram_user_id),
        filler: fillers.has(member.telegram_user_id),
        votes: playerVotes,
        lateMinutes: late.get(member.telegram_user_id) ?? 0,
      };
    }),
    slots: tallies.map((tally) => ({
      minutes: tally.slot,
      startsAt: slotInstantMs({ slotMinutes: tally.slot, tz: chat.tz, nowMs: session.opened_at }),
      yes: tally.yes,
      maybe: tally.maybe,
      no: tally.no,
      notVoted: tally.notVoted,
      filler: tally.fillerAvailable,
      yesUserIds: tally.yesUserIds,
      maybeUserIds: tally.maybeUserIds,
      fillerUserIds: tally.fillerAvailableUserIds,
    })),
    me: {
      id: userId,
      revision: revision(myVotes, fillers.has(userId), skips.has(userId)),
      responded: myVotes.length > 0 || skips.has(userId),
      skipped: skips.has(userId),
      filler: fillers.has(userId),
      votes: votesFor(userId),
    },
    lock: lock ? {
      slot: lock.slot_minutes,
      size: lock.size,
      core: party.filter((member) => member.role === "core" && rosterIds.has(member.telegram_user_id))
        .map((member) => member.telegram_user_id),
      alternates: party.filter((member) => member.role === "alternate" && rosterIds.has(member.telegram_user_id))
        .map((member) => member.telegram_user_id),
    } : null,
  };
}

export function getAvailabilitySnapshot(sessionId: number, user: MiniAppUser): Promise<SessionSnapshot> {
  return withMutex(`session:${sessionId}`, async () => {
    const { session, bound } = requireRosterSession(sessionId, user);
    if (bound) queueSessionEvaluation(sessionId);
    return snapshot(session, user.id, Date.now());
  });
}

export function saveAvailability(sessionId: number, user: MiniAppUser, input: unknown): Promise<SessionSnapshot> {
  return changeAvailability(sessionId, user, () => input);
}

/** A group No button is itself an explicit complete answer; no picker is needed. */
export function declineAvailability(sessionId: number, user: MiniAppUser): Promise<SessionSnapshot> {
  return changeAvailability(sessionId, user, () => ({
    expectedRevision: revision(q.getUserVotes(sessionId, user.id), q.isFiller(sessionId, user.id), q.getSkips(sessionId).has(user.id)),
    votes: [], filler: false, unavailable: true,
  }));
}

/** Identity resolution, current-revision reads, and the commit share one mutex. */
function changeAvailability(sessionId: number, user: MiniAppUser, input: () => unknown): Promise<SessionSnapshot> {
  return withMutex(`session:${sessionId}`, async () => {
    const { session, bound } = requireRosterSession(sessionId, user);
    let changed = bound;
    try {
      return commitAvailability(session, user.id, input(), () => { changed = true; });
    } finally {
      // Both binding and voting may change together; evaluate the final state once.
      if (changed) queueSessionEvaluation(sessionId);
    }
  });
}

/** Caller owns the session mutex. This path is shared by the app and group No. */
function commitAvailability(session: SessionRow, userId: number, input: unknown, onChange: () => void): SessionSnapshot {
  const sessionId = session.id;
  const now = Date.now();
  if (session.archived_at !== null || session.archive_at <= now) {
    throw new ApiError(410, "CLOSED", "Voting has ended. Your changes were not saved.");
  }
  const chat = q.getOrCreateChat(session.chat_id);
  const editableSlots = buildSlots(session.start_minutes, session.end_minutes).filter((slot) =>
    slotInstantMs({ slotMinutes: slot, tz: chat.tz, nowMs: session.opened_at }) > now);
  if (editableSlots.length === 0) throw new ApiError(410, "CLOSED", "No future start times remain.");
  let submission;
  try {
    submission = parseAvailabilitySubmission(input, editableSlots);
  } catch (error) {
    if (error instanceof AvailabilityInputError) throw new ApiError(400, "INVALID_INPUT", error.message);
    throw error;
  }
  const currentVotes = q.getUserVotes(sessionId, userId);
  const currentFiller = q.isFiller(sessionId, userId);
  const skipped = q.getSkips(sessionId).has(userId);
  const completeVotes = completeAvailabilityVotes(submission, editableSlots);
  // A timed-out successful Save can safely be retried with its old revision.
  if (sameAvailabilityAnswer({
    currentVotes: currentVotes.map((vote) => ({ slot: vote.slot_minutes, value: vote.value })),
    completeVotes,
    currentFiller,
    filler: submission.filler,
    skipped,
  })) return snapshot(session, userId, now);
  if (submission.expectedRevision !== revision(currentVotes, currentFiller, skipped)) {
    throw new ApiError(409, "CONFLICT", "Your saved availability changed elsewhere. Review it before saving again.");
  }
  q.saveUserAvailability({ sessionId, userId, votes: completeVotes, filler: submission.filler });
  onChange();
  return snapshot(session, userId, now);
}
