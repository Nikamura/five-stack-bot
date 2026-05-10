import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { MessageEntity } from "grammy/types";
import { bot } from "./instance.js";
import {
  commandTail,
  ephemeralReply,
  isGroup,
  senderDisplayName,
  tryDeleteCommandMessage,
} from "./util.js";
import * as q from "../db/queries.js";
import { parseLfpArgs } from "../core/slots.js";
import * as session from "./session.js";
import {
  HELP_TEXT,
  cancelConfirmKeyboard,
  cancelConfirmText,
  existingSessionText,
  noActiveSessionText,
  notInGroupText,
  rosterAddPromptText,
  rosterEmptyOnLfpText,
  rosterHeaderText,
  rosterKeyboard,
  stacksKeyboard,
  stacksText,
  tzKeyboard,
  tzText,
  wizardStep1Keyboard,
  wizardStep1Text,
} from "../core/render.js";
import { setPending, takePending } from "./wizardState.js";
import { isValidIanaZone } from "../core/time.js";
import { escapeHtml } from "../core/mention.js";

interface AddedMember {
  telegram_user_id: number;
  username: string | null;
  display_name: string;
}

// ----------------------------------------------------------------------------
// /lfp
// ----------------------------------------------------------------------------

bot.command("lfp", async (ctx) => {
  if (!isGroup(ctx)) {
    await ctx.reply(notInGroupText());
    return;
  }
  if (!ctx.from || !ctx.chat) return;

  q.audit(ctx.chat.id, ctx.from.id, "/lfp", commandTail(ctx.message?.text));
  q.getOrCreateChat(ctx.chat.id);

  const existing = q.getActiveSession(ctx.chat.id);
  if (existing) {
    // Re-running /lfp on an active session bumps the poll to the bottom of
    // the chat instead of refusing. Old buttons stay functional, but body
    // edits target the fresh message.
    tryDeleteCommandMessage(ctx);
    await session.bumpSessionPoll(ctx.chat.id);
    return;
  }

  const arg = commandTail(ctx.message?.text);
  if (arg) {
    const parsed = parseLfpArgs(arg);
    if (!parsed.range) {
      await ctx.reply(
        "Couldn't parse a range. Try <code>/lfp 18-23</code>, " +
          "<code>/lfp 18-23 [5,3,2] @karolis @tomas</code>, " +
          "or <code>/lfp</code> for the picker.",
        { parse_mode: "HTML" },
      );
      return;
    }
    // Optional inline stacks override — persists for the chat.
    if (parsed.stacks) {
      q.setChatStacks(ctx.chat.id, parsed.stacks);
    }
    // Optional inline @tags — fold into the roster before the empty-roster check.
    const added = tryAddFromMessage(ctx);

    if (q.getRoster(ctx.chat.id).length === 0) {
      await ctx.reply(rosterEmptyOnLfpText(), { parse_mode: "HTML" });
      return;
    }
    if (added.length > 0) {
      await ctx.reply(addedReply(added), { parse_mode: "HTML" });
    }
    await openShortcut(ctx, parsed.range.startHour, parsed.range.endHour);
    return;
  }

  if (q.getRoster(ctx.chat.id).length === 0) {
    await ctx.reply(rosterEmptyOnLfpText(), { parse_mode: "HTML" });
    return;
  }
  await ctx.reply(wizardStep1Text(), { reply_markup: wizardStep1Keyboard() });
});

async function openShortcut(ctx: Context, startHour: number, endHour: number) {
  const result = await session.openSession({
    chatId: ctx.chat!.id,
    openerUserId: ctx.from!.id,
    openerUsername: ctx.from!.username ?? null,
    openerDisplayName: senderDisplayName(ctx),
    startHour,
    endHour,
  });
  if (typeof result === "object") {
    await ctx.reply(existingSessionText());
  }
}


// ----------------------------------------------------------------------------
// /lfp-cancel
// ----------------------------------------------------------------------------

bot.command(["lfp_bump", "lfpbump", "lfp_show", "lfpshow"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-bump");
  const moved = await session.bumpSessionPoll(ctx.chat.id);
  tryDeleteCommandMessage(ctx);
  if (!moved) await ephemeralReply(ctx, noActiveSessionText());
});

bot.command(["lfp_cancel", "lfpcancel"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-cancel");
  const s = q.getActiveSession(ctx.chat.id);
  if (!s) {
    await ctx.reply(noActiveSessionText());
    return;
  }
  tryDeleteCommandMessage(ctx);
  await ctx.reply(cancelConfirmText(), { reply_markup: cancelConfirmKeyboard(s.id) });
});

// ----------------------------------------------------------------------------
// /lfp-roster
// ----------------------------------------------------------------------------

bot.command(["lfp_roster", "lfproster"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-roster");
  q.getOrCreateChat(ctx.chat.id);
  const roster = q.getRoster(ctx.chat.id);
  await ctx.reply(rosterHeaderText(roster), {
    parse_mode: "HTML",
    reply_markup: rosterKeyboard(roster),
  });
});

// ----------------------------------------------------------------------------
// /lfp-add
// ----------------------------------------------------------------------------

bot.command(["lfp_add", "lfpadd"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-add", commandTail(ctx.message?.text));
  q.getOrCreateChat(ctx.chat.id);

  const added = tryAddFromMessage(ctx);
  if (added.length > 0) {
    await session.refreshActiveSession(ctx.chat.id);
    tryDeleteCommandMessage(ctx);
    await ephemeralReply(ctx, addedReply(added));
    return;
  }
  setPending(ctx.chat.id, ctx.from.id, { kind: "roster_add" });
  await ctx.reply(rosterAddPromptText(), { parse_mode: "HTML" });
});

function addedReply(added: AddedMember[]): string {
  return added
    .map(
      (m) => `Added ${m.username ? `@${m.username}` : escapeHtml(m.display_name)}.`,
    )
    .join("\n");
}

/** Pulls roster additions from the current message: reply target + entities. */
export function tryAddFromMessage(ctx: Context): AddedMember[] {
  const added: AddedMember[] = [];
  if (!ctx.chat || !ctx.message) return added;

  // Reply target
  const replied = ctx.message.reply_to_message;
  if (replied?.from && !replied.from.is_bot) {
    const u = replied.from;
    const displayName =
      [u.first_name, u.last_name].filter(Boolean).join(" ") ||
      u.username ||
      `user${u.id}`;
    q.addRosterMember(ctx.chat.id, u.id, u.username ?? null, displayName);
    added.push({ telegram_user_id: u.id, username: u.username ?? null, display_name: displayName });
  }

  const entities = ctx.message.entities ?? [];
  const text = ctx.message.text ?? "";
  for (const e of entities) {
    if (e.type === "text_mention") {
      const u = (e as MessageEntity.TextMentionMessageEntity).user;
      const displayName =
        [u.first_name, u.last_name].filter(Boolean).join(" ") ||
        u.username ||
        `user${u.id}`;
      q.addRosterMember(ctx.chat.id, u.id, u.username ?? null, displayName);
      added.push({ telegram_user_id: u.id, username: u.username ?? null, display_name: displayName });
    } else if (e.type === "mention") {
      // We only have an @handle. The Bot API doesn't expose username→user_id
      // resolution for arbitrary chats, so we store with a synthetic negative
      // id derived from the lowercase handle. The real id is bound the first
      // time this user votes (see callbacks.ts vote handler).
      const handle = text.slice(e.offset, e.offset + e.length).replace(/^@/, "");
      const syntheticId = -hashString(handle.toLowerCase());
      // If the same handle is already in the roster (with the real id),
      // don't shadow it with a synthetic.
      if (!q.findRosterByUsername(ctx.chat.id, handle)) {
        q.addRosterMember(ctx.chat.id, syntheticId, handle, handle);
        added.push({ telegram_user_id: syntheticId, username: handle, display_name: handle });
      }
    }
  }
  return added;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
    if (h === 0) h = 1;
  }
  return Math.abs(h);
}

// ----------------------------------------------------------------------------
// /lfp-remove
// ----------------------------------------------------------------------------

bot.command(["lfp_remove", "lfpremove"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-remove", commandTail(ctx.message?.text));
  q.getOrCreateChat(ctx.chat.id);

  const arg = commandTail(ctx.message?.text);
  if (arg) {
    const handle = arg.replace(/^@/, "").trim();
    const m = q.findRosterByUsername(ctx.chat.id, handle);
    if (!m) {
      await ctx.reply(`@${handle} is not in the roster.`);
      return;
    }
    q.removeRosterMember(ctx.chat.id, m.telegram_user_id);
    await session.refreshActiveSession(ctx.chat.id);
    tryDeleteCommandMessage(ctx);
    await ephemeralReply(ctx, `Removed @${handle}.`);
    return;
  }
  const roster = q.getRoster(ctx.chat.id);
  if (roster.length === 0) {
    await ctx.reply("Roster is empty.");
    return;
  }
  await ctx.reply(rosterHeaderText(roster), {
    parse_mode: "HTML",
    reply_markup: rosterKeyboard(roster),
  });
});

// ----------------------------------------------------------------------------
// /lfp-skip
// ----------------------------------------------------------------------------

bot.command(["lfp_skip", "lfpskip"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-skip", commandTail(ctx.message?.text));
  const s = q.getActiveSession(ctx.chat.id);
  if (!s) {
    await ctx.reply(noActiveSessionText());
    return;
  }
  const arg = commandTail(ctx.message?.text);
  if (!arg) {
    const roster = q.getRoster(ctx.chat.id);
    if (roster.length === 0) {
      await ctx.reply("Roster is empty.");
      return;
    }
    const kb = new InlineKeyboard();
    for (const m of roster) {
      const label = m.username ? `@${m.username}` : m.display_name;
      kb.text(label, `skip:${m.telegram_user_id}`).row();
    }
    kb.text("Cancel", "skip:cancel");
    await ctx.reply("Mark as no-show for tonight:", { reply_markup: kb });
    return;
  }
  const handle = arg.replace(/^@/, "").trim();
  const m = q.findRosterByUsername(ctx.chat.id, handle);
  if (!m) {
    await ctx.reply(`@${handle} is not in the roster.`);
    return;
  }
  await session.markSkip({ sessionId: s.id, userId: m.telegram_user_id });
  tryDeleteCommandMessage(ctx);
  await ephemeralReply(ctx, `Marked @${handle} as no-show for this session.`);
});

// ----------------------------------------------------------------------------
// /lfp-tz
// ----------------------------------------------------------------------------

bot.command(["lfp_tz", "lfptz"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-tz", commandTail(ctx.message?.text));
  const chat = q.getOrCreateChat(ctx.chat.id);
  const arg = commandTail(ctx.message?.text);
  if (arg) {
    if (!isValidIanaZone(arg)) {
      await ctx.reply(`'${escapeHtml(arg)}' isn't a valid IANA zone.`, { parse_mode: "HTML" });
      return;
    }
    q.setChatTz(ctx.chat.id, arg);
    tryDeleteCommandMessage(ctx);
    await ephemeralReply(ctx, `🌍 Timezone set to <code>${escapeHtml(arg)}</code>.`);
    return;
  }
  await ctx.reply(tzText(chat.tz), { parse_mode: "HTML", reply_markup: tzKeyboard() });
});

// ----------------------------------------------------------------------------
// /lfp-stacks
// ----------------------------------------------------------------------------

bot.command(["lfp_stacks", "lfpstacks"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-stacks");
  const chat = q.getOrCreateChat(ctx.chat.id);
  const current = q.parseStacks(chat.valid_stacks);
  await ctx.reply(stacksText(), { reply_markup: stacksKeyboard(current) });
});

// ----------------------------------------------------------------------------
// /lfp-stats
// ----------------------------------------------------------------------------

bot.command(["lfp_stats", "lfpstats"], async (ctx) => {
  if (!isGroup(ctx) || !ctx.chat || !ctx.from) return;
  q.audit(ctx.chat.id, ctx.from.id, "/lfp-stats");
  q.getOrCreateChat(ctx.chat.id);
  const now = Date.now();
  const d30 = q.statsSessionsSince(ctx.chat.id, now - 30 * 24 * 3600 * 1000);
  const d90 = q.statsSessionsSince(ctx.chat.id, now - 90 * 24 * 3600 * 1000);
  const join = q.statsJoinRate(ctx.chat.id, now - 90 * 24 * 3600 * 1000);
  const hour = q.statsMostCommonHour(ctx.chat.id, now - 90 * 24 * 3600 * 1000);
  const stack = q.statsMostCommonStack(ctx.chat.id, now - 90 * 24 * 3600 * 1000);

  const lines: string[] = [
    "<b>📊 Chat stats</b>",
    `Sessions — last 30d: ${d30}, last 90d: ${d90}`,
  ];
  if (hour !== null) lines.push(`Most common locked hour: ${String(hour).padStart(2, "0")}:00`);
  if (stack) {
    const label = stack.size === "no-lock" ? "no-lock" : `${stack.size}-stack`;
    lines.push(`Most common outcome: ${label} (×${stack.n})`);
  }
  if (join.length) {
    lines.push("", "<b>Join rate (last 90d)</b>");
    for (const j of join) {
      const pct = j.total > 0 ? Math.round((100 * j.joined) / j.total) : 0;
      lines.push(`  ${escapeHtml(j.display_name)}: ${pct}% (${j.joined}/${j.total})`);
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// ----------------------------------------------------------------------------
// /help
// ----------------------------------------------------------------------------

bot.command(["help", "lfp_help", "lfphelp", "start"], async (ctx) => {
  if (ctx.chat && ctx.from) q.audit(ctx.chat.id, ctx.from.id, "/help");
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
});

// ----------------------------------------------------------------------------
// Free-text follow-ups for setPending() flows
// ----------------------------------------------------------------------------

bot.on("message:text", async (ctx, next) => {
  if (!ctx.chat || !ctx.from) return next();
  if (ctx.message.text.startsWith("/")) return next();

  const pending = takePending(ctx.chat.id, ctx.from.id);
  if (!pending) return next();

  if (pending.kind === "roster_add") {
    const added = tryAddFromMessage(ctx);
    if (added.length === 0) {
      await ctx.reply(
        "Couldn't find a username or user mention. Try again with @username.",
      );
      return;
    }
    await session.refreshActiveSession(ctx.chat.id);
    await ephemeralReply(ctx, addedReply(added));
    return;
  }

  if (pending.kind === "tz_other") {
    const tz = ctx.message.text.trim();
    if (!isValidIanaZone(tz)) {
      await ctx.reply(`'${escapeHtml(tz)}' isn't a valid IANA zone.`, {
        parse_mode: "HTML",
      });
      setPending(ctx.chat.id, ctx.from.id, { kind: "tz_other" });
      return;
    }
    q.setChatTz(ctx.chat.id, tz);
    await ctx.reply(`🌍 Timezone set to <code>${escapeHtml(tz)}</code>.`, {
      parse_mode: "HTML",
    });
    return;
  }

  return next();
});
