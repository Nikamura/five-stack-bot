import { bot } from "./instance.js";
import { isGroup, senderDisplayName } from "./util.js";
import * as q from "../db/queries.js";
import * as session from "./session.js";
import {
  cancelDoneText,
  rosterAddPromptText,
  rosterDoneText,
  rosterRemoveConfirmKeyboard,
  rosterRemoveConfirmText,
  stacksKeyboard,
  stacksSavedText,
  tzOtherPromptText,
  tzSavedText,
  wizardCancelledText,
  wizardOpenedText,
  wizardStep1Keyboard,
  wizardStep1Text,
  wizardStep2Keyboard,
  wizardStep2Text,
  wizardStep3Keyboard,
  wizardStep3Text,
} from "../core/render.js";
import { setPending } from "./wizardState.js";
import { COMMON_TZS } from "../core/time.js";
import { log } from "../log.js";
import { nextVote } from "../core/lock.js";

// ----------------------------------------------------------------------------
// Wizard
// ----------------------------------------------------------------------------

bot.callbackQuery(/^lfp:start:(\d+)$/, async (ctx) => {
  const startMinutes = Number(ctx.match[1]);
  ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(wizardStep2Text(startMinutes), {
    reply_markup: wizardStep2Keyboard(startMinutes),
  });
});

bot.callbackQuery(/^lfp:back:start$/, async (ctx) => {
  ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(wizardStep1Text(), { reply_markup: wizardStep1Keyboard() });
});

bot.callbackQuery(/^lfp:end:(\d+):(\d+)$/, async (ctx) => {
  const startMinutes = Number(ctx.match[1]);
  const endMinutes = Number(ctx.match[2]);
  if (!ctx.chat) return ctx.answerCallbackQuery();
  ctx.answerCallbackQuery().catch(() => {});
  const chat = q.getOrCreateChat(ctx.chat.id);
  const stacks = q.parseStacks(chat.valid_stacks);
  const rosterSize = q.getRoster(ctx.chat.id).length;
  await ctx.editMessageText(
    wizardStep3Text({ startMinutes, endMinutes, validStacks: stacks, rosterSize }),
    { reply_markup: wizardStep3Keyboard(startMinutes, endMinutes) },
  );
});

bot.callbackQuery(/^lfp:open:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.chat || !ctx.from) return ctx.answerCallbackQuery();
  const startMinutes = Number(ctx.match[1]);
  const endMinutes = Number(ctx.match[2]);
  ctx.answerCallbackQuery({ text: "Opening…" }).catch(() => {});
  try {
    await ctx.editMessageText(wizardOpenedText());
  } catch (e) {
    log.warn("could not edit wizard msg", e);
  }
  const result = await session.openSession({
    chatId: ctx.chat.id,
    openerUserId: ctx.from.id,
    openerUsername: ctx.from.username ?? null,
    openerDisplayName: senderDisplayName(ctx),
    startMinutes,
    endMinutes,
  });
  if (typeof result === "object") {
    await ctx.reply("A session is already active.");
  }
});

bot.callbackQuery(/^lfp:wcancel$/, async (ctx) => {
  ctx.answerCallbackQuery().catch(() => {});
  try {
    await ctx.editMessageText(wizardCancelledText());
  } catch {
    /* ignore */
  }
});

// ----------------------------------------------------------------------------
// Voting (slot tap, bulk no, cancel session)
// ----------------------------------------------------------------------------

bot.callbackQuery(/^v:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.from) return ctx.answerCallbackQuery();
  const sessionId = Number(ctx.match[1]);
  const slot = Number(ctx.match[2]);

  // Optimistic toast: predict the next vote value from the current persisted
  // state, then answer immediately so the button spinner clears and the next
  // tap registers without delay. Rapid retaps on the same user can race the
  // prediction (the toast may show "✅" while the actual persisted value lands
  // on "🤷"); the message-body edit is the source of truth and stays correct.
  const cur = q.getVote(sessionId, ctx.from.id, slot)?.value ?? null;
  const predicted = nextVote(cur);
  const rosterIds = ctx.chat ? q.getRosterIds(ctx.chat.id) : new Set<number>();
  const willCountForLock = rosterIds.has(ctx.from.id) || rosterIds.has(syntheticIdFor(ctx));
  ctx.answerCallbackQuery({ text: voteToast(slot, predicted, willCountForLock) }).catch(() => {
    /* the toast is best-effort */
  });

  bindSyntheticUsername(ctx);

  try {
    await session.recordVote({
      sessionId,
      userId: ctx.from.id,
      username: ctx.from.username ?? null,
      displayName: senderDisplayName(ctx),
      slot,
    });
  } catch (err) {
    log.warn("vote failed", err);
  }
});

bot.callbackQuery(/^v2:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.from) return ctx.answerCallbackQuery();
  const sessionId = Number(ctx.match[1]);
  const slot = Number(ctx.match[2]);

  // Optimistic toast — same shape as single-slot, but spans both halves.
  const cur = q.getVote(sessionId, ctx.from.id, slot)?.value ?? null;
  const predicted = nextVote(cur);
  const rosterIds = ctx.chat ? q.getRosterIds(ctx.chat.id) : new Set<number>();
  const willCountForLock = rosterIds.has(ctx.from.id) || rosterIds.has(syntheticIdFor(ctx));
  ctx.answerCallbackQuery({ text: comboVoteToast(slot, predicted, willCountForLock) }).catch(() => {
    /* best-effort */
  });

  bindSyntheticUsername(ctx);

  try {
    await session.recordComboVote({
      sessionId,
      userId: ctx.from.id,
      username: ctx.from.username ?? null,
      displayName: senderDisplayName(ctx),
      slot,
    });
  } catch (err) {
    log.warn("combo vote failed", err);
  }
});

bot.callbackQuery(/^vbn:(\d+)$/, async (ctx) => {
  if (!ctx.from) return ctx.answerCallbackQuery();
  const sessionId = Number(ctx.match[1]);
  ctx.answerCallbackQuery({ text: "All slots set to ❌." }).catch(() => {});
  bindSyntheticUsername(ctx);
  try {
    await session.bulkNoTonight({ sessionId, userId: ctx.from.id });
  } catch (err) {
    log.warn("bulk no failed", err);
  }
});

bot.callbackQuery(/^vbay:(\d+)$/, async (ctx) => {
  if (!ctx.from) return ctx.answerCallbackQuery();
  const sessionId = Number(ctx.match[1]);
  // Answer optimistically; the toggle decides the actual state inside the
  // mutex and we update the toast below if needed.
  ctx.answerCallbackQuery({ text: "All slots set to ✅." }).catch(() => {});
  bindSyntheticUsername(ctx);
  try {
    const result = await session.bulkYesToggleTonight({
      sessionId,
      userId: ctx.from.id,
    });
    if (result === "cleared") {
      // Best-effort follow-up toast — Telegram only honors one answer per
      // callback, so the user sees whichever shows first. Swallow errors.
      ctx
        .answerCallbackQuery({ text: "Cleared all your votes." })
        .catch(() => {});
    }
  } catch (err) {
    log.warn("bulk yes failed", err);
  }
});

bot.callbackQuery(/^vfill:(\d+)$/, async (ctx) => {
  if (!ctx.from) return ctx.answerCallbackQuery();
  const sessionId = Number(ctx.match[1]);
  bindSyntheticUsername(ctx);
  try {
    const state = await session.toggleFiller({
      sessionId,
      userId: ctx.from.id,
    });
    const text =
      state === "on"
        ? "🛟 Filler mode ON — you'll only play if the team is short."
        : "🛟 Filler mode OFF — your ✅ votes count normally again.";
    ctx.answerCallbackQuery({ text }).catch(() => {});
  } catch (err) {
    log.warn("toggle filler failed", err);
    ctx.answerCallbackQuery({ text: "Couldn't toggle filler." }).catch(() => {});
  }
});

function voteToast(slot: number, next: ReturnType<typeof nextVote>, isRoster: boolean): string {
  const slotStr = formatSlotMm(slot);
  let label: string;
  if (next === "yes") label = `${slotStr}: ✅`;
  else if (next === "maybe") label = `${slotStr}: 🤷`;
  else label = `${slotStr}: ❌`;
  if (!isRoster) label += " (spectator — doesn't affect lock)";
  return label;
}

function comboVoteToast(slot: number, next: ReturnType<typeof nextVote>, isRoster: boolean): string {
  const h = Math.floor(slot / 60);
  let label: string;
  if (next === "yes") label = `${h}-${h + 1}: ✅`;
  else if (next === "maybe") label = `${h}-${h + 1}: 🤷`;
  else label = `${h}-${h + 1}: ❌`;
  if (!isRoster) label += " (spectator — doesn't affect lock)";
  return label;
}

function syntheticIdFor(ctx: any): number {
  const handle = ctx.from?.username;
  if (!handle) return 0;
  return -hashString(String(handle).toLowerCase());
}

bot.callbackQuery(/^xs:(\d+)$/, async (ctx) => {
  const sessionId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  // Show confirm
  const s = q.getSession(sessionId);
  if (!s || s.archived_at !== null) {
    await ctx.reply("That session is no longer active.");
    return;
  }
  await ctx.reply("Cancel the active session?", {
    reply_markup: {
      inline_keyboard: [[
        { text: "🗑 Cancel session", callback_data: `xs!:${sessionId}` },
        { text: "Keep it", callback_data: "xs:keep" },
      ]],
    },
  });
});

bot.callbackQuery(/^xs:keep$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
});

bot.callbackQuery(/^xs!:(\d+)$/, async (ctx) => {
  const sessionId = Number(ctx.match[1]);
  ctx.answerCallbackQuery({ text: "Cancelling…" }).catch(() => {});
  await session.cancelSession(sessionId);
  try {
    await ctx.editMessageText(cancelDoneText(), { reply_markup: { inline_keyboard: [] } });
  } catch {
    /* ignore */
  }
});

// ----------------------------------------------------------------------------
// Lateness
// ----------------------------------------------------------------------------

const LATE_MINUTES = 15;

bot.callbackQuery(/^late:(\d+)$/, async (ctx) => {
  if (!ctx.from) return ctx.answerCallbackQuery();
  const sessionId = Number(ctx.match[1]);
  const s = q.getSession(sessionId);
  if (!s || s.archived_at !== null) {
    await ctx.answerCallbackQuery({ text: "No active game." });
    return;
  }
  const lock = q.getLock(sessionId);
  if (!lock) {
    await ctx.answerCallbackQuery({ text: "No locked party." });
    return;
  }
  const party = q.getLockParty(sessionId);
  const isCore = party.some(
    (p) => p.role === "core" && p.telegram_user_id === ctx.from!.id,
  );
  if (!isCore) {
    await ctx.answerCallbackQuery({ text: "Only locked players can flag late." });
    return;
  }
  const existing = q.getLockLateForUser(sessionId, ctx.from.id);
  if (existing && existing > 0) {
    q.clearLockLateForUser(sessionId, ctx.from.id);
    ctx.answerCallbackQuery({ text: "Lateness cleared." }).catch(() => {});
  } else {
    q.setLockLate(sessionId, ctx.from.id, LATE_MINUTES);
    ctx.answerCallbackQuery({ text: `Flagged ${LATE_MINUTES} min late.` }).catch(() => {});
  }
  try {
    await session.refreshGameOnMessage(sessionId);
  } catch (err) {
    log.warn("late refresh failed", err);
  }
});

// ----------------------------------------------------------------------------
// Roster
// ----------------------------------------------------------------------------

bot.callbackQuery(/^r:rm:(-?\d+)$/, async (ctx) => {
  if (!ctx.chat) return ctx.answerCallbackQuery();
  const userId = Number(ctx.match[1]);
  const m = q.getRosterMember(ctx.chat.id, userId);
  if (!m) {
    await ctx.answerCallbackQuery({ text: "Already removed." });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.reply(rosterRemoveConfirmText(m), {
    parse_mode: "HTML",
    reply_markup: rosterRemoveConfirmKeyboard(userId),
  });
});

bot.callbackQuery(/^r:rm!:(-?\d+)$/, async (ctx) => {
  if (!ctx.chat) return ctx.answerCallbackQuery();
  const userId = Number(ctx.match[1]);
  ctx.answerCallbackQuery({ text: "Removed." }).catch(() => {});
  q.removeRosterMember(ctx.chat.id, userId);
  await session.refreshActiveSession(ctx.chat.id);
  try {
    await ctx.editMessageText("Removed.", { reply_markup: { inline_keyboard: [] } });
  } catch {
    /* ignore */
  }
});

bot.callbackQuery(/^r:cancel$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
});

bot.callbackQuery(/^r:add$/, async (ctx) => {
  if (!ctx.chat || !ctx.from) return ctx.answerCallbackQuery();
  setPending(ctx.chat.id, ctx.from.id, { kind: "roster_add" });
  await ctx.answerCallbackQuery();
  await ctx.reply(rosterAddPromptText(), { parse_mode: "HTML" });
});

bot.callbackQuery(/^r:done$/, async (ctx) => {
  if (!ctx.chat) return ctx.answerCallbackQuery();
  const roster = q.getRoster(ctx.chat.id);
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(rosterDoneText(roster), { reply_markup: { inline_keyboard: [] } });
  } catch {
    /* ignore */
  }
});

// ----------------------------------------------------------------------------
// Skip
// ----------------------------------------------------------------------------

bot.callbackQuery(/^skip:cancel$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
});

bot.callbackQuery(/^skip:(-?\d+)$/, async (ctx) => {
  if (!ctx.chat) return ctx.answerCallbackQuery();
  const userId = Number(ctx.match[1]);
  const s = q.getActiveSession(ctx.chat.id);
  if (!s) {
    await ctx.answerCallbackQuery({ text: "No active session." });
    return;
  }
  const m = q.getRosterMember(ctx.chat.id, userId);
  if (!m) {
    await ctx.answerCallbackQuery({ text: "Not in the roster." });
    return;
  }
  const label = m.username ? `@${m.username}` : m.display_name;
  ctx.answerCallbackQuery({ text: `Marked ${label} as no-show.` }).catch(() => {});
  await session.markSkip({ sessionId: s.id, userId });
  try {
    await ctx.editMessageText(`Marked ${label} as no-show for tonight.`, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    /* ignore */
  }
});

// ----------------------------------------------------------------------------
// Stacks
// ----------------------------------------------------------------------------

// Toggle state lives in the keyboard itself (re-rendered on each tap).
bot.callbackQuery(/^s:t:(\d+)$/, async (ctx) => {
  if (!ctx.chat) return ctx.answerCallbackQuery();
  const n = Number(ctx.match[1]);
  ctx.answerCallbackQuery().catch(() => {});
  const chat = q.getOrCreateChat(ctx.chat.id);
  const current = readStacksFromKeyboard(ctx) ?? q.parseStacks(chat.valid_stacks);
  const next = current.includes(n) ? current.filter((x) => x !== n) : [...current, n];
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: stacksKeyboard(next) });
  } catch {
    /* ignore */
  }
});

bot.callbackQuery(/^s:save$/, async (ctx) => {
  if (!ctx.chat) return ctx.answerCallbackQuery();
  ctx.answerCallbackQuery({ text: "Saved." }).catch(() => {});
  const current = readStacksFromKeyboard(ctx) ?? q.parseStacks(q.getOrCreateChat(ctx.chat.id).valid_stacks);
  const sorted = [...new Set(current)].sort((a, b) => b - a);
  q.setChatStacks(ctx.chat.id, sorted);
  await session.refreshActiveSession(ctx.chat.id);
  try {
    await ctx.editMessageText(stacksSavedText(sorted), { reply_markup: { inline_keyboard: [] } });
  } catch {
    /* ignore */
  }
});

bot.callbackQuery(/^s:x$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
});

function readStacksFromKeyboard(ctx: any): number[] | null {
  const msg = ctx.callbackQuery?.message;
  const kb = msg?.reply_markup?.inline_keyboard;
  if (!Array.isArray(kb)) return null;
  const out: number[] = [];
  for (const row of kb as any[][]) {
    for (const btn of row) {
      // Buttons are like "5  ✅" or "5  ❌"
      const m = String(btn.text ?? "").match(/^(\d+)\s+(✅|❌)$/);
      if (m && m[2] === "✅") out.push(Number(m[1]));
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Timezone
// ----------------------------------------------------------------------------

bot.callbackQuery(/^tz:set:(\d+)$/, async (ctx) => {
  if (!ctx.chat) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const tz = COMMON_TZS[idx];
  if (!tz) {
    await ctx.answerCallbackQuery({ text: "Unknown zone." });
    return;
  }
  q.setChatTz(ctx.chat.id, tz);
  await ctx.answerCallbackQuery({ text: `Set to ${tz}` });
  try {
    await ctx.editMessageText(tzSavedText(tz), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    /* ignore */
  }
});

bot.callbackQuery(/^tz:other$/, async (ctx) => {
  if (!ctx.chat || !ctx.from) return ctx.answerCallbackQuery();
  setPending(ctx.chat.id, ctx.from.id, { kind: "tz_other" });
  await ctx.answerCallbackQuery();
  await ctx.reply(tzOtherPromptText(), { parse_mode: "HTML" });
});

bot.callbackQuery(/^tz:x$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
});

// ----------------------------------------------------------------------------
// Catch-all
// ----------------------------------------------------------------------------

bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "🤷" });
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function formatSlotMm(slotMinutes: number): string {
  const h = Math.floor(slotMinutes / 60);
  const m = slotMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * If the roster has a synthetic-id entry for the user's @username,
 * replace it with the real Telegram user id so future operations
 * resolve correctly.
 */
function bindSyntheticUsername(ctx: any): void {
  if (!ctx.chat || !ctx.from || !ctx.from.username) return;
  const syntheticId = -hashString(String(ctx.from.username).toLowerCase());
  const synthetic = q.getRosterMember(ctx.chat.id, syntheticId);
  if (!synthetic) return;
  // Don't bind if the real id is already there with a different name.
  const real = q.getRosterMember(ctx.chat.id, ctx.from.id);
  q.removeRosterMember(ctx.chat.id, syntheticId);
  if (!real) {
    q.addRosterMember(
      ctx.chat.id,
      ctx.from.id,
      ctx.from.username,
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
        ctx.from.username ||
        `user${ctx.from.id}`,
    );
  }
  // Best-effort. We avoid recursing into refreshActiveSession here —
  // the caller's recordVote() already triggers re-evaluation immediately
  // after this binding completes, with the real id in the roster.
  void isGroup;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
    if (h === 0) h = 1;
  }
  return Math.abs(h);
}
