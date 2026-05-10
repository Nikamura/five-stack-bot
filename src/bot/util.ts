import type { Context } from "grammy";
import { GrammyError } from "grammy";

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
 * Send a confirmation reply that auto-deletes after `ttlMs`. Used for
 * actions whose result is already visible elsewhere (the session message).
 */
export async function ephemeralReply(
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
