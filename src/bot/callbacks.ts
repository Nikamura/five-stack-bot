import { bot } from "./instance.js";
import { senderDisplayName } from "./util.js";
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
import { renderSessionKeyboard } from "../core/render.js";
import { declineAvailability } from "./availability.js";
import { ApiError } from "../web/contracts.js";

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

// Old messages are upgraded in place instead of applying a partial v1 vote.
bot.callbackQuery(/^(?:v|v2|vbay|vfill):(\d+)(?::\d+)?$/, async (ctx) => {
  const sessionId = Number(ctx.match[1]);
  const active = q.getSession(sessionId);
  if (!active || active.archived_at !== null || active.archive_at <= Date.now()) {
    await ctx.answerCallbackQuery({ text: "Voting has ended for this session." });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Voting moved to the availability picker. Open it below, then Save." });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: renderSessionKeyboard({
      sessionId, miniAppUrl: session.getSessionMiniAppLink(sessionId),
    }) });
  } catch (error) { log.warn("Could not upgrade an old voting keyboard", error); }
});

// This complete answer remains available directly in the group, including v1 No buttons.
bot.callbackQuery(/^vbn:(\d+)$/, async (ctx) => {
  try {
    await declineAvailability(Number(ctx.match[1]), ctx.from);
  } catch (error) {
    const text = error instanceof ApiError
      ? error.status === 403 ? "Only this group's roster can answer. Ask to be added with /lfp_add." : error.message
      : "Could not save your reply. Please try again.";
    if (!(error instanceof ApiError)) log.warn("Direct availability decline failed", error);
    await ctx.answerCallbackQuery({ text, show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Saved: you can't play at any remaining start time tonight." });
});

bot.callbackQuery(/^app:setup:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({
    text: "The availability app is not configured yet. Ask the bot owner to finish Mini App setup.",
    show_alert: true,
  });
});

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
