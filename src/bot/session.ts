import { GrammyError } from "grammy";
import { bot } from "./instance.js";
import { withMutex } from "./mutex.js";
import * as q from "../db/queries.js";
import type { LockResult, SlotTally } from "../core/lock.js";
import { diffLock, evaluateLock, nextVote, tallySlots } from "../core/lock.js";
import { buildSlots } from "../core/slots.js";
import {
  renderGameOn,
  renderGameOnKeyboard,
  renderLoadUp,
  renderPartyChanged,
  renderPartyDissolved,
  renderSessionBody,
  renderSessionKeyboard,
  renderT15,
} from "../core/render.js";
import { mentionByIds } from "../core/mention.js";
import { computeArchiveAt, slotInstantMs } from "../core/time.js";
import { log } from "../log.js";
import { scheduleArchive, scheduleT15, cancelT15 } from "../scheduler/jobs.js";
import type { RosterMember, SessionRow } from "../db/types.js";

/**
 * Open a new session in `chatId`. Sends the session message, persists everything,
 * and schedules the auto-archive. Returns the session id, or null if a session is
 * already active.
 */
export async function openSession(args: {
  chatId: number;
  openerUserId: number;
  openerUsername: string | null;
  openerDisplayName: string;
  startMinutes: number;
  endMinutes: number;
}): Promise<number | { existingId: number }> {
  q.getOrCreateChat(args.chatId);
  const existing = q.getActiveSession(args.chatId);
  if (existing) return { existingId: existing.id };

  // Auto-add the opener to the roster. Common case: the person who runs
  // /lfp is one of the players. If they aren't actually playing tonight,
  // a single ❌ vote (or /lfp_remove) takes them out of the calculus.
  q.addRosterMember(
    args.chatId,
    args.openerUserId,
    args.openerUsername,
    args.openerDisplayName,
  );

  const chat = q.getOrCreateChat(args.chatId);
  const archiveAt = computeArchiveAt({
    endMinutes: args.endMinutes,
    tz: chat.tz,
    nowMs: Date.now(),
  });

  const sessionId = q.createSession({
    chatId: args.chatId,
    openerUserId: args.openerUserId,
    openerDisplayName: args.openerDisplayName,
    startMinutes: args.startMinutes,
    endMinutes: args.endMinutes,
    archiveAt,
  });

  // Pre-vote the opener as ✅ on every slot. They opened the session, so the
  // assumption is that they're available — if not, they tap the slots they
  // can't make.
  const slots = buildSlots(args.startMinutes, args.endMinutes);
  for (const slot of slots) {
    q.setVote(sessionId, args.openerUserId, slot, "yes");
  }

  // Render and send the session message.
  const session = q.getSession(sessionId)!;
  const { body, keyboard } = renderSessionMessage(session);
  const sent = await bot.api.sendMessage(args.chatId, body, {
    parse_mode: "HTML",
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
  q.setSessionPollMessage(sessionId, sent.message_id);
  await tryPin(args.chatId, sent.message_id);

  // Schedule auto-archive.
  await scheduleArchive(sessionId, archiveAt);

  return sessionId;
}

// ----------------------------------------------------------------------------
// Debounced poll-message edits. Vote bursts coalesce into one edit per ~1s
// per session, keeping us under Telegram's "edit a message at most once per
// second" limit for inline-keyboard-bearing messages.
// ----------------------------------------------------------------------------

const EDIT_DEBOUNCE_MS = 1100;
const pendingEditTimers = new Map<number, NodeJS.Timeout>();

function schedulePollEdit(sessionId: number): void {
  const existing = pendingEditTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingEditTimers.delete(sessionId);
    void flushPollEdit(sessionId);
  }, EDIT_DEBOUNCE_MS);
  t.unref?.();
  pendingEditTimers.set(sessionId, t);
}

function cancelPendingPollEdit(sessionId: number): void {
  const t = pendingEditTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    pendingEditTimers.delete(sessionId);
  }
}

async function flushPollEdit(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null || !session.poll_message_id) return;
    const { body, keyboard } = renderSessionMessage(session);
    await safeEditMessage({
      chatId: session.chat_id,
      messageId: session.poll_message_id,
      text: body,
      keyboard,
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort pin. No-op if the bot lacks the Pin Messages admin right. */
async function tryPin(chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.pinChatMessage(chatId, messageId, {
      disable_notification: true,
    });
  } catch (err) {
    if (err instanceof GrammyError) return;
    log.warn("pin failed", err);
  }
}

/** Best-effort unpin. Silent on missing rights or already-unpinned. */
async function tryUnpin(chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.unpinChatMessage(chatId, messageId);
  } catch (err) {
    if (err instanceof GrammyError) return;
    log.warn("unpin failed", err);
  }
}

/**
 * Apply a vote, then re-evaluate. The voter is identified by `userId`.
 * Tapping cycles: yes → maybe → no → cleared → yes.
 * Non-roster votes are accepted (they show up in the spectators line) but
 * never affect the lock.
 */
export async function recordVote(args: {
  sessionId: number;
  userId: number;
  username: string | null;
  displayName: string;
  slot: number;
}): Promise<{ newValue: "yes" | "maybe" | "no"; isRoster: boolean }> {
  return withMutex(`session:${args.sessionId}`, async () => {
    const session = q.getSession(args.sessionId);
    if (!session || session.archived_at !== null) {
      throw new SessionGone();
    }
    const current = q.getVote(args.sessionId, args.userId, args.slot);
    const next = nextVote(current?.value ?? null);
    q.setVote(args.sessionId, args.userId, args.slot, next);
    const rosterIds = q.getRosterIds(session.chat_id);
    const isRoster = rosterIds.has(args.userId);
    await evaluateAndApply(session);
    return { newValue: next, isRoster };
  });
}

/**
 * Combo vote: toggle a pair of adjacent 30-min slots in the same hour as a
 * single unit. Cycles ✅ → 🤷 → ❌ → ✅ off the *earlier* slot's current
 * value, then applies that next value to both slots so they always end up
 * in sync after a combo tap.
 */
export async function recordComboVote(args: {
  sessionId: number;
  userId: number;
  username: string | null;
  displayName: string;
  slot: number;
}): Promise<{ newValue: "yes" | "maybe" | "no"; isRoster: boolean }> {
  return withMutex(`session:${args.sessionId}`, async () => {
    const session = q.getSession(args.sessionId);
    if (!session || session.archived_at !== null) {
      throw new SessionGone();
    }
    const current = q.getVote(args.sessionId, args.userId, args.slot);
    const next = nextVote(current?.value ?? null);
    q.setVote(args.sessionId, args.userId, args.slot, next);
    q.setVote(args.sessionId, args.userId, args.slot + 30, next);
    const rosterIds = q.getRosterIds(session.chat_id);
    const isRoster = rosterIds.has(args.userId);
    await evaluateAndApply(session);
    return { newValue: next, isRoster };
  });
}

export async function bulkNoTonight(args: {
  sessionId: number;
  userId: number;
}): Promise<void> {
  await withMutex(`session:${args.sessionId}`, async () => {
    const session = q.getSession(args.sessionId);
    if (!session || session.archived_at !== null) throw new SessionGone();
    const slots = buildSlots(session.start_minutes, session.end_minutes);
    q.bulkNoForUser(args.sessionId, args.userId, slots);
    await evaluateAndApply(session);
  });
}

/**
 * Toggle "all times work" for a user. If every slot is already ✅, clears
 * the user's votes back to neutral; otherwise sets every slot to ✅.
 * Returns the resulting state for the optimistic toast.
 */
export async function bulkYesToggleTonight(args: {
  sessionId: number;
  userId: number;
}): Promise<"yes-all" | "cleared"> {
  return withMutex(`session:${args.sessionId}`, async () => {
    const session = q.getSession(args.sessionId);
    if (!session || session.archived_at !== null) throw new SessionGone();
    const slots = buildSlots(session.start_minutes, session.end_minutes);
    const existing = q.getUserVotes(args.sessionId, args.userId);
    const allYes =
      existing.length === slots.length &&
      existing.every((v) => v.value === "yes");
    let result: "yes-all" | "cleared";
    if (allYes) {
      q.clearVotesForUser(args.sessionId, args.userId);
      result = "cleared";
    } else {
      q.bulkYesForUser(args.sessionId, args.userId, slots);
      result = "yes-all";
    }
    await evaluateAndApply(session);
    return result;
  });
}

export async function markSkip(args: {
  sessionId: number;
  userId: number;
}): Promise<void> {
  await withMutex(`session:${args.sessionId}`, async () => {
    const session = q.getSession(args.sessionId);
    if (!session || session.archived_at !== null) throw new SessionGone();
    q.addSkip(args.sessionId, args.userId);
    await evaluateAndApply(session);
  });
}

/**
 * Toggle "I can fill if needed" for `userId` on this session. Returns the
 * resulting state so the callback can show an accurate toast.
 *
 * Filler users' ✅/🤷 votes are pooled into `fillerAvailable` — they only
 * fill the stack when non-filler ✅ alone falls short, and they get bumped
 * back to alternate the moment a real ✅ would replace them.
 */
export async function toggleFiller(args: {
  sessionId: number;
  userId: number;
}): Promise<"on" | "off"> {
  return withMutex(`session:${args.sessionId}`, async () => {
    const session = q.getSession(args.sessionId);
    if (!session || session.archived_at !== null) throw new SessionGone();
    let next: "on" | "off";
    if (q.isFiller(args.sessionId, args.userId)) {
      q.removeFiller(args.sessionId, args.userId);
      next = "off";
    } else {
      q.addFiller(args.sessionId, args.userId);
      next = "on";
    }
    await evaluateAndApply(session);
    return next;
  });
}

/**
 * Re-render and re-evaluate the active session for a chat. Use after any
 * mutation that affects the session view (roster add/remove, /lfp_stacks
 * change, etc.). No-op if no active session.
 */
export async function refreshActiveSession(chatId: number): Promise<void> {
  const session = q.getActiveSession(chatId);
  if (!session) return;
  await withMutex(`session:${session.id}`, async () => {
    await evaluateAndApply(session);
  });
}

/**
 * Re-post the active session as a fresh message at the bottom of the chat
 * and tombstone the old message. Solves "the poll scrolled up forever".
 *
 * The new message becomes the canonical poll_message_id; the old message
 * stops receiving body edits but its buttons keep working (a callback
 * handler routes to the session by id, not by message id).
 */
export async function bumpSessionPoll(chatId: number): Promise<boolean> {
  const session = q.getActiveSession(chatId);
  if (!session) return false;
  return withMutex(`session:${session.id}`, async () => {
    const fresh = q.getSession(session.id);
    if (!fresh || fresh.archived_at !== null) return false;
    cancelPendingPollEdit(fresh.id);
    const { body, keyboard } = renderSessionMessage(fresh);
    const sent = await bot.api.sendMessage(fresh.chat_id, body, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    const oldId = fresh.poll_message_id;
    q.setSessionPollMessage(fresh.id, sent.message_id);
    if (oldId && oldId !== sent.message_id) {
      try {
        await bot.api.editMessageText(
          fresh.chat_id,
          oldId,
          "↓ <i>Session moved to a fresh message — vote below.</i>",
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
        );
      } catch {
        /* old message may be gone or unmodifiable; ignore */
      }
      await tryUnpin(fresh.chat_id, oldId);
    }
    await tryPin(fresh.chat_id, sent.message_id);
    return true;
  });
}

export async function cancelSession(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null) return;
    q.archiveSession(sessionId);
    q.deleteJobsForSession(sessionId);
    cancelT15(sessionId);
    cancelPendingPollEdit(sessionId);
    if (session.poll_message_id) {
      await safeEditMessage({
        chatId: session.chat_id,
        messageId: session.poll_message_id,
        text: "❌ Session cancelled.",
      });
      await tryUnpin(session.chat_id, session.poll_message_id);
    }
  });
}

export async function archiveSessionFromScheduler(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null) return;
    q.archiveSession(sessionId);
    q.deleteJobsForSession(sessionId);
    cancelPendingPollEdit(sessionId);
    if (session.poll_message_id) {
      const lock = q.getLock(sessionId);
      const tail = lock
        ? `\n\n— archived. Final lock: ${lock.size}-stack at ${formatSlotMm(lock.slot_minutes)}.`
        : "\n\n— archived. No party formed.";
      const { body } = renderSessionMessage(session, { archivedSuffix: tail });
      await safeEditMessage({
        chatId: session.chat_id,
        messageId: session.poll_message_id,
        text: body,
        clearKeyboard: true,
        suppressKeyboard: true,
      });
      await tryUnpin(session.chat_id, session.poll_message_id);
    }
  });
}

// --- Internal: full re-render + lock evaluation -----------------------------

interface RenderedMessage {
  body: string;
  keyboard: ReturnType<typeof renderSessionKeyboard>;
}

function renderSessionMessage(
  session: SessionRow,
  opts?: { archivedSuffix?: string },
): RenderedMessage {
  const slots = buildSlots(session.start_minutes, session.end_minutes);
  const roster = q.getRoster(session.chat_id);
  const rosterIds = new Set(roster.map((r) => r.telegram_user_id));
  const skipIds = q.getSkips(session.id);
  const fillerIds = q.getFillers(session.id);
  const votes = q.getSessionVotes(session.id);
  const tallies = tallySlots({ slots, votes, rosterIds, skipIds, fillerIds });
  const lock = currentLock(session.id);
  const chat = q.getOrCreateChat(session.chat_id);
  const validStacks = q.parseStacks(chat.valid_stacks);

  const spectatorIds = new Set<number>();
  for (const v of votes) {
    if (v.value === "yes" && !rosterIds.has(v.telegram_user_id)) {
      spectatorIds.add(v.telegram_user_id);
    }
  }

  let body = renderSessionBody({
    session,
    roster,
    tallies,
    lock,
    validStacks,
    skipIds,
    fillerIds,
    totalSlots: slots.length,
    spectatorCount: spectatorIds.size,
  });
  if (opts?.archivedSuffix) body += opts.archivedSuffix;
  // Hide buttons for slots whose start time has already passed. Tallies and
  // history stay visible in the body; we just stop accepting fresh votes on
  // slots that nobody can actually start anymore.
  const futureSlots = slots.filter(
    (s) =>
      slotInstantMs({
        slotMinutes: s,
        tz: chat.tz,
        nowMs: session.opened_at,
      }) > Date.now(),
  );
  const keyboard = renderSessionKeyboard({
    sessionId: session.id,
    slots: futureSlots,
  });
  return { body, keyboard };
}

function currentLock(sessionId: number): LockResult | null {
  const lockRow = q.getLock(sessionId);
  if (!lockRow) return null;
  const party = q.getLockParty(sessionId);
  return {
    slot: lockRow.slot_minutes,
    size: lockRow.size,
    core: party.filter((p) => p.role === "core").map((p) => p.telegram_user_id),
    alternates: party
      .filter((p) => p.role === "alternate")
      .map((p) => p.telegram_user_id),
  };
}

async function evaluateAndApply(session: SessionRow): Promise<void> {
  const chat = q.getOrCreateChat(session.chat_id);
  const slots = buildSlots(session.start_minutes, session.end_minutes);
  const roster = q.getRoster(session.chat_id);
  const rosterIds = new Set(roster.map((r) => r.telegram_user_id));
  const skipIds = q.getSkips(session.id);
  const fillerIds = q.getFillers(session.id);
  const votes = q.getSessionVotes(session.id);
  const tallies = tallySlots({ slots, votes, rosterIds, skipIds, fillerIds });
  const validStacks = q.parseStacks(chat.valid_stacks);
  const next = evaluateLock({ tallies, validStacks });
  const prev = currentLock(session.id);
  const diff = diffLock(prev, next);
  const availableAtSlot =
    next.slot !== null ? availableAtSlotFromTallies(tallies, next.slot) : 0;

  // Persist new lock state.
  if (
    diff.kind === "new" ||
    diff.kind === "changed" ||
    diff.kind === "alternates-changed"
  ) {
    q.writeLock({
      sessionId: session.id,
      slot: next.slot!,
      size: next.size!,
      core: next.core,
      alternates: next.alternates,
    });
    // Lineup or slot changed — late flags belong to the old party and don't
    // carry over. A "new" diff with no prior late state is also a safe clear.
    // An alternates-only change keeps the same core, so late flags stay.
    if (diff.kind === "changed") q.clearLockLate(session.id);
  } else if (diff.kind === "dissolved") {
    q.clearLock(session.id);
    q.clearLockLate(session.id);
  }

  // Re-render the poll message — debounced. A burst of votes coalesces
  // into a single edit ~1s later; immediate edits would trip Telegram's
  // per-message rate limit (1 edit/sec).
  if (session.poll_message_id) {
    schedulePollEdit(session.id);
  }

  // Side effects per diff.
  if (diff.kind === "new") {
    await postGameOn({ session, lock: next, roster, availableAtSlot });
    await scheduleT15ForLock({ session, lock: next, tz: chat.tz });
  } else if (diff.kind === "changed") {
    await editGameOn({ session, lock: next, roster, availableAtSlot });
    await postChangedFollowup({ session, prev: diff.prev, next, roster });
    cancelT15(session.id);
    q.deleteJobsForSession(session.id, "t15");
    await scheduleT15ForLock({ session, lock: next, tz: chat.tz });
  } else if (diff.kind === "alternates-changed") {
    // Core lineup unchanged — refresh GAME ON in place so the alternates
    // list and the "X players available" suggestion stay current, but
    // skip the `🔄 Party changed` follow-up and the T-15 reschedule
    // since the playing party hasn't moved.
    await editGameOn({ session, lock: next, roster, availableAtSlot });
  } else if (diff.kind === "dissolved") {
    await editGameOnDissolved({ session });
    cancelT15(session.id);
    q.deleteJobsForSession(session.id, "t15");
  }
}

function availableAtSlotFromTallies(tallies: SlotTally[], slot: number): number {
  const t = tallies.find((x) => x.slot === slot);
  if (!t) return 0;
  return t.yes + t.maybe + t.fillerAvailable;
}

async function postGameOn(args: {
  session: SessionRow;
  lock: LockResult;
  roster: RosterMember[];
  availableAtSlot: number;
}): Promise<void> {
  const lateByUserId = q.getLockLate(args.session.id);
  const text = renderGameOn({
    slot: args.lock.slot!,
    size: args.lock.size!,
    coreIds: args.lock.core,
    alternateIds: args.lock.alternates,
    roster: args.roster,
    lateByUserId,
    availableAtSlot: args.availableAtSlot,
  });
  const sent = await bot.api.sendMessage(args.session.chat_id, text, {
    parse_mode: "HTML",
    reply_markup: renderGameOnKeyboard(args.session.id),
    link_preview_options: { is_disabled: true },
  });
  q.setSessionGameOnMessage(args.session.id, sent.message_id);
}

async function editGameOn(args: {
  session: SessionRow;
  lock: LockResult;
  roster: RosterMember[];
  availableAtSlot: number;
}): Promise<void> {
  if (!args.session.game_on_message_id) {
    await postGameOn(args);
    return;
  }
  const lateByUserId = q.getLockLate(args.session.id);
  const text = renderGameOn({
    slot: args.lock.slot!,
    size: args.lock.size!,
    coreIds: args.lock.core,
    alternateIds: args.lock.alternates,
    roster: args.roster,
    lateByUserId,
    availableAtSlot: args.availableAtSlot,
  });
  await safeEditMessage({
    chatId: args.session.chat_id,
    messageId: args.session.game_on_message_id,
    text,
    gameOnKeyboard: renderGameOnKeyboard(args.session.id),
  });
}

/**
 * Re-edit every active session's poll and GAME ON message using the current
 * render code. Used on boot so deployed message-text changes propagate without
 * waiting for the next vote or a manual /lfp_bump.
 */
export async function refreshAllActiveSessions(): Promise<void> {
  const sessions = q.listActiveSessions();
  log.info(`Refreshing ${sessions.length} active session message(s) on boot.`);
  for (const session of sessions) {
    try {
      cancelPendingPollEdit(session.id);
      await flushPollEdit(session.id);
      await refreshGameOnMessage(session.id);
    } catch (err) {
      log.warn(`Boot refresh failed for session ${session.id}`, err);
    }
  }
}

/**
 * Re-render the GAME ON message in place — used by the "I'll be late" toggle
 * which mutates lateness but not lock state. No lock evaluation, no debounce.
 */
export async function refreshGameOnMessage(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null) return;
    if (!session.game_on_message_id) return;
    const lock = currentLock(sessionId);
    if (!lock || lock.slot === null) return;
    const roster = q.getRoster(session.chat_id);
    const lateByUserId = q.getLockLate(sessionId);
    const slots = buildSlots(session.start_minutes, session.end_minutes);
    const rosterIds = new Set(roster.map((r) => r.telegram_user_id));
    const skipIds = q.getSkips(sessionId);
    const fillerIds = q.getFillers(sessionId);
    const votes = q.getSessionVotes(sessionId);
    const tallies = tallySlots({ slots, votes, rosterIds, skipIds, fillerIds });
    const availableAtSlot = availableAtSlotFromTallies(tallies, lock.slot);
    const text = renderGameOn({
      slot: lock.slot,
      size: lock.size!,
      coreIds: lock.core,
      alternateIds: lock.alternates,
      roster,
      lateByUserId,
      availableAtSlot,
    });
    await safeEditMessage({
      chatId: session.chat_id,
      messageId: session.game_on_message_id,
      text,
      gameOnKeyboard: renderGameOnKeyboard(sessionId),
    });
  });
}

async function postChangedFollowup(args: {
  session: SessionRow;
  prev: LockResult;
  next: LockResult;
  roster: RosterMember[];
}): Promise<void> {
  const prevCoreSet = new Set(args.prev.core);
  const nextCoreSet = new Set(args.next.core);
  const dropped = args.prev.core.filter((u) => !nextCoreSet.has(u));
  const added = args.next.core.filter((u) => !prevCoreSet.has(u));
  const parts: string[] = [];
  if (dropped.length) parts.push(`${mentionByIds(args.roster, dropped)} dropped`);
  if (added.length) parts.push(`${mentionByIds(args.roster, added)} promoted`);
  if (args.prev.size !== args.next.size) {
    parts.push(`${args.prev.size}-stack → ${args.next.size}-stack`);
  }
  if (args.prev.slot !== args.next.slot) {
    parts.push(`${formatSlotMm(args.prev.slot!)} → ${formatSlotMm(args.next.slot!)}`);
  }
  const headline = parts.join(" · ") || "lineup updated";
  const stillCore = mentionByIds(args.roster, args.next.core);
  const text = renderPartyChanged(
    `${headline}.\n🔒 Still GAME ON ${formatSlotMm(args.next.slot!)} — ${args.next.size}-stack: ${stillCore}`,
  );
  await bot.api.sendMessage(args.session.chat_id, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function editGameOnDissolved(args: { session: SessionRow }): Promise<void> {
  if (!args.session.game_on_message_id) return;
  await safeEditMessage({
    chatId: args.session.chat_id,
    messageId: args.session.game_on_message_id,
    text: renderPartyDissolved(),
  });
  q.setSessionGameOnMessage(args.session.id, null);
}

async function scheduleT15ForLock(args: {
  session: SessionRow;
  lock: LockResult;
  tz: string;
}): Promise<void> {
  const fireAt =
    slotInstantMs({ slotMinutes: args.lock.slot!, tz: args.tz, nowMs: Date.now() }) -
    15 * 60 * 1000;
  if (fireAt <= Date.now() + 5_000) {
    // Past or imminent — fire immediately.
    await fireT15Now(args.session, args.lock);
    return;
  }
  await scheduleT15(args.session.id, fireAt);
}

/** Threshold below which "15 min — boot up" feels wrong and we use "load up". */
const LOAD_UP_THRESHOLD_MS = 10 * 60 * 1000;

async function fireT15Now(
  session: SessionRow,
  lock: LockResult,
): Promise<void> {
  const chat = q.getOrCreateChat(session.chat_id);
  const slotMs = slotInstantMs({
    slotMinutes: lock.slot!,
    tz: chat.tz,
    nowMs: Date.now(),
  });
  const remainingMs = slotMs - Date.now();
  const roster = q.getRoster(session.chat_id);
  const core = mentionByIds(roster, lock.core);
  const text =
    remainingMs >= LOAD_UP_THRESHOLD_MS ? renderT15(core) : renderLoadUp(core);
  await bot.api.sendMessage(session.chat_id, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// Used by scheduler:
export async function fireT15(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null) return;
    const lock = currentLock(sessionId);
    if (!lock || lock.slot === null) return;
    await fireT15Now(session, lock);
  });
}

// ----------------------------------------------------------------------------

function formatSlotMm(slotMinutes: number): string {
  const h = Math.floor(slotMinutes / 60);
  const m = slotMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

class SessionGone extends Error {
  constructor() {
    super("session is no longer active");
  }
}

interface SafeEditArgs {
  chatId: number;
  messageId: number;
  text: string;
  keyboard?: ReturnType<typeof renderSessionKeyboard> | null;
  gameOnKeyboard?: ReturnType<typeof renderGameOnKeyboard> | null;
  clearKeyboard?: boolean;
  suppressKeyboard?: boolean;
}

/**
 * Wraps editMessageText. Telegram throws when the new text+markup is identical
 * to the old — we swallow that, since "no-op edit" is fine for our caller.
 * We also swallow "message not found" (chat history wiped) so reconciliation
 * isn't permanently broken.
 */
async function safeEditMessage(args: SafeEditArgs): Promise<void> {
  const sendOnce = () =>
    bot.api.editMessageText(args.chatId, args.messageId, args.text, {
      parse_mode: "HTML",
      reply_markup:
        args.suppressKeyboard || args.clearKeyboard
          ? undefined
          : (args.keyboard ?? args.gameOnKeyboard ?? undefined),
      link_preview_options: { is_disabled: true },
    });
  try {
    await sendOnce();
    if (args.clearKeyboard) {
      try {
        await bot.api.editMessageReplyMarkup(args.chatId, args.messageId, {
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.description?.includes("message is not modified")) return;
      if (err.description?.includes("message to edit not found")) {
        log.warn(`Edit target ${args.chatId}:${args.messageId} no longer exists.`);
        return;
      }
      if (err.error_code === 429) {
        const retryAfter =
          (err.parameters as { retry_after?: number } | undefined)?.retry_after ?? 5;
        const waitMs = (retryAfter + 1) * 1000;
        log.warn(`Rate limited; sleeping ${waitMs}ms before one retry.`);
        await sleep(waitMs);
        try {
          await sendOnce();
          return;
        } catch (err2) {
          if (err2 instanceof GrammyError && err2.description?.includes("message is not modified")) {
            return;
          }
          log.error("safeEditMessage retry failed", err2);
          return;
        }
      }
    }
    log.error("safeEditMessage failed", err);
  }
}

