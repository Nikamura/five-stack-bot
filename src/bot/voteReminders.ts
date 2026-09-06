import { GrammyError } from "grammy";
import { bot } from "./instance.js";
import { withMutex } from "./mutex.js";
import * as q from "../db/queries.js";
import type { SessionRow } from "../db/types.js";
import { evaluateLock, tallySlots, unvotedRosterMembers } from "../core/lock.js";
import { buildSlots } from "../core/slots.js";
import { slotInstantMs } from "../core/time.js";
import { mentionByIds } from "../core/mention.js";
import { renderVoteReminder, renderVoteReminderKeyboard } from "../core/render.js";
import { log } from "../log.js";
import { getSessionMiniAppLink } from "./session.js";

export const VOTE_REMINDER_INTERVAL_MS = 15 * 60 * 1000;

function reminderContent(session: SessionRow) {
  if (session.archived_at !== null || session.archive_at <= Date.now() || !session.poll_message_id) return null;
  const chat = q.getOrCreateChat(session.chat_id);
  const currentLock = q.getLock(session.id);
  if (currentLock && slotInstantMs({ slotMinutes: currentLock.slot_minutes, tz: chat.tz, nowMs: session.opened_at }) <= Date.now()) return null;
  const roster = q.getRoster(session.chat_id);
  const rosterIds = new Set(roster.map(member => member.telegram_user_id));
  const votes = q.getSessionVotes(session.id);
  const skipIds = q.getSkips(session.id);
  const targets = unvotedRosterMembers({ votes, rosterIds, skipIds });
  if (targets.length === 0) return null;
  const validStacks = q.parseStacks(chat.valid_stacks);
  // Evaluate current votes rather than a possibly stale debounced lock.
  const lock = evaluateLock({
    tallies: tallySlots({ slots: buildSlots(session.start_minutes, session.end_minutes).filter(slot => slotInstantMs({ slotMinutes: slot, tz: chat.tz, nowMs: session.opened_at }) > Date.now()), votes, rosterIds, skipIds, fillerIds: q.getFillers(session.id) }),
    validStacks,
  });
  if (lock.size !== null && lock.size >= Math.max(...validStacks)) return null;
  if (lock.slot !== null && slotInstantMs({ slotMinutes: lock.slot, tz: chat.tz, nowMs: session.opened_at }) <= Date.now()) return null;
  return {
    text: renderVoteReminder(mentionByIds(roster, targets)),
    keyboard: renderVoteReminderKeyboard(session.id, getSessionMiniAppLink(session.id)),
  };
}

function telegramErrorIncludes(error: unknown, text: string): boolean {
  return error instanceof GrammyError && error.description.includes(text);
}

/** Caller holds the session mutex. Retain the ID if cleanup fails, for retry. */
export async function removeVoteReminderLocked(session: SessionRow): Promise<void> {
  const messageId = q.getVoteReminder(session.id)?.message_id;
  if (messageId == null) return;
  try {
    await bot.api.deleteMessage(session.chat_id, messageId);
  } catch (error) {
    if (!telegramErrorIncludes(error, "message to delete not found")) {
      // If deletion is unavailable, retire the old CTA before sending another.
      try {
        await bot.api.editMessageText(session.chat_id, messageId, "Voting reminder closed.", {
          reply_markup: { inline_keyboard: [] },
        });
      } catch (editError) {
        if (!telegramErrorIncludes(editError, "message is not modified") &&
            !telegramErrorIncludes(editError, "message to edit not found")) throw editError;
      }
    }
  }
  q.clearVoteReminderMessage(session.id);
}

/** Refresh silently after votes/roster changes or poll bumps; never re-notify. */
export async function syncVoteReminderLocked(session: SessionRow): Promise<void> {
  const messageId = q.getVoteReminder(session.id)?.message_id;
  if (messageId == null) return;
  try {
    const content = reminderContent(session);
    if (!content) {
      await removeVoteReminderLocked(session);
      return;
    }
    await bot.api.editMessageText(session.chat_id, messageId, content.text, {
      parse_mode: "HTML",
      reply_markup: content.keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    if (telegramErrorIncludes(error, "message is not modified")) return;
    if (telegramErrorIncludes(error, "message to edit not found")) {
      q.clearVoteReminderMessage(session.id);
      return;
    }
    // A failed CTA refresh must not block voting, locking or archiving.
    log.warn(`Could not refresh voting reminder for session ${session.id}`, error);
  }
}

/** Button-triggered reminders share the same persisted cooldown. */
export async function sendVoteReminder(sessionId: number, chatId?: number): Promise<string> {
  return withMutex(`session:${sessionId}`, async () => {
    return sendVoteReminderLocked(sessionId, chatId);
  });
}

/** Caller has authorized the user and holds the session mutex. */
export async function sendVoteReminderLocked(sessionId: number, chatId?: number): Promise<string> {
    const session = q.getSession(sessionId);
    if (!session || (chatId !== undefined && session.chat_id !== chatId)) return "That session is no longer active.";
    const content = reminderContent(session);
    if (!content) {
      await removeVoteReminderLocked(session);
      return "No voting reminder needed.";
    }
    const previous = q.getVoteReminder(sessionId);
    const remaining = previous ? previous.last_sent_at + VOTE_REMINDER_INTERVAL_MS - Date.now() : 0;
    if (remaining > 0) return `Please wait ${Math.ceil(remaining / 60_000)} min before reminding again.`;

    // Delete first: simultaneous taps cannot leave two active CTAs behind.
    await removeVoteReminderLocked(session);
    const sent = await bot.api.sendMessage(session.chat_id, content.text, {
      parse_mode: "HTML",
      reply_markup: content.keyboard,
      reply_parameters: { message_id: session.poll_message_id!, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true },
    });
    q.setVoteReminder(sessionId, sent.message_id, Date.now());
    return "Reminded players who haven't voted.";
}

/** Reconcile persisted CTAs on boot, including sessions archived while offline. */
export async function refreshVoteReminders(): Promise<void> {
  for (const sessionId of q.listVoteReminderSessionIds()) {
    await withMutex(`session:${sessionId}`, async () => {
      const session = q.getSession(sessionId);
      if (session) await syncVoteReminderLocked(session);
    });
  }
}
