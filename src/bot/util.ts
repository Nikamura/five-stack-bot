import type { Context } from "grammy";
import { GrammyError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { log } from "../log.js";

/**
 * The bot only operates in group / supergroup chats. The PRD scopes all
 * state per chat (group chat). Reject commands sent in private DMs.
 */
export function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

export function senderDisplayName(ctx: Context): string {
  const u = ctx.from;
  if (!u) return "someone";
  if (u.first_name && u.last_name) return `${u.first_name} ${u.last_name}`;
  if (u.first_name) return u.first_name;
  if (u.username) return u.username;
  return `user${u.id}`;
}

/** Strip the leading command word from message text, returning the rest. */
export function commandTail(text: string | undefined): string {
  if (!text) return "";
  const m = text.match(/^\/\S+\s*(.*)$/s);
  return (m?.[1] ?? "").trim();
}

/**
 * Best-effort delete the user's command message. Requires the bot to have
 * the "Delete messages" admin right; silently no-ops otherwise. Run it
 * fire-and-forget — it never blocks the command response.
 */
export function tryDeleteCommandMessage(ctx: Context): void {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (!chatId || !messageId) return;
  ctx.api.deleteMessage(chatId, messageId).catch((err: unknown) => {
    // 400 "message can't be deleted for everyone" / "not enough rights" —
    // the bot lacks admin rights. Silent.
    if (err instanceof GrammyError) return;
  });
}

/**
 * Public confirmation that auto-deletes after `ttlMs`. Used for shared-state
 * changes whose result is already visible elsewhere (the session message).
 */
export async function transientReply(
  ctx: Context,
  text: string,
  ttlMs: number = 8_000,
): Promise<void> {
  const sent = await ctx.reply(text, { parse_mode: "HTML" });
  setTimeout(() => {
    ctx.api
      .deleteMessage(sent.chat.id, sent.message_id)
      .catch(() => undefined);
  }, ttlMs).unref?.();
}

// ----------------------------------------------------------------------------
// Ephemeral messages (Bot API 10.2+): group messages only one member can see.
// ----------------------------------------------------------------------------

export interface PrivateReplyOptions {
  parse_mode?: "HTML";
  reply_markup?: InlineKeyboardMarkup;
}

/**
 * Try to send `text` so only the requesting group member sees it. Telegram
 * accepts this within 15 seconds of a callback query or an ephemeral command,
 * or at any time when the bot is a chat administrator. Returns false when
 * Telegram refuses, so callers can fall back to their public behaviour.
 */
async function sendEphemeral(
  ctx: Context,
  text: string,
  other: PrivateReplyOptions = {},
): Promise<boolean> {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return false;
  const callbackQueryId = ctx.callbackQuery?.id;
  // Only a user's own ephemeral command can be replied to; a callback's
  // message is the bot's, and is addressed through the callback query.
  const incomingId = callbackQueryId ? undefined : ctx.message?.ephemeral_message_id;
  try {
    await ctx.api.sendMessage(ctx.chat.id, text, {
      ...other,
      link_preview_options: { is_disabled: true },
      ephemeral_message_parameters: {
        receiver_user_id: ctx.from.id,
        ...(callbackQueryId ? { callback_query_id: callbackQueryId } : {}),
      },
      ...(incomingId ? { reply_parameters: { ephemeral_message_id: incomingId } } : {}),
    });
    return true;
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    log.debug(`Ephemeral send refused: ${error.description}`);
    return false;
  }
}

/**
 * Reply privately to the requesting member. Falls back to the previous public
 * reply (auto-deleting when `transient`) if an ephemeral message is refused
 * or the chat is not a group. Returns true when the reply was private.
 */
export async function privateReply(
  ctx: Context,
  text: string,
  other: PrivateReplyOptions = {},
  fallback: "reply" | "transient" = "reply",
): Promise<boolean> {
  if (await sendEphemeral(ctx, text, other)) {
    // The answer is private, so a visible command no longer needs to linger.
    if (ctx.message?.text?.startsWith("/")) tryDeleteCommandMessage(ctx);
    return true;
  }
  if (fallback === "transient") await transientReply(ctx, text);
  else await ctx.reply(text, other);
  return false;
}

/**
 * Answer a button press with text the member can keep reading. Falls back to
 * the callback toast (an alert when `alert`) if an ephemeral message is refused.
 */
export async function privateNotice(
  ctx: Context,
  text: string,
  alert: boolean = false,
): Promise<void> {
  if (await sendEphemeral(ctx, text)) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    return;
  }
  await ctx.answerCallbackQuery({ text: text.slice(0, 200), show_alert: alert });
}

// A picker is ephemeral when it was sent privately, and a regular message
// after a public fallback. Its buttons must edit whichever one it is.

function flowEphemeralId(ctx: Context): number | undefined {
  return ctx.callbackQuery ? ctx.msg?.ephemeral_message_id : undefined;
}

export async function editFlowMessage(
  ctx: Context,
  text: string,
  other: PrivateReplyOptions = {},
): Promise<void> {
  const id = flowEphemeralId(ctx);
  if (id !== undefined && ctx.chat && ctx.from) {
    await ctx.api.editEphemeralMessageText(ctx.chat.id, ctx.from.id, id, text, other);
  } else {
    await ctx.editMessageText(text, other);
  }
}

export async function editFlowMarkup(
  ctx: Context,
  reply_markup: InlineKeyboardMarkup,
): Promise<void> {
  const id = flowEphemeralId(ctx);
  if (id !== undefined && ctx.chat && ctx.from) {
    await ctx.api.editEphemeralMessageReplyMarkup(ctx.chat.id, ctx.from.id, id, { reply_markup });
  } else {
    await ctx.editMessageReplyMarkup({ reply_markup });
  }
}

export async function deleteFlowMessage(ctx: Context): Promise<void> {
  const id = flowEphemeralId(ctx);
  if (id !== undefined && ctx.chat && ctx.from) {
    await ctx.api.deleteEphemeralMessage(ctx.chat.id, ctx.from.id, id);
  } else {
    await ctx.deleteMessage();
  }
}

/**
 * End a picker. A private picker is removed, and a result the group should
 * see is posted publicly (`announce`). A public picker is edited in place.
 */
export async function finishFlow(
  ctx: Context,
  text: string,
  announce: "none" | "post" | "transient" = "none",
): Promise<void> {
  if (flowEphemeralId(ctx) === undefined) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
    return;
  }
  await deleteFlowMessage(ctx).catch(() => undefined);
  if (announce === "post") await ctx.reply(text, { parse_mode: "HTML" });
  else if (announce === "transient") await transientReply(ctx, text);
}
