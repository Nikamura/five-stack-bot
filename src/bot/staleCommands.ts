import type { Context, NextFunction } from "grammy";
import { log } from "../log.js";

/**
 * Commands older than this are dropped instead of answered. Telegram clients
 * can deliver a queued (or re-sent ephemeral) command hours after it was
 * typed; answering it then posts a picker to the whole group in the night.
 */
export const STALE_COMMAND_SECONDS = 120;

interface CommandLike {
  date: number;
  text?: string;
  entities?: { type: string; offset: number }[];
}

/** True when `message` starts with a bot command sent more than `maxAge` seconds before `nowSeconds`. */
export function isStaleCommand(
  message: CommandLike | undefined,
  nowSeconds: number,
  maxAge: number = STALE_COMMAND_SECONDS,
): boolean {
  if (!message?.text) return false;
  const isCommand = message.entities?.some((e) => e.type === "bot_command" && e.offset === 0) ?? false;
  return isCommand && nowSeconds - message.date > maxAge;
}

export async function dropStaleCommands(ctx: Context, next: NextFunction): Promise<void> {
  const message = ctx.message;
  if (message && isStaleCommand(message, Math.floor(Date.now() / 1000))) {
    const age = Math.floor(Date.now() / 1000) - message.date;
    log.info(
      `Ignored stale command ${message.text?.split(/\s/, 1)[0]} from ${ctx.from?.id} in ${ctx.chat?.id}: ` +
        `sent ${new Date(message.date * 1000).toISOString()} (${age}s ago)` +
        (message.ephemeral_message_id ? `, ephemeral ${message.ephemeral_message_id}` : ""),
    );
    return;
  }
  // Record fresh group commands so a late delivery that slips through can be traced.
  if (message?.text?.startsWith("/") && ctx.chat?.type !== "private") {
    log.info(
      `Command ${message.text.split(/\s/, 1)[0]} from ${ctx.from?.id}: sent ${new Date(message.date * 1000).toISOString()}` +
        (message.ephemeral_message_id ? `, ephemeral ${message.ephemeral_message_id}` : ", public"),
    );
  }
  await next();
}
