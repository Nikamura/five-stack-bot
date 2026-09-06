import { postSearchEncouragement } from "./encouragement.js";
import { GrammyError } from "grammy";
import { bot } from "./instance.js";
import { withMutex } from "./mutex.js";
import * as q from "../db/queries.js";
import type { LockResult, SlotTally } from "../core/lock.js";
import {
  diffLock,
  buildPartyPlan,
  partyPlanKey,
  tallySlots,
  unvotedRosterMembers,
} from "../core/lock.js";
import { buildSlots } from "../core/slots.js";
import {
  renderGameOn,
  renderPartyWindows,
  renderGameOnKeyboard,
  renderLoadUp,
  renderMaybeNudge,
  renderPartyChanged,
  renderPartyDelayed,
  renderPartyDissolved,
  renderSessionBody,
  renderSessionKeyboard,
  renderT15,
} from "../core/render.js";
import { mentionByIds, mentionByIdsWithLate } from "../core/mention.js";
import { computeArchiveAt, slotInstantMs } from "../core/time.js";
import { log } from "../log.js";
import { scheduleArchive, syncPartyTimers, cancelT15 } from "../scheduler/jobs.js";
import { syncVoteReminderLocked, refreshVoteReminders } from "./voteReminders.js";
import type { RosterMember, SessionRow } from "../db/types.js";
import { config } from "../config.js";
import { createMiniAppLink } from "../web/auth.js";

export function getSessionMiniAppLink(sessionId: number): string | null {
  if (!config.miniAppUrl) return null;
  return createMiniAppLink({
    botUsername: bot.botInfo.username,
    sessionId,
    botToken: config.botToken,
    shortName: config.miniAppShortName,
  });
}

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
  // /lfp is one of the players. They still need to submit availability.
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

  // Opening a session proposes the window. The organizer submits their own
  // availability through the same explicit Save flow as everyone else.

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

  void postSearchEncouragement(sessionId).catch(err => log.warn("encouragement skipped", err));

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
    void flushPollEdit(sessionId).catch((error) => log.warn("Poll refresh failed", error));
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

// ----------------------------------------------------------------------------
// Debounced lock evaluation. Several players can submit or decline together;
// coalesce their committed answers into one party decision and notification.
// ----------------------------------------------------------------------------

const EVAL_DEBOUNCE_MS = 1500;
const pendingEvalTimers = new Map<number, NodeJS.Timeout>();

function scheduleEvaluation(sessionId: number): void {
  const existing = pendingEvalTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingEvalTimers.delete(sessionId);
    void flushEvaluation(sessionId).catch((error) => log.warn("Party evaluation failed", error));
  }, EVAL_DEBOUNCE_MS);
  t.unref?.();
  pendingEvalTimers.set(sessionId, t);
}

/** Called once after an atomic Mini App save; notifications stay off the HTTP path. */
export function queueSessionEvaluation(sessionId: number): void {
  scheduleEvaluation(sessionId);
}

function cancelPendingEvaluation(sessionId: number): void {
  const t = pendingEvalTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    pendingEvalTimers.delete(sessionId);
  }
}

async function flushEvaluation(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null || session.archive_at <= Date.now()) return;
    await evaluateAndApply(session);
  });
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

export async function markSkip(args: {
  sessionId: number;
  userId: number;
}): Promise<void> {
  await withMutex(`session:${args.sessionId}`, async () => {
    const session = q.getSession(args.sessionId);
    if (!session || session.archived_at !== null) throw new SessionGone();
    q.addSkip(args.sessionId, args.userId);
    reconcilePartyPlanLocked(session, Date.now());
    scheduleEvaluation(args.sessionId);
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
    const fresh = q.getSession(session.id);
    if (!fresh || fresh.archived_at !== null || fresh.archive_at <= Date.now()) return;
    await evaluateAndApply(fresh);
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
    await syncVoteReminderLocked(q.getSession(fresh.id)!);
    return true;
  });
}

export async function cancelSession(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null) return;
    q.archiveSession(sessionId);
    cancelT15(sessionId);
    q.deleteJobsForSession(sessionId);
    cancelPendingPollEdit(sessionId);
    cancelPendingEvaluation(sessionId);
    await syncVoteReminderLocked(q.getSession(sessionId)!);
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
    cancelT15(sessionId);
    q.deleteJobsForSession(sessionId);
    cancelPendingPollEdit(sessionId);
    cancelPendingEvaluation(sessionId);
    await syncVoteReminderLocked(q.getSession(sessionId)!);
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
    parties: q.getPartyPlan(session.id),
  });
  if (opts?.archivedSuffix) body += opts.archivedSuffix;
  // Both group actions resolve the session by ID; saves validate future times.
  const keyboard = renderSessionKeyboard({
    sessionId: session.id,
    miniAppUrl: getSessionMiniAppLink(session.id),
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

/** Persist accepted availability before it can cross a start boundary. Caller owns mutex.
 * Called inside the availability transaction; notifications remain debounced.
 */
export function reconcilePartyPlanLocked(session: SessionRow, now: number): import("../core/lock.js").PartyWindow[] {
  const chat = q.getOrCreateChat(session.chat_id);
  const tallies = tallySlots({ slots: buildSlots(session.start_minutes, session.end_minutes), votes: q.getSessionVotes(session.id),
    rosterIds: q.getRosterIds(session.chat_id), skipIds: q.getSkips(session.id), fillerIds: q.getFillers(session.id) });
  const cutoff = tallies.find(t => slotInstantMs({ slotMinutes:t.slot, tz:chat.tz, nowMs:session.opened_at }) > now)?.slot ?? session.end_minutes;
  const prev = currentLock(session.id);
  const history = q.hasPartyPlan(session.id) || prev?.slot == null ? q.getPartyPlan(session.id) : [{
    ...prev, slot:prev.slot, endSlot:prev.slot+30, size:prev.size!, maybeIds:[], fillerIds:[],
  }];
  const plan = buildPartyPlan({ tallies, validStacks:q.parseStacks(chat.valid_stacks), firstFutureSlot:cutoff, previous:history });
  q.savePartyPlan(session.id,plan);
  return plan;
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
  const futureTallies = tallies.filter((t) => slotInstantMs({
    slotMinutes: t.slot, tz: chat.tz, nowMs: session.opened_at,
  }) > Date.now());
  const prev = currentLock(session.id);
  const previousPlan = q.getNotifiedPartyPlan(session.id);
  const plan = reconcilePartyPlanLocked(session, Date.now());
  const first = plan[0];
  const next: LockResult = first ? { slot: first.slot, size: first.size, core: first.core, alternates: first.alternates }
    : { slot: null, size: null, core: [], alternates: [] };
  const planChanged = partyPlanKey(previousPlan) !== partyPlanKey(plan);
  const diff = diffLock(prev, next);
  const availableAtSlot =
    next.slot !== null ? availableAtSlotFromTallies(tallies, next.slot) : 0;
  const started = next.slot !== null && !futureTallies.some(t => t.slot === next.slot);
  const unvotedIds = started ? [] : unvotedRosterMembers({ votes, rosterIds, skipIds });
  const upgradeTarget = upgradeStackAbove(next.size, validStacks);

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
  await syncVoteReminderLocked(session);

  // Timers persist before Telegram sends, including immediate reminder attempts.
  await syncPartyReminders(session, plan);

  // Side effects per diff.
  if (diff.kind === "new") {
    await postGameOn({
      session,
      lock: next,
      roster,
      availableAtSlot,
      unvotedIds,
      upgradeTarget,
    });
    await postMaybeNudge({
      session,
      lock: next,
      roster,
      tallies,
      previouslyNudged: new Set(),
    });

  } else if (diff.kind === "changed") {
    await editGameOn({
      session,
      lock: next,
      roster,
      availableAtSlot,
      unvotedIds,
      upgradeTarget,
    });
    await postChangedFollowup({ session, prev: diff.prev, next, roster });
    await postMaybeNudge({
      session,
      lock: next,
      roster,
      tallies,
      previouslyNudged: new Set(diff.prev.core),
    });


  } else if (diff.kind === "alternates-changed") {
    // Core lineup unchanged — refresh GAME ON in place so the alternates
    // list and the "X players available" suggestion stay current, but
    // skip the `🔄 Party changed` follow-up and the T-15 reschedule
    // since the playing party hasn't moved.
    await editGameOn({
      session,
      lock: next,
      roster,
      availableAtSlot,
      unvotedIds,
      upgradeTarget,
    });
  } else if (diff.kind === "dissolved") {
    await editGameOnDissolved({ session });

  } else if (next.slot !== null) {
    // A saved No can remove an upgrade nudge without changing the party.
    // Refresh silently; unchanged locks keep their reminder and emit no post.
    await editGameOn({ session, lock: next, roster, availableAtSlot, unvotedIds, upgradeTarget });
  }
  if (planChanged && previousPlan.length && (diff.kind === "unchanged" || diff.kind === "alternates-changed")) {
    const upcoming = plan.filter(p => slotInstantMs({ slotMinutes: p.endSlot - 30, tz: chat.tz, nowMs: session.opened_at }) > Date.now());
    const text = upcoming.length ? renderPartyWindows(upcoming, roster).join("\n") : "No later parties currently have enough saved availability.";
    await bot.api.sendMessage(session.chat_id, `📅 <b>Party plan updated</b>\n${text}`, { parse_mode: "HTML" });
  }
  const maybePrompts: string[] = [];
  for (const party of plan.slice(1)) {
    if (slotInstantMs({ slotMinutes:party.slot,tz:chat.tz,nowMs:session.opened_at }) <= Date.now()) continue;
    const previous = previousPlan.find(p => p.slot <= party.slot && p.endSlot > party.slot);
    const newlySeated = party.maybeIds.filter(id => !previous?.maybeIds.includes(id));
    if (newlySeated.length) maybePrompts.push(`🤷 ${mentionByIds(roster,newlySeated)} — for the ${formatSlotMm(party.slot)} party, open your availability and Save Yes to confirm.`);
  }
  if (maybePrompts.length) await bot.api.sendMessage(session.chat_id,maybePrompts.join("\n"),{parse_mode:"HTML"});
  q.saveNotifiedPartyPlan(session.id, plan);
}

/**
 * Next-larger enabled stack above `currentSize`, or null if none. Used to
 * decide whether to tag unvoted players in GAME ON — there's no point
 * nudging if the lock is already at the chat's biggest enabled stack.
 */
function upgradeStackAbove(
  currentSize: number | null,
  validStacks: number[],
): number | null {
  if (currentSize === null) return null;
  const larger = validStacks.filter((s) => s > currentSize);
  if (larger.length === 0) return null;
  return Math.min(...larger);
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
  unvotedIds: number[];
  upgradeTarget: number | null;
}): Promise<void> {
  const lateByUserId = q.getLockLate(args.session.id);
  const text = renderGameOn({
    slot: args.lock.slot!,
    size: args.lock.size!,
    coreIds: args.lock.core,
    alternateIds: args.lock.alternates,
    roster: args.roster,
    lateByUserId,
    parties: q.getPartyPlan(args.session.id),
    availableAtSlot: args.availableAtSlot,
    unvotedIds: args.unvotedIds,
    upgradeTarget: args.upgradeTarget,
  });
  const sent = await bot.api.sendMessage(args.session.chat_id, text, {
    parse_mode: "HTML",
    reply_markup: renderGameOnKeyboard(args.session.id),
    link_preview_options: { is_disabled: true },
  });
  q.setSessionGameOnMessage(args.session.id, sent.message_id);
}

/**
 * Tag any core member whose vote at the locked slot is 🤷, asking them to
 * confirm with ✅. Fires alongside GAME ON on a "new" lock; on "changed"
 * only nudges newly-promoted maybes so previously-confirmed players aren't
 * pinged again.
 */
async function postMaybeNudge(args: {
  session: SessionRow;
  lock: LockResult;
  roster: RosterMember[];
  tallies: SlotTally[];
  previouslyNudged: Set<number>;
}): Promise<void> {
  const slotTally = args.tallies.find((t) => t.slot === args.lock.slot);
  if (!slotTally) return;
  const maybeAtSlot = new Set(slotTally.maybeUserIds);
  const targets = args.lock.core.filter(
    (id) => maybeAtSlot.has(id) && !args.previouslyNudged.has(id),
  );
  if (targets.length === 0) return;
  const mentions = mentionByIds(args.roster, targets);
  await bot.api.sendMessage(args.session.chat_id, renderMaybeNudge(mentions), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function editGameOn(args: {
  session: SessionRow;
  lock: LockResult;
  roster: RosterMember[];
  availableAtSlot: number;
  unvotedIds: number[];
  upgradeTarget: number | null;
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
    parties: q.getPartyPlan(args.session.id),
    availableAtSlot: args.availableAtSlot,
    unvotedIds: args.unvotedIds,
    upgradeTarget: args.upgradeTarget,
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
  await refreshVoteReminders();
  const sessions = q.listActiveSessions();
  log.info(`Refreshing ${sessions.length} active session message(s) on boot.`);
  for (const session of sessions) {
    try {
      if (session.archive_at <= Date.now()) {
        // Overdue scheduler jobs may have been dropped during rehydration.
        // Close these sessions so /lfp can create today's poll after downtime.
        await archiveSessionFromScheduler(session.id);
        continue;
      }
      await refreshActiveSession(session.chat_id);
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
    const chat = q.getOrCreateChat(session.chat_id);
    const validStacks = q.parseStacks(chat.valid_stacks);
    const started = slotInstantMs({ slotMinutes:lock.slot,tz:chat.tz,nowMs:session.opened_at }) <= Date.now();
    const unvotedIds = started ? [] : unvotedRosterMembers({ votes, rosterIds, skipIds });
    const upgradeTarget = upgradeStackAbove(lock.size, validStacks);
    const text = renderGameOn({
      slot: lock.slot,
      size: lock.size!,
      coreIds: lock.core,
      alternateIds: lock.alternates,
      roster,
      lateByUserId,
      parties: q.getPartyPlan(sessionId),
      availableAtSlot,
      unvotedIds,
      upgradeTarget,
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

async function syncPartyReminders(session: SessionRow, plan: import("../core/lock.js").PartyWindow[]): Promise<void> {
  const tz = q.getOrCreateChat(session.chat_id).tz;
  const pending: { slot: number; fireAt: number }[] = [];
  const immediate: number[] = [];
  for (const party of plan) {
    const startsAt = slotInstantMs({ slotMinutes: party.slot, tz, nowMs: session.opened_at });
    if (startsAt <= Date.now() || q.partyReminderAttempted(session.id, party.slot)) continue;
    const fireAt = startsAt - 15 * 60_000;
    if (fireAt <= Date.now() + 5000) immediate.push(party.slot);
    else pending.push({ slot: party.slot, fireAt });
  }
  syncPartyTimers(session.id, pending);
  for (const slot of immediate) {
    try { await firePartyT15Locked(session, slot); }
    catch (error) { log.warn(`Party reminder failed for ${session.id}:${slot}`, error); }
  }
}

async function firePartyT15Locked(session: SessionRow, slot: number): Promise<void> {
  if (session.archived_at !== null || session.archive_at <= Date.now()) return;
  const party = q.getPartyPlan(session.id).find(p => p.slot === slot);
  if (!party) return;
  const startsAt = slotInstantMs({ slotMinutes: slot, tz: q.getOrCreateChat(session.chat_id).tz, nowMs: session.opened_at });
  if (startsAt - 15 * 60_000 > Date.now() + 5000 || startsAt + 5 * 60_000 < Date.now() || !q.claimPartyReminder(session.id, slot)) return;
  if (q.getLock(session.id)?.slot_minutes === slot) await fireT15Now(session, party);
  else {
    const roster = q.getRoster(session.chat_id);
    const conditional = party.maybeIds.length || party.fillerIds.length ? " (includes maybe / if-needed players)" : "";
    await bot.api.sendMessage(session.chat_id,
      `⏰ ${formatSlotMm(slot)} — ${party.size}-stack${conditional}\n${mentionByIds(roster, party.core)}`, { parse_mode: "HTML" });
  }
}
export async function firePartyT15(sessionId: number, slot: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null) return;
    // Reconcile any recently saved answers before using the scheduled window.
    await evaluateAndApply(session);
    await firePartyT15Locked(q.getSession(sessionId)!, slot);
  });
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
    nowMs: session.opened_at,
  });
  const remainingMs = slotMs - Date.now();
  const roster = q.getRoster(session.chat_id);
  const lateByUserId = q.getLockLate(session.id);
  const core = mentionByIdsWithLate(roster, lock.core, lateByUserId);
  const text =
    remainingMs >= LOAD_UP_THRESHOLD_MS ? renderT15(core) : renderLoadUp(core);
  await bot.api.sendMessage(session.chat_id, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });

  const lateIds = lock.core.filter((id) => (lateByUserId.get(id) ?? 0) > 0);
  if (lateIds.length === 0) return;

  const readyCount = lock.core.length - lateIds.length;
  const hasEnabledStack = q
    .parseStacks(chat.valid_stacks)
    .some((size) => size <= readyCount);
  if (hasEnabledStack) return;

  const delayMinutes = Math.max(
    ...lateIds.map((id) => lateByUserId.get(id) ?? 0),
  );
  const lateMentions = mentionByIds(roster, lateIds);
  await bot.api.sendMessage(
    session.chat_id,
    renderPartyDelayed({ readyCount, lateMentions, delayMinutes }),
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  );
}

// Used by scheduler:
export async function fireT15(sessionId: number): Promise<void> {
  await withMutex(`session:${sessionId}`, async () => {
    const session = q.getSession(sessionId);
    if (!session || session.archived_at !== null) return;
    await evaluateAndApply(session);
    const lock = currentLock(sessionId);
    if (!lock || lock.slot === null) return;
    if (q.claimPartyReminder(sessionId, lock.slot)) await fireT15Now(session, lock);
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
